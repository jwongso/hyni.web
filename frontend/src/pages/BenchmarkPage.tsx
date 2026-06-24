import { useEffect, useRef, useState } from 'react';
import { createRecognizer, listAdapters } from '../stt/registry';
import type { SpeechRecognizer, SttEngineId } from '../stt/types';

interface Row {
  id: SttEngineId;
  label: string;
  available: boolean;
  transcript: string;
  status: string;
  latencyMs: number | null;
  error: string;
}

// STT Benchmark page.
//
// You press "Record N seconds". We start every available recognizer in
// parallel and stop them after N seconds. Transcripts and time-to-first-
// result are shown side by side.
//
// Note: today only Web Speech is fully-wired; wstream requires the model
// download to have happened (visit Settings once first) and transformers.js
// is still a stub. Unavailable adapters render as "—".
export function BenchmarkPage() {
  const allMetas = listAdapters();
  const [seconds, setSeconds] = useState(10);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[]>(() =>
    allMetas.map((m) => ({
      id: m.id, label: m.label, available: m.isAvailable(),
      transcript: '', status: 'idle', latencyMs: null, error: '',
    })),
  );

  const recsRef = useRef<SpeechRecognizer[]>([]);
  const t0Ref   = useRef<number>(0);

  useEffect(() => {
    return () => { recsRef.current.forEach((r) => { try { r.dispose(); } catch { /* ignore */ } }); };
  }, []);

  const patch = (id: SttEngineId, p: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const run = async () => {
    setRunning(true);
    setRows((prev) => prev.map((r) => ({ ...r, transcript: '', status: 'starting', latencyMs: null, error: '' })));
    recsRef.current.forEach((r) => { try { r.dispose(); } catch { /* ignore */ } });
    recsRef.current = [];

    t0Ref.current = performance.now();
    const firstResultAtMs = new Map<SttEngineId, number>();
    const transcripts     = new Map<SttEngineId, string>();

    for (const meta of allMetas) {
      if (!meta.isAvailable()) {
        patch(meta.id, { status: 'unavailable', error: meta.unavailableReason?.() ?? '' });
        continue;
      }
      const rec = createRecognizer(meta.id);
      rec.setHandlers({
        onResult: (text, isFinal) => {
          if (!firstResultAtMs.has(meta.id)) {
            const now = performance.now();
            firstResultAtMs.set(meta.id, now);
            patch(meta.id, { latencyMs: Math.round(now - t0Ref.current) });
          }
          if (!isFinal) return;       // skip interim for the side-by-side view
          const acc = (transcripts.get(meta.id) ?? '') + ' ' + text;
          transcripts.set(meta.id, acc);
          patch(meta.id, { transcript: acc.trim() });
        },
        onError:  (msg) => patch(meta.id, { error: msg, status: 'error' }),
        onStatus: (_state, msg) => patch(meta.id, { status: msg ?? _state }),
      });
      recsRef.current.push(rec);
      try {
        await rec.start();
        patch(meta.id, { status: 'listening' });
      } catch (e: any) {
        patch(meta.id, { error: e?.message ?? String(e), status: 'failed' });
      }
    }

    await new Promise((res) => setTimeout(res, seconds * 1000));
    for (const r of recsRef.current) {
      try { await r.stop(); } catch { /* ignore */ }
    }
    setRows((prev) => prev.map((r) => (r.status === 'listening' ? { ...r, status: 'done' } : r)));
    setRunning(false);
  };

  return (
    <div className="page">
      <h1>STT Benchmark</h1>
      <p style={{ color: 'var(--muted)' }}>
        Capture mic input for N seconds and run every available STT engine
        in parallel. Compare time-to-first-result and transcripts side-by-side.
      </p>

      <div className="row" style={{ marginBottom: '1rem' }}>
        <div className="field" style={{ width: 160 }}>
          <label>Duration (s)</label>
          <input
            type="number" min={3} max={120} step={1}
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
            disabled={running}
          />
        </div>
        <button onClick={run} disabled={running}>
          {running ? `Recording ${seconds}s…` : `Record ${seconds}s`}
        </button>
      </div>

      <table className="bench-table">
        <thead>
          <tr>
            <th style={{ width: '22%' }}>Engine</th>
            <th style={{ width: '12%' }}>Status</th>
            <th style={{ width: '12%' }}>Time-to-1st</th>
            <th>Transcript</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div>{r.label}</div>
                {!r.available && <small style={{ color: 'var(--warning)' }}>not available</small>}
              </td>
              <td>
                <span className={'status-pill ' + (
                  r.status === 'error' || r.status === 'failed' ? 'err'
                  : r.status === 'done' ? 'ok' : '')}>
                  {r.status}
                </span>
                {r.error && (
                  <div style={{ color: 'var(--error)', fontSize: '0.8rem', marginTop: 4 }}>
                    {r.error}
                  </div>
                )}
              </td>
              <td>{r.latencyMs == null ? '—' : `${r.latencyMs} ms`}</td>
              <td className="text">{r.transcript || (r.status === 'error' || r.status === 'failed' || r.status === 'unavailable' ? '—' : '…')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
