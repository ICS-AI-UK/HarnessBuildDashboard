/**
 * Day bucketing (SPEC.md §3.4).
 *
 * Days are always derived from event timestamps in the project's timezone —
 * never from the filename or the transcript preamble. Uses Intl rather than a
 * date library so DST transitions are handled by the platform's tz database.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Local calendar date, `YYYY-MM-DD`, for an instant in a given timezone. */
export function dayKey(date: Date, timezone = 'UTC'): string {
  // en-CA gives YYYY-MM-DD directly.
  return formatterFor(timezone).format(date);
}

/**
 * The instant at which a local day begins. Found by bisection on the UTC
 * timeline, which stays correct across DST shifts (a 23- or 25-hour day) and
 * across offsets that are not whole hours.
 */
export function dayStart(day: string, timezone = 'UTC'): Date {
  const [y, m, d] = day.split('-').map(Number);
  // Start from midnight UTC and walk to the correct instant.
  let lo = Date.UTC(y, m - 1, d) - 26 * 3600_000;
  let hi = Date.UTC(y, m - 1, d) + 26 * 3600_000;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dayKey(new Date(mid), timezone) < day) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

export function dayEnd(day: string, timezone = 'UTC'): Date {
  return dayStart(nextDay(day), timezone);
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

export function prevDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.toISOString().slice(0, 10);
}

/** Inclusive list of day keys between two dates. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard++ < 4000) {
    out.push(cur);
    cur = nextDay(cur);
  }
  return out;
}

export function todayKey(timezone = 'UTC'): string {
  return dayKey(new Date(), timezone);
}

export function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** First and last day of the month containing `day`. */
export function monthBounds(day: string): { from: string; to: string } {
  const [y, m] = day.split('-').map(Number);
  const from = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

export function addMonths(monthStr: string, delta: number): string {
  const [y, m] = monthStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return dt.toISOString().slice(0, 7);
}

/** Weekday index with Monday = 0, in the given timezone. */
export function mondayIndex(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return (dow + 6) % 7;
}

export function formatDayLong(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatClock(date: Date, timezone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatClockSeconds(date: Date, timezone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/** Clip an interval to a day's local bounds. Returns seconds of overlap. */
export function clipToDay(
  start: Date,
  end: Date,
  day: string,
  timezone = 'UTC',
): number {
  const lo = dayStart(day, timezone).getTime();
  const hi = dayEnd(day, timezone).getTime();
  const a = Math.max(start.getTime(), lo);
  const b = Math.min(end.getTime(), hi);
  return b > a ? (b - a) / 1000 : 0;
}
