import { useEffect, useRef, useState } from 'react';
import { createRecognizer, listRecognizers } from '../stt';
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
// You press "Record 10s". We capture mic input for the configured duration
// and pipe it to every available recognizer in parallel. After they all
// stop, we show transcripts + observed latency side-by-side.
//
// Today only the Web Speech adapter is fully wired, so the wstream and
// transformers.js columns will show their integration stub error.
export function BenchmarkPage() {
  const recognizers = listRecognizers();
  const [seconds, setSeconds] = useState(10);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Row[]>(() =>
    recognizers.map(r => ({
      id: r.id, label: r.label, available: r.available,
      transcript: '', status: 'idle', latencyMs: null, error: '',
    })),
  );

  const recsRef = useRef<SpeechRecognizer[]>([]);
  const t0Ref   = useRef<number>(0);

  useEffect(() => {
    return () => { recsRef.current.forEach(r => r.dispose()); };
  }, []);

  const updateRow = (id: SttEngineId, patch: Partial<Row>) =>
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const run = async () => {
    setRunning(true);
    setRows(prev => prev.map(r => ({ ...r, transcript: '', status: 'starting', latencyMs: null, error: '' })));
    recsRef.current.forEach(r => r.dispose());
    recsRef.current = [];

    t0Ref.current = performance.now();

    for (const info of recognizers) {
      const rec = createRecognizer(info.id);
      let firstResultAt: number | null = null;
      rec.onResult = (text, isFinal) => {
        if (firstResultAt == null) {
          firstResultAt = performance.now();
          updateRow(info.id, { latencyMs: Math.round(firstResultAt - t0Ref.current) });
        }
        updateRow(info.id, isFinal
          ? { transcript: (rowOf(info.id)?.transcript ?? '') + ' ' + text }
          : {}                            // ignore interims for benchmark clarity
        );
      };
      rec.onStatus = (s) => updateRow(info.id, { status: s });
      rec.onError  = (m) => updateRow(info.id, { error: m, status: 'error' });
      recsRef.current.push(rec);
      try {
        await rec.start();
        updateRow(info.id, { status: 'listening' });
      } catch (e: any) {
        updateRow(info.id, { error: e?.message ?? String(e), status: 'failed' });
      }
    }

    // Helper that runs inside onResult closure: read current row from latest
    // state via a function-form setRows update would be cleaner, but a tiny
    // lookup against the closure rows is sufficient for benchmark display.
    function rowOf(id: SttEngineId): Row | undefined {
      let snap: Row | undefined;
      setRows(prev => {
        snap = prev.find(r => r.id === id);
        return prev;
      });
      return snap;
    }

    await new Promise(res => setTimeout(res, seconds * 1000));
    for (const r of recsRef.current) {
      try { await r.stop(); } catch { /* ignore */ }
    }
    setRows(prev => prev.map(r => r.status === 'listening' ? { ...r, status: 'done' } : r));
    setRunning(false);
  };

  return (
    <div className="page">
      <h1>STT Benchmark</h1>
      <p style={{ color: 'var(--muted)' }}>
        Capture mic input for N seconds and run every available speech-to-text
        engine on it. Compare transcript quality and time-to-first-result.
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
            <th style={{ width: '20%' }}>Engine</th>
            <th style={{ width: '10%' }}>Status</th>
            <th style={{ width: '12%' }}>Time-to-1st</th>
            <th>Transcript</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>
                <div>{r.label}</div>
                {!r.available && <small style={{ color: 'var(--warning)' }}>not available</small>}
              </td>
              <td>
                <span className={'status-pill ' + (r.status === 'error' || r.status === 'failed' ? 'err' : r.status === 'done' ? 'ok' : '')}>
                  {r.status}
                </span>
                {r.error && <div style={{ color: 'var(--error)', fontSize: '0.8rem', marginTop: 4 }}>{r.error}</div>}
              </td>
              <td>{r.latencyMs == null ? '—' : `${r.latencyMs} ms`}</td>
              <td className="text">{r.transcript || (r.status === 'error' || r.status === 'failed' ? '—' : '…')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
