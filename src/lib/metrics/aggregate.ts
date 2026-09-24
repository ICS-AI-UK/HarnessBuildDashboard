/**
 * Range and portfolio aggregation (SPEC.md §6.5).
 *
 * Two averaging modes, because they answer different questions and mixing them
 * is the usual way a dashboard like this misleads:
 *
 *   macro  — mean of each project's own value; every project counts once
 *   pooled — recompute over every cycle from every project
 *
 * Pooled medians recompute from the combined cycle set. They never average
 * medians; macro does, and says so.
 */

import { max, mean, median, pearson, percentile, stat, stdev, sum, type Stat } from './stats';
import type { DayMetrics, ElapsedPartition } from './compute';

export type AverageMode = 'macro' | 'pooled';

export type RangeMetrics = {
  from: string;
  to: string;
  activeDays: number;
  daysInRange: number;
  cycles: number;
  openCycles: number;
  reasoningSteps: number;
  toolActions: number;
  platformErrors: number;
  medianCycleMin: Stat;
  p90CycleMin: Stat;
  longestCycleMin: Stat;
  minutesPerStep: Stat;
  stepLatencyS: Stat;
  operatorAnswers: number;
  operatorDispatches: number;
  interruptionRate: Stat;
  unrecordedAuthorisations: number;
  unrecordedRate: Stat;
  drifts: number;
  driftsUnchallenged: number;
  languageRequests: number;
  dispatchLengthVsDuration: Stat;
  stepsVsDuration: Stat;
  dispatchCharsMin: number | null;
  dispatchCharsMax: number | null;
  // Credit spend
  credits: number | null;
  declaredCredits: number | null;
  creditsByRole: Record<string, number>;
  creditsPerActiveDay: Stat;
  creditsPerCycle: Stat;
  creditsPerStep: Stat;
  medianDailyCredits: Stat;
  costliestDay: { day: string; credits: number } | null;
  daysWithCredits: number;
  // Models
  modelUsage: Record<string, { messages: number; credits: number }>;
  modelsByDay: Array<{ day: string; models: Record<string, { messages: number; credits: number }> }>;
  elapsed: ElapsedPartition;
  windowsByDay: Array<{ day: string; start: string | null; end: string | null }>;
  series: DayMetrics[];
};

/**
 * Roll a set of per-day metric objects into a range.
 *
 * Duration percentiles are recomputed from the pooled cycle durations rather
 * than averaged across days — averaging medians would be wrong.
 */
export function aggregateRange(from: string, to: string, days: DayMetrics[]): RangeMetrics {
  const active = days.filter((d) => d.activeDays > 0);
  const durations = active.flatMap((d) => d.durationsMin);
  const perStep = active.flatMap((d) =>
    d.cycleSummaries
      .filter((c) => c.durationMin !== null && c.steps > 0)
      .map((c) => c.durationMin! / c.steps),
  );
  const pairsDispatch = active.flatMap((d) =>
    d.cycleSummaries
      .filter((c) => c.durationMin !== null)
      .map((c) => [c.dispatchChars, c.durationMin! * 60] as [number, number]),
  );
  const pairsSteps = active.flatMap((d) =>
    d.cycleSummaries
      .filter((c) => c.durationMin !== null)
      .map((c) => [c.steps, c.durationMin! * 60] as [number, number]),
  );

  const answers = sum(active.map((d) => d.operatorAnswers));
  const dispatches = sum(active.map((d) => d.operatorDispatches));
  const operatorTurns = answers + dispatches;
  const cycles = sum(active.map((d) => d.cycles));
  const unrecorded = sum(active.map((d) => d.unrecordedAuthorisations));

  const latencies = active.map((d) => d.stepLatencyS.value).filter((v): v is number => v !== null);

  const daysCount = countDays(from, to);

  return {
    from,
    to,
    activeDays: active.length,
    daysInRange: daysCount,
    cycles,
    openCycles: sum(active.map((d) => d.openCycles)),
    reasoningSteps: sum(active.map((d) => d.reasoningSteps)),
    toolActions: sum(active.map((d) => d.toolActions)),
    platformErrors: sum(active.map((d) => d.platformErrors)),

    medianCycleMin: stat(median(durations), durations.length, 'median (R-7), pooled cycles'),
    p90CycleMin: stat(percentile(durations, 0.9), durations.length, 'p90 (R-7), pooled cycles'),
    longestCycleMin: stat(max(durations), durations.length, 'max'),
    minutesPerStep: stat(median(perStep), perStep.length, 'median of per-cycle ratios'),
    stepLatencyS: stat(median(latencies), latencies.length, 'median of per-day medians'),

    operatorAnswers: answers,
    operatorDispatches: dispatches,
    interruptionRate: stat(
      operatorTurns ? answers / operatorTurns : null,
      operatorTurns,
      'answers / operator turns',
    ),
    unrecordedAuthorisations: unrecorded,
    unrecordedRate: stat(cycles ? unrecorded / cycles : null, cycles, 'unrecorded / cycles'),

    drifts: sum(active.map((d) => d.drifts)),
    driftsUnchallenged: sum(active.map((d) => d.driftsUnchallenged)),
    languageRequests: sum(active.map((d) => d.languageRequests)),

    dispatchLengthVsDuration: pearson(pairsDispatch),
    stepsVsDuration: pearson(pairsSteps),
    dispatchCharsMin: active.length
      ? Math.min(...active.map((d) => d.dispatchCharsMin ?? Infinity))
      : null,
    dispatchCharsMax: active.length
      ? Math.max(...active.map((d) => d.dispatchCharsMax ?? -Infinity))
      : null,

    ...creditTotals(active),

    // Each day's bands are summed. Overnight gaps never enter, because each
    // day's window bounds its own bands (SPEC.md §5.5).
    elapsed: {
      windowS: sum(active.map((d) => d.elapsed.windowS)),
      inCycleS: sum(active.map((d) => d.elapsed.inCycleS)),
      operatorWaitS: sum(active.map((d) => d.elapsed.operatorWaitS)),
      otherS: sum(active.map((d) => d.elapsed.otherS)),
    },
    windowsByDay: active.map((d) => ({ day: d.day, start: d.windowStart, end: d.windowEnd })),
    series: days,
  };
}

