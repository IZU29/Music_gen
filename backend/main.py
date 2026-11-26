import asyncio
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, Any

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import yt_dlp

app = FastAPI(title="YouTube Audio Pipeline")

# Reads comma-separated origins in production (e.g., "https://your-app.vercel.app")
raw_origins = os.getenv(
    "ALLOWED_ORIGINS", "http://localhost:5173,https://frontend-six-delta-37.vercel.app/"
)
allowed_origins = [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DOWNLOAD_DIR = Path("downloads")
DOWNLOAD_DIR.mkdir(exist_ok=True)

jobs: Dict[str, Dict[str, Any]] = {}



class ExtractRequest(BaseModel):
    url: str


def sanitize_filename(title: str) -> str:
    cleaned = re.sub(r'[\\/*?:"<>|]', "", title)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:120] or "extracted_audio"


def format_duration(seconds: int | float | None) -> str:
    if not seconds:
        return "00:00"
    seconds = int(seconds)
    mins, secs = divmod(seconds, 60)
    hours, mins = divmod(mins, 60)
    if hours > 0:
        return f"{hours:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"


def format_size(bytes_size: int) -> str:
    mb = bytes_size / (1024 * 1024)
    return f"{mb:.1f} MB"


def push_update(
    job_id: str,
    stage: str,
    progress: int,
    log: str,
    status: str = "processing",
    result: dict | None = None,
    error: str | None = None,
):
    job = jobs.get(job_id)
    if not job:
        return
    job["status"] = status
    job["stage"] = stage
    job["progress"] = progress
    if log:
        job["logs"].append(log)
        job["logs"] = job["logs"][-4:]
    if result:
        job["result"] = result
    if error:
        job["error"] = error
    job["updated_at"] = time.time()


def run_extraction_worker(job_id: str, url: str, base_url: str):
    output_template = str(DOWNLOAD_DIR / f"{job_id}.%(ext)s")

    def progress_hook(d: dict):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            pct = int((downloaded / total) * 65) + 15 if total > 0 else 35
            speed = d.get("_speed_str", "").strip()
            eta = d.get("_eta_str", "").strip()
            detail = f" ({speed}, ETA {eta})" if speed else ""
            push_update(
                job_id,
                stage="Downloading Audio Stream",
                progress=min(pct, 80),
                log=f"[yt-dlp] Fetching bestaudio stream{detail}...",
            )
        elif d["status"] == "finished":
            push_update(
                job_id,
                stage="Stream Downloaded",
                progress=82,
                log="[yt-dlp] Raw audio stream downloaded. Handing off to FFmpeg...",
            )

    def postprocessor_hook(d: dict):
        if d["status"] == "started":
            push_update(
                job_id,
                stage="Transcoding to MP3",
                progress=88,
                log="[ffmpeg] Converting audio to 192kbps MP3 & embedding metadata...",
            )
        elif d["status"] == "finished":
            push_update(
                job_id,
                stage="Finalizing File",
                progress=96,
                log="[worker] Audio conversion complete. Verifying output file...",
            )

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            },
            {"key": "FFmpegMetadata"},
        ],
        "extractor_args": {
    "youtube": {
        "player_client": ["android", "web", "tv"],
    }
},
    }

    try:
        push_update(
            job_id,
            stage="Resolving Metadata",
            progress=10,
            log="[yt-dlp] Connecting to YouTube & fetching video title...",
        )

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            raw_title = info.get("title", "Extracted Audio")
            clean_title = sanitize_filename(raw_title)
            duration_str = format_duration(info.get("duration"))

        final_file = DOWNLOAD_DIR / f"{job_id}.mp3"
        if not final_file.exists():
            raise FileNotFoundError("FFmpeg did not produce the expected MP3 file.")

        file_size_str = format_size(final_file.stat().st_size)
        download_filename = f"{clean_title}.mp3"

        result_payload = {
            "title": download_filename,
            "duration": duration_str,
            "size": file_size_str,
            "bitrate": "192 kbps MP3",
            "downloadUrl": f"{base_url}/api/download/{job_id}",
        }

        jobs[job_id]["file_path"] = str(final_file)
        jobs[job_id]["download_filename"] = download_filename

        push_update(
            job_id,
            stage="Complete",
            progress=100,
            log=f'[worker] Ready: "{download_filename}" ({file_size_str})',
            status="completed",
            result=result_payload,
        )

    except Exception as exc:
        push_update(
            job_id,
            stage="Failed",
            progress=0,
            log=f"[error] {str(exc)}",
            status="error",
            error=f"Extraction failed: {str(exc)}",
        )


def delete_file_safely(path: str):
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


@app.get("/")
async def health_check():
    return {"status": "ok", "service": "YouTube Audio Pipeline"}


@app.post("/api/extract")
async def start_extraction(req: ExtractRequest, request: Request):
    job_id = str(uuid.uuid4())
    # Automatically uses https://your-service.onrender.com in production
    forwarded_proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    base_url = f"{forwarded_proto}://{request.url.netloc}"

    jobs[job_id] = {
        "status": "processing",
        "stage": "Initializing Worker",
        "progress": 5,
        "logs": ["[worker] Spawned background extraction thread..."],
        "result": None,
        "error": None,
        "updated_at": time.time(),
    }

    thread = threading.Thread(
        target=run_extraction_worker,
        args=(job_id, req.url.strip(), base_url),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id}


@app.get("/api/stream/{job_id}")
async def stream_progress(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        last_sent = ""
        while True:
            job = jobs.get(job_id)
            if not job:
                break

            payload = json.dumps(
                {
                    "status": job["status"],
                    "stage": job["stage"],
                    "progress": job["progress"],
                    "logs": job["logs"],
                    "result": job["result"],
                    "error": job["error"],
                }
            )

            if payload != last_sent:
                yield f"data: {payload}\n\n"
                last_sent = payload

            if job["status"] in ("completed", "error"):
                break

            await asyncio.sleep(0.25)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/download/{job_id}")
async def download_audio(job_id: str, background_tasks: BackgroundTasks):
    job = jobs.get(job_id)
    if not job or job["status"] != "completed":
        raise HTTPException(status_code=404, detail="Audio file not ready or expired")

    file_path = job.get("file_path")
    filename = job.get("download_filename", "audio.mp3")

    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File no longer exists on server")

    background_tasks.add_task(delete_file_safely, file_path)

    return FileResponse(
        path=file_path,
        media_type="audio/mpeg",
        filename=filename,
    )