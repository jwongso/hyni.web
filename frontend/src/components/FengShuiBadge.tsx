// Header chip + popover that surfaces the fengshui.overhired.work auspice
// for today + the next ~5 best interview days. Uses the shared cache in
// lib/fengshui.ts so the per-message dots (DayDot) re-use the same fetch.

import { useEffect, useMemo, useState } from 'react';
import {
  fengshuiUrl,
  fetchBest,
  fetchDay,
  TYPE_COLOR,
  TYPE_LABEL,
  ymd,
  type BestDay,
  type DayInfo,
} from '../lib/fengshui';

export function FengShuiBadge() {
  const [day,    setDay]    = useState<DayInfo | null>(null);
  const [best,   setBest]   = useState<BestDay[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open,   setOpen]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    const today    = ymd(new Date());
    const tomorrow = ymd(new Date(Date.now() + 86400000));
    const twoWeeks = ymd(new Date(Date.now() + 15 * 86400000));
    Promise.all([fetchDay(today), fetchBest(tomorrow, twoWeeks)])
      .then(([d, b]) => {
        if (cancelled) return;
        setDay(d);
        setBest(b);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest('.fengshui')) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const color = day ? TYPE_COLOR[day.type] : 'var(--muted)';
  const label = day ? TYPE_LABEL[day.type] : (loaded ? 'feng shui offline' : 'feng shui…');

  const bestDates = useMemo(
    () => best.map((d) => d.date).sort((a, b) => a.localeCompare(b)).slice(0, 5),
    [best],
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
          {!day ? (
            <div className="fengshui__row" style={{ color: 'var(--muted)' }}>
              fengshui.overhired.work is unreachable right now.
            </div>
          ) : (
            <>
              <div className="fengshui__row">
                <span className="fengshui__key" style={{ color }}>{TYPE_LABEL[day.type]}</span>
                <span style={{ color: 'var(--muted)' }}>
                  ({new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })})
                </span>
              </div>
              {day.type !== 'unlucky' && day.favourable.length > 0 && (
                <div className="fengshui__row">
                  <span className="fengshui__key">Good:</span>
                  <span>{day.favourable.slice(0, 4).join(', ')}</span>
                </div>
              )}
              {day.type !== 'unlucky' && day.unfavourable.length > 0 && (
                <div className="fengshui__row">
                  <span className="fengshui__key">Avoid:</span>
                  <span>{day.unfavourable.slice(0, 3).join(', ')}</span>
                </div>
              )}
              {bestDates.length > 0 && (
                <div className="fengshui__row">
                  <span className="fengshui__key">Best interview days:</span>
                  <span>{bestDates.join(', ')}</span>
                </div>
              )}
              <div className="fengshui__footer">
                via <a href={fengshuiUrl} target="_blank" rel="noreferrer">fengshui.overhired.work</a>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
