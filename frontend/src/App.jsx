import { useState, useEffect, useRef } from 'react';
import {
  ClipboardPaste,
  ArrowRight,
  Download,
  RotateCcw,
  Terminal,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Music,
  Clock,
  HardDrive,
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

export default function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'processing' | 'completed' | 'error'
  const [progress, setProgress] = useState(0);
  const [currentStage, setCurrentStage] = useState('');
  const [logs, setLogs] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState(null);

  const timerRef = useRef(null);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    if (status === 'processing') {
      const start = Date.now();
      timerRef.current = setInterval(() => {
        setElapsed(((Date.now() - start) / 1000).toFixed(1));
      }, 100);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  // Cleanup active SSE stream on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      // Clipboard access denied
    }
  };

  const isValidYouTubeUrl = (input) => {
    return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/.test(
      input.trim()
    );
  };

  const handleExtract = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;

    if (!isValidYouTubeUrl(url)) {
      setStatus('error');
      setErrorMsg('Please enter a valid YouTube video or Shorts URL.');
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setStatus('processing');
    setProgress(5);
    setCurrentStage('Connecting to Python Worker');
    setLogs(['[frontend] Sending job request to FastAPI backend...']);
    setElapsed(0);
    setErrorMsg('');
    setResult(null);

    try {
      const response = await fetch(`${API_BASE}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!response.ok) {
        throw new Error('Failed to start extraction job on Python server.');
      }

      const { job_id } = await response.json();

      // Open live SSE stream for real-time Python script insights
      const es = new EventSource(`${API_BASE}/stream/${job_id}`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        setProgress(data.progress);
        setCurrentStage(data.stage);
        setLogs(data.logs || []);

        if (data.status === 'completed') {
          setResult(data.result);
          setStatus('completed');
          es.close();
        } else if (data.status === 'error') {
          setErrorMsg(data.error || 'An error occurred during extraction.');
          setStatus('error');
          es.close();
        }
      };

      es.onerror = () => {
        setErrorMsg('Lost connection to the Python script stream.');
        setStatus('error');
        es.close();
      };
    } catch (err) {
      setStatus('error');
      setErrorMsg(
        err.message || 'Could not reach Python backend on http://localhost:8000'
      );
    }
  };

  const handleReset = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setUrl('');
    setStatus('idle');
    setProgress(0);
    setLogs([]);
    setResult(null);
    setErrorMsg('');
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center px-4 selection:bg-emerald-500/30">
      {/* Subtle Ambient Glow */}
      <div className="pointer-events-none fixed inset-0 flex items-center justify-center">
        <div className="h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <main className="relative w-full max-w-xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-medium text-zinc-400 mb-4">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Python Audio Pipeline
          </div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white">
            YouTube to Audio
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Paste any YouTube link to extract a clean MP3 with live script telemetry.
          </p>
        </div>

        {/* Main Card */}
        <div className="rounded-2xl bg-zinc-900/80 border border-zinc-800/90 p-5 sm:p-6 shadow-2xl backdrop-blur-md transition-all">
          {/* Input Form */}
          <form onSubmit={handleExtract} className="flex flex-col sm:flex-row gap-2.5">
            <div className="relative flex-1">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={status === 'processing'}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full rounded-xl bg-zinc-950 border border-zinc-800 pl-4 pr-11 py-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15 transition disabled:opacity-50"
              />
              {status !== 'processing' && (
                <button
                  type="button"
                  onClick={handlePaste}
                  title="Paste from clipboard"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 transition cursor-pointer"
                >
                  <ClipboardPaste className="w-4 h-4" />
                </button>
              )}
            </div>

            <button
              type="submit"
              disabled={!url.trim() || status === 'processing'}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 font-medium text-sm px-5 py-3 transition cursor-pointer disabled:cursor-not-allowed shrink-0"
            >
              {status === 'processing' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Running
                </>
              ) : (
                <>
                  Extract
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Live Python Script Insight Drawer */}
          {(status === 'processing' || status === 'completed') && (
            <div className="mt-5 rounded-xl bg-zinc-950 border border-zinc-800/90 p-4 transition-all">
              <div className="flex items-center justify-between text-xs mb-2.5">
                <div className="flex items-center gap-2 text-zinc-300 font-medium">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{currentStage}</span>
                </div>
                <div className="flex items-center gap-3 font-mono text-zinc-500">
                  <span>{elapsed}s</span>
                  <span className="text-emerald-400 font-semibold">{progress}%</span>
                </div>
              </div>

              <div className="h-1.5 w-full rounded-full bg-zinc-900 overflow-hidden">
                <div
                  className="h-full bg-emerald-400 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>

              <div className="mt-3 space-y-1 font-mono text-[11px] leading-relaxed text-zinc-400">
                {logs.map((line, index) => (
                  <div
                    key={index}
                    className={`truncate ${
                      index === logs.length - 1 ? 'text-zinc-200' : 'text-zinc-500'
                    }`}
                  >
                    <span className="text-emerald-500/70 mr-1.5">&gt;</span>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error State */}
          {status === 'error' && (
            <div className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-red-950/30 border border-red-900/50 px-4 py-3 text-xs text-red-300">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              <button
                onClick={handleReset}
                className="text-red-300 hover:text-white underline underline-offset-2 shrink-0 cursor-pointer"
              >
                Reset
              </button>
            </div>
          )}

          {/* Completed Audio Card */}
          {status === 'completed' && result && (
            <div className="mt-4 rounded-xl bg-zinc-950/90 border border-emerald-500/30 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
                  <Music className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <p
                      title={result.title}
                      className="text-sm font-medium text-white truncate"
                    >
                      {result.title}
                    </p>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {result.duration}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <HardDrive className="w-3 h-3" />
                      {result.size}
                    </span>
                    <span className="text-zinc-500">{result.bitrate}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleReset}
                  title="Convert another link"
                  className="p-2.5 rounded-xl border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-900 transition cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <a
                  href={result.downloadUrl}
                  download={result.title}
                  className="inline-flex items-center gap-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-medium text-xs px-4 py-2.5 transition"
                >
                  <Download className="w-4 h-4" />
                  Download MP3
                </a>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}