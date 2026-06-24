// Tiny inline auspice dot rendered next to chat message bubbles.
//
// Uses the shared cache in lib/fengshui.ts so all messages on the same day
// share a single network round-trip with the header badge.
// Renders nothing if the API is unreachable — never breaks the chat.

import { useEffect, useState } from 'react';
import { fetchDay, TYPE_COLOR, TYPE_LABEL, ymd, type DayInfo } from '../lib/fengshui';

interface Props { at: number }

export function DayDot({ at }: Props) {
  const [day, setDay] = useState<DayInfo | null>(null);
  const dateStr = ymd(at);

  useEffect(() => {
    let cancelled = false;
    fetchDay(dateStr).then((d) => { if (!cancelled) setDay(d); });
    return () => { cancelled = true; };
  }, [dateStr]);

  if (!day) return null;

  const color   = TYPE_COLOR[day.type];
  const niceDay = new Date(at).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  const tooltip = `${TYPE_LABEL[day.type]} (${niceDay})`
    + (day.type !== 'unlucky' && day.favourable.length
        ? ` — good for: ${day.favourable.slice(0, 3).join(', ')}` : '')
    + (day.type !== 'unlucky' && day.unfavourable.length
        ? ` — avoid: ${day.unfavourable.slice(0, 2).join(', ')}` : '');

  return (
    <span className="day-dot" title={tooltip} aria-label={tooltip}>
      <span className="day-dot__core" style={{ background: color, boxShadow: `0 0 6px ${color}88` }} />
    </span>
  );
}
