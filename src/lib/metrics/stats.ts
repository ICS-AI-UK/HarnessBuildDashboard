/**
 * Statistical conventions (SPEC.md §4).
 *
 * Every figure the dashboard shows comes through here, so the conventions are
 * stated once: R-7 percentiles, Pearson correlation suppressed below n = 8,
 * empty sets as null (never 0), full precision until display.
 */

export type Stat = {
  value: number | null;
  n: number;
  method: string;
};

export const MIN_N_FOR_CORRELATION = 8;

export function stat(value: number | null, n: number, method: string): Stat {
  return { value, n, method };
}

/** Percentile by linear interpolation between order statistics (R-7 / PERCENTILE.INC). */
export function percentile(values: number[], q: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const h = (xs.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return xs[lo];
  return xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

export function mean(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sum(values: number[]): number {
  return values.filter((v) => Number.isFinite(v)).reduce((a, b) => a + b, 0);
}

export function max(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? Math.max(...xs) : null;
}

export function min(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? Math.min(...xs) : null;
}

/** Population standard deviation. */
export function stdev(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length);
}

/**
 * Pearson r. Returns null when n is too small to mean anything, or when either
 * variable is constant — an undefined correlation, not a zero one.
 */
export function pearson(
  pairs: Array<[number, number]>,
  minN = MIN_N_FOR_CORRELATION,
): Stat {
  const xs = pairs.filter(
    ([a, b]) => Number.isFinite(a) && Number.isFinite(b),
  );
  const n = xs.length;
  const method = `Pearson r (n ≥ ${minN})`;
  if (n < minN) return stat(null, n, method);

  const mx = mean(xs.map((p) => p[0]))!;
  const my = mean(xs.map((p) => p[1]))!;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [a, b] of xs) {
    num += (a - mx) * (b - my);
    dx += (a - mx) ** 2;
    dy += (b - my) ** 2;
  }
  if (dx === 0 || dy === 0) return stat(null, n, method);
  return stat(num / Math.sqrt(dx * dy), n, method);
}

export function round(value: number | null, dp: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
