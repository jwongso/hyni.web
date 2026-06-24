// Auspicious-date badge — calls the fengshui.overhired.work REST API to
// surface today's "lucky/ordinary/unlucky" rating + the best upcoming days
// for an interview. Lives in the top-right of the app header so the user
// can glance at it whenever they're prepping a real interview date.
//
// API contract (mirrors ~/proj/priv/grapply/extension/popup/popup.js):
//   GET /day?date=YYYY-MM-DD
//     -> { type: 'lucky'|'ordinary'|'unlucky',
//          favourable: string[], unfavourable: string[] }
//   GET /best?activity=interview&from=...&to=...&weekend=false
//     -> { days: [{ date: 'YYYY-MM-DD', ... }, ...] }
//
// Failure-tolerant: any network / CORS / 4xx error renders the component
// as a tiny neutral dot with a tooltip, never breaking the header.

import { useEffect, useMemo, useState } from 'react';

const AUSPICE_URL = 'https://fengshui.overhired.work';

interface DayInfo {
  type: 'lucky' | 'ordinary' | 'unlucky';
  favourable: string[];
  unfavourable: string[];
}
interface BestDay {
  date: string;
}
interface FengShui {
  day: DayInfo | null;
  best: BestDay[];
}

const TYPE_COLOR: Record<DayInfo['type'], string> = {
  lucky:    '#4caf7d',
  ordinary: '#f59e0b',
  unlucky:  '#e05252',
};
const TYPE_LABEL: Record<DayInfo['type'], string> = {
  lucky:    'Lucky day',
  ordinary: 'Ordinary day',
  unlucky:  'Unlucky day',
};

function ymd(d: Date): string {
  // en-CA gives YYYY-MM-DD in the LOCAL timezone — matches what the
  // fengshui API expects.
  return d.toLocaleDateString('en-CA');
}

async function fetchAuspice(): Promise<FengShui | null> {
  const today    = ymd(new Date());
  const tomorrow = ymd(new Date(Date.now() + 86400000));
  const twoWeeks = ymd(new Date(Date.now() + 15 * 86400000));
  try {
    const [dayRes, bestRes] = await Promise.all([
      fetch(`${AUSPICE_URL}/day?date=${today}`)
        .then((r) => (r.ok ? (r.json() as Promise<DayInfo>) : null))
        .catch(() => null),
      fetch(`${AUSPICE_URL}/best?activity=interview&from=${tomorrow}&to=${twoWeeks}&weekend=false`)
        .then((r) => (r.ok ? (r.json() as Promise<{ days?: BestDay[] }>) : null))
        .catch(() => null),
    ]);
    if (!dayRes) return null;
    return { day: dayRes, best: bestRes?.days ?? [] };
  } catch {
    return null;
  }
}

export function FengShuiBadge() {
  const [data,   setData]   = useState<FengShui | null>(null);
  const [open,   setOpen]   = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAuspice().then((r) => {
      if (cancelled) return;
      setData(r);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Close the popover when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.fengshui')) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const color = data?.day ? TYPE_COLOR[data.day.type] : 'var(--muted)';
  const label = data?.day ? TYPE_LABEL[data.day.type] : (loaded ? 'feng shui offline' : 'feng shui…');

  const bestDates = useMemo(
    () => (data?.best ?? [])
      .map((d) => d.date)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 5),
    [data],
  );

  return (
    <div className="fengshui" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="fengshui__chip"
        title={label}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="fengshui__dot" style={{ background: color }} />
        <span className="fengshui__label" style={{ color }}>{label}</span>
        <span className="fengshui__badge">🈴</span>
      </button>
      {open && (
        <div className="fengshui__pop" role="dialog">
          {!data?.day ? (
            <div className="fengshui__row" style={{ color: 'var(--muted)' }}>
              fengshui.overhired.work is unreachable right now.
            </div>
          ) : (
            <>
              <div className="fengshui__row">
                <span className="fengshui__key" style={{ color }}>{TYPE_LABEL[data.day.type]}</span>
                <span style={{ color: 'var(--muted)' }}>
                  ({new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })})
                </span>
              </div>
              {data.day.type !== 'unlucky' && data.day.favourable.length > 0 && (
                <div className="fengshui__row">
                  <span className="fengshui__key">Good:</span>
                  <span>{data.day.favourable.slice(0, 4).join(', ')}</span>
                </div>
              )}
              {data.day.type !== 'unlucky' && data.day.unfavourable.length > 0 && (
                <div className="fengshui__row">
                  <span className="fengshui__key">Avoid:</span>
                  <span>{data.day.unfavourable.slice(0, 3).join(', ')}</span>
                </div>
              )}
              {bestDates.length > 0 && (
                <div className="fengshui__row">
                  <span className="fengshui__key">Best interview days:</span>
                  <span>{bestDates.join(', ')}</span>
                </div>
              )}
              <div className="fengshui__footer">
                via <a href={AUSPICE_URL} target="_blank" rel="noreferrer">fengshui.overhired.work</a>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
