// Shared, cached client for fengshui.overhired.work.
//
// Both the header badge and the per-message dots read from this module so a
// single network round-trip serves the entire app. Per-date results live in
// an in-memory Map for the duration of the page session — ample for a
// single-user interview-practice tool.

const AUSPICE_URL = 'https://fengshui.overhired.work';

export type DayType = 'lucky' | 'ordinary' | 'unlucky';

export interface DayInfo {
  type: DayType;
  favourable: string[];
  unfavourable: string[];
}
export interface BestDay { date: string; type?: DayType; matched?: string[] }

export const TYPE_COLOR: Record<DayType, string> = {
  lucky:    '#4caf7d',
  ordinary: '#f59e0b',
  unlucky:  '#e05252',
};
export const TYPE_LABEL: Record<DayType, string> = {
  lucky:    'Lucky day',
  ordinary: 'Ordinary day',
  unlucky:  'Unlucky day',
};

export function ymd(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  // en-CA gives YYYY-MM-DD in the LOCAL timezone — what the API expects.
  return date.toLocaleDateString('en-CA');
}

// In-memory caches keyed by date string. Stores resolved promises so
// concurrent callers share one in-flight fetch.
const dayCache  = new Map<string, Promise<DayInfo | null>>();
const bestCache = new Map<string, Promise<BestDay[]>>();

export function fetchDay(dateStr: string): Promise<DayInfo | null> {
  const hit = dayCache.get(dateStr);
  if (hit) return hit;
  const p = fetch(`${AUSPICE_URL}/day?date=${dateStr}`)
    .then((r) => (r.ok ? (r.json() as Promise<DayInfo>) : null))
    .catch(() => null);
  dayCache.set(dateStr, p);
  return p;
}

export function fetchBest(fromStr: string, toStr: string, activity = 'interview'): Promise<BestDay[]> {
  const key = `${activity}|${fromStr}|${toStr}`;
  const hit = bestCache.get(key);
  if (hit) return hit;
  const url = `${AUSPICE_URL}/best?activity=${activity}&from=${fromStr}&to=${toStr}&weekend=false`;
  const p = fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((j: any) => (j?.days as BestDay[]) ?? [])
    .catch(() => [] as BestDay[]);
  bestCache.set(key, p);
  return p;
}

export const fengshuiUrl = AUSPICE_URL;