/**
 * Credit spend over a range.
 *
 * Every figure here divides by the days that actually recorded credits, not by
 * the range: averaging a fortnight's spend over thirty days would understate it,
 * and a transcript with no credit data must read as unknown rather than free.
 */
function creditTotals(active: DayMetrics[]) {
  // `!= null` deliberately: documents written before credit tracking have the
  // key missing rather than null, and undefined must read the same as "not
  // recorded" rather than sneaking through as a number.
  const withCredits = active.filter((d) => d.credits != null);
  const values = withCredits.map((d) => d.credits as number);
  const total = values.length ? sum(values) : null;

  const declared = active.filter((d) => d.declaredCredits != null);
  const cyclesOnCreditDays = sum(withCredits.map((d) => d.cycles));
  const stepsOnCreditDays = sum(withCredits.map((d) => d.reasoningSteps));

  const costliest = withCredits.length
    ? withCredits.reduce((a, b) => ((b.credits as number) > (a.credits as number) ? b : a))
    : null;

  return {
    credits: total,
    declaredCredits: declared.length ? sum(declared.map((d) => d.declaredCredits as number)) : null,
    creditsByRole: withCredits.reduce<Record<string, number>>((acc, d) => {
      for (const [k, v] of Object.entries(d.creditsByRole ?? {})) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {}),
    creditsPerActiveDay: stat(
      total !== null && values.length ? total / values.length : null,
      values.length,
      'total credits / days with credit data',
    ),
    creditsPerCycle: stat(
      total !== null && cyclesOnCreditDays > 0 ? total / cyclesOnCreditDays : null,
      cyclesOnCreditDays,
      'total credits / cycles on those days',
    ),
    creditsPerStep: stat(
      total !== null && stepsOnCreditDays > 0 ? total / stepsOnCreditDays : null,
      stepsOnCreditDays,
      'total credits / reasoning steps on those days',
    ),
    medianDailyCredits: stat(median(values), values.length, 'median of daily totals (R-7)'),
    costliestDay: costliest ? { day: costliest.day, credits: costliest.credits as number } : null,
    daysWithCredits: values.length,

    modelUsage: active.reduce<Record<string, { messages: number; credits: number }>>((acc, d) => {
      for (const [k, v] of Object.entries(d.modelUsage ?? {})) {
        const row = (acc[k] ??= { messages: 0, credits: 0 });
        row.messages += v.messages;
        row.credits += v.credits;
      }
      return acc;
    }, {}),
    modelsByDay: active
      .filter((d) => Object.keys(d.modelUsage ?? {}).length > 0)
      .map((d) => ({ day: d.day, models: d.modelUsage })),
  };
}

/**
 * Merge several projects' model tallies into one range, for the estate view.
 *
 * Only the model fields are meaningful on the result; everything else is
 * carried from the first range so the panel has a shape to read. Days are
 * merged by date, so a day worked in two projects reports both projects' models.
 */
export function mergeModelMetrics(ranges: RangeMetrics[]): RangeMetrics {
  const base = ranges[0];
  if (!base) {
    return aggregateRange('', '', []);
  }

  const modelUsage: Record<string, { messages: number; credits: number }> = {};
  const byDay = new Map<string, Record<string, { messages: number; credits: number }>>();

  for (const r of ranges) {
    for (const [k, v] of Object.entries(r.modelUsage ?? {})) {
      const row = (modelUsage[k] ??= { messages: 0, credits: 0 });
      row.messages += v.messages;
      row.credits += v.credits;
    }
    for (const d of r.modelsByDay ?? []) {
      const day = byDay.get(d.day) ?? {};
      for (const [k, v] of Object.entries(d.models)) {
        const row = (day[k] ??= { messages: 0, credits: 0 });
        row.messages += v.messages;
        row.credits += v.credits;
      }
      byDay.set(d.day, day);
    }
  }

  return {
    ...base,
    from: ranges.map((r) => r.from).sort()[0],
    to: ranges.map((r) => r.to).sort().reverse()[0],
    modelUsage,
    modelsByDay: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, models]) => ({ day, models })),
  };
}

function countDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400_000) + 1;
}

// --- Portfolio ------------------------------------------------------------

export type PortfolioEntry = {
  projectId: string;
  slug: string;
  name: string;
  colour: string;
  metrics: RangeMetrics;
  included: boolean;
  exclusionReason: string | null;
};

export type PortfolioMetric = {
  key: string;
  label: string;
  unit: string;
  dp: number;
  average: number | null;
  stdev: number | null;
  n: number;
  values: Array<{ projectId: string; name: string; colour: string; value: number | null; deviation: number | null; outlier: boolean }>;
};

const METRIC_DEFS: Array<{
  key: string;
  label: string;
  unit: string;
  dp: number;
  pick: (m: RangeMetrics) => number | null;
  poolable?: (entries: PortfolioEntry[]) => number | null;
}> = [
  { key: 'cycles', label: 'Cycles', unit: '', dp: 0, pick: (m) => m.cycles },
  {
    key: 'credits',
    label: 'Credits spent',
    unit: '',
    dp: 0,
    pick: (m) => m.credits,
  },
  {
    key: 'creditsPerActiveDay',
    label: 'Credits per active day',
    unit: '',
    dp: 0,
    pick: (m) => m.creditsPerActiveDay.value,
    // Pooling divides the estate''s total spend by the estate''s credit-bearing
    // days, rather than averaging per-project daily averages.
    poolable: (es) => {
      const total = sum(
        es.map((e) => e.metrics.credits).filter((v): v is number => v != null),
      );
      const days = sum(es.map((e) => e.metrics.daysWithCredits));
      return days > 0 ? total / days : null;
    },
  },
  {
    key: 'creditsPerCycle',
    label: 'Credits per cycle',
    unit: '',
    dp: 1,
    pick: (m) => m.creditsPerCycle.value,
    poolable: (es) => {
      const total = sum(
        es.map((e) => e.metrics.credits).filter((v): v is number => v != null),
      );
      const cycles = sum(
        es.filter((e) => e.metrics.credits != null).map((e) => e.metrics.cycles),
      );
      return cycles > 0 ? total / cycles : null;
    },
  },
  {
    key: 'medianCycleMin',
    label: 'Median cycle',
    unit: 'min',
    dp: 1,
    pick: (m) => m.medianCycleMin.value,
    poolable: (es) => median(es.flatMap((e) => e.metrics.series.flatMap((d) => d.durationsMin))),
  },
  {
    key: 'p90CycleMin',
    label: '90th percentile',
    unit: 'min',
    dp: 1,
    pick: (m) => m.p90CycleMin.value,
    poolable: (es) =>
      percentile(es.flatMap((e) => e.metrics.series.flatMap((d) => d.durationsMin)), 0.9),
  },
  {
    key: 'longestCycleMin',
    label: 'Longest cycle',
    unit: 'min',
    dp: 1,
    pick: (m) => m.longestCycleMin.value,
    poolable: (es) => max(es.flatMap((e) => e.metrics.series.flatMap((d) => d.durationsMin))),
  },
  {
    key: 'minutesPerStep',
    label: 'Minutes per reasoning step',
    unit: '',
    dp: 2,
    pick: (m) => m.minutesPerStep.value,
  },
  {
    key: 'stepLatencyS',
    label: 'Step latency, median',
    unit: 's',
    dp: 1,
    pick: (m) => m.stepLatencyS.value,
  },
  { key: 'platformErrors', label: 'Platform errors', unit: '', dp: 0, pick: (m) => m.platformErrors },
  {
    key: 'operatorAnswers',
    label: 'Mid-work operator answers',
    unit: '',
    dp: 0,
    pick: (m) => m.operatorAnswers,
  },
  {
    key: 'interruptionRate',
    label: 'Interruption rate',
    unit: '%',
    dp: 0,
    pick: (m) => (m.interruptionRate.value === null ? null : m.interruptionRate.value * 100),
  },
  {
    key: 'unrecordedRate',
    label: 'Unrecorded authorisations',
    unit: '%',
    dp: 0,
    pick: (m) => (m.unrecordedRate.value === null ? null : m.unrecordedRate.value * 100),
  },
  {
    key: 'driftsUnchallenged',
    label: 'Unchallenged drifts',
    unit: '',
    dp: 0,
    pick: (m) => m.driftsUnchallenged,
  },
  {
    key: 'dispatchLengthVsDuration',
    label: 'Dispatch length vs duration',
    unit: 'r',
    dp: 2,
    pick: (m) => m.dispatchLengthVsDuration.value,
  },
  {
    key: 'stepsVsDuration',
    label: 'Steps vs duration',
    unit: 'r',
    dp: 2,
    pick: (m) => m.stepsVsDuration.value,
  },
];

export function buildPortfolio(
  entries: PortfolioEntry[],
  mode: AverageMode,
): PortfolioMetric[] {
  const included = entries.filter((e) => e.included);

  return METRIC_DEFS.map((def) => {
    const values = included
      .map((e) => ({ entry: e, value: def.pick(e.metrics) }))
      .filter((v) => v.value !== null) as Array<{ entry: PortfolioEntry; value: number }>;

    let average: number | null;
    if (mode === 'pooled' && def.poolable) {
      average = def.poolable(included);
    } else if (mode === 'pooled') {
      // Counts pool by summing; rates pool by recomputing over the totals.
      average = poolScalar(def.key, included) ?? mean(values.map((v) => v.value));
    } else {
      average = mean(values.map((v) => v.value));
    }

    const sd = stdev(values.map((v) => v.value));

    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      dp: def.dp,
      average,
      stdev: sd,
      n: values.length,
      values: entries.map((e) => {
        const v = def.pick(e.metrics);
        const deviation = v === null || average === null ? null : v - average;
        return {
          projectId: e.projectId,
          name: e.name,
          colour: e.colour,
          value: e.included ? v : null,
          deviation: e.included ? deviation : null,
          outlier:
            e.included && deviation !== null && sd !== null && sd > 0
              ? Math.abs(deviation) > sd
              : false,
        };
      }),
    };
  });
}

function poolScalar(key: string, entries: PortfolioEntry[]): number | null {
  const ms = entries.map((e) => e.metrics);
  switch (key) {
    case 'cycles':
      return sum(ms.map((m) => m.cycles));
    case 'credits': {
      const known = ms.map((m) => m.credits).filter((v): v is number => v != null);
      return known.length ? sum(known) : null;
    }
    case 'platformErrors':
      return sum(ms.map((m) => m.platformErrors));
    case 'operatorAnswers':
      return sum(ms.map((m) => m.operatorAnswers));
    case 'driftsUnchallenged':
      return sum(ms.map((m) => m.driftsUnchallenged));
    case 'interruptionRate': {
      const a = sum(ms.map((m) => m.operatorAnswers));
      const t = a + sum(ms.map((m) => m.operatorDispatches));
      return t ? (a / t) * 100 : null;
    }
    case 'unrecordedRate': {
      const u = sum(ms.map((m) => m.unrecordedAuthorisations));
      const c = sum(ms.map((m) => m.cycles));
      return c ? (u / c) * 100 : null;
    }
    default:
      return null;
  }
}
