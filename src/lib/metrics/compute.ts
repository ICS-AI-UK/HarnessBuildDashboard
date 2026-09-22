/**
 * Metric computation (SPEC.md §5).
 *
 * Takes the parser's output for one day and produces the full metric set the
 * dashboard renders. Every figure carries {value, n, method} so the UI can show
 * "—" for an empty set rather than a misleading zero.
 */

import { clipToDay, dayEnd, dayStart } from '../time';
import { max, median, pearson, percentile, stat, sum, type Stat } from './stats';
import type { DaySlice } from './slice';
import type { ParsedCycle } from '../parser/types';

export type ElapsedPartition = {
  windowS: number;
  inCycleS: number;
  operatorWaitS: number;
  otherS: number;
};

export type DayMetrics = {
  day: string;
  activeDays: number;
  // Headline
  cycles: number;
  openCycles: number;
  reasoningSteps: number;
  toolActions: number;
  platformErrors: number;
  windowStart: string | null;
  windowEnd: string | null;
  // At a glance
  medianCycleMin: Stat;
  p90CycleMin: Stat;
  longestCycleMin: Stat;
  minutesPerStep: Stat;
  stepLatencyS: Stat;
  operatorAnswers: number;
  // Complexity
  dispatchLengthVsDuration: Stat;
  operatorDispatchLengthVsDuration: Stat;
  stepsVsDuration: Stat;
  dispatchCharsMin: number | null;
  dispatchCharsMax: number | null;
  // Elapsed day
  elapsed: ElapsedPartition;
  // Interruptions
  operatorDispatches: number;
  interruptionRate: Stat;
  answerTexts: string[];
  // Audit gap
  unrecordedAuthorisations: number;
  // Drift
  drifts: number;
  driftsUnchallenged: number;
  driftsByClass: Record<string, number>;
  languageRequests: number;
  // Distribution data for charts
  durationsMin: number[];
  cycleSummaries: Array<{
    tag: string;
    durationMin: number | null;
    steps: number;
    dispatchChars: number;
    type: string;
    halted: boolean;
  }>;
};

export type ComputeContext = {
  timezone: string;
  workingLanguage: string;
};

export function emptyElapsed(): ElapsedPartition {
  return { windowS: 0, inCycleS: 0, operatorWaitS: 0, otherS: 0 };
}

/**
 * Compute a day's metrics from its stored slice.
 *
 * Takes aggregates rather than event rows: the only thing the metrics ever
 * needed from the events was the day's first and last timestamps and how many
 * there were.
 */
export function computeDayMetrics(slice: DaySlice, ctx: ComputeContext): DayMetrics {
  const { day, cycles, turns, drifts, errors } = slice;

  const closed = cycles.filter((c) => !c.isOpen && c.durationS !== null);
  const durationsS = closed.map((c) => c.durationS!);
  const durationsMin = durationsS.map((s) => s / 60);

  // Minutes per reasoning step, over cycles that actually had steps.
  const perStep = closed
    .filter((c) => c.reasoningSteps > 0)
    .map((c) => c.durationS! / 60 / c.reasoningSteps);

  // Step latency: the per-cycle medians, pooled. Cross-boundary gaps are excluded
  // upstream, because those are operator wait rather than agent latency.
  const latencies = closed.map((c) => c.medianStepLatencyS).filter((v): v is number => v !== null);

  const answers = turns.filter((t) => t.classification === 'answer');
  const operatorDispatches = turns.filter((t) => t.classification === 'dispatch');
  const operatorTurnTotal = answers.length + operatorDispatches.length;

  const windowStartDate = slice.firstEventAt ? new Date(slice.firstEventAt) : null;
  const windowEndDate = slice.lastEventAt ? new Date(slice.lastEventAt) : null;

  return {
    day,
    activeDays: slice.eventCount > 0 ? 1 : 0,
    cycles: cycles.length,
    openCycles: cycles.filter((c) => c.isOpen).length,
    reasoningSteps: sum(cycles.map((c) => c.reasoningSteps)),
    toolActions: sum(cycles.map((c) => c.toolActions)),
    platformErrors: errors.length,
    windowStart: windowStartDate ? windowStartDate.toISOString() : null,
    windowEnd: windowEndDate ? windowEndDate.toISOString() : null,

    medianCycleMin: stat(median(durationsMin), durationsMin.length, 'median (R-7)'),
    p90CycleMin: stat(percentile(durationsMin, 0.9), durationsMin.length, 'p90 (R-7)'),
    longestCycleMin: stat(max(durationsMin), durationsMin.length, 'max'),
    minutesPerStep: stat(median(perStep), perStep.length, 'median of per-cycle ratios'),
    stepLatencyS: stat(median(latencies), latencies.length, 'median of per-cycle medians'),
    operatorAnswers: answers.length,

    dispatchLengthVsDuration: pearson(
      closed.map((c) => [c.dispatchChars, c.durationS!] as [number, number]),
    ),
    operatorDispatchLengthVsDuration: pearson(
      closed
        .filter((c) => c.operatorDispatchChars !== null)
        .map((c) => [c.operatorDispatchChars!, c.durationS!] as [number, number]),
    ),
    stepsVsDuration: pearson(
      closed.map((c) => [c.reasoningSteps, c.durationS!] as [number, number]),
    ),
    dispatchCharsMin: cycles.length ? Math.min(...cycles.map((c) => c.dispatchChars)) : null,
    dispatchCharsMax: cycles.length ? Math.max(...cycles.map((c) => c.dispatchChars)) : null,

    elapsed: computeElapsed(slice, ctx.timezone),

    operatorDispatches: operatorDispatches.length,
    interruptionRate: stat(
      operatorTurnTotal ? answers.length / operatorTurnTotal : null,
      operatorTurnTotal,
      'answers / operator turns',
    ),
    answerTexts: answers.map((a) => a.excerpt),

    unrecordedAuthorisations: cycles.filter((c) => !c.authorisationRecorded).length,

    drifts: drifts.length,
    driftsUnchallenged: drifts.filter((d) => !d.challenged).length,
    driftsByClass: drifts.reduce<Record<string, number>>((acc, d) => {
      acc[d.eventClass] = (acc[d.eventClass] ?? 0) + 1;
      return acc;
    }, {}),
    languageRequests: slice.englishRequests,

    durationsMin,
    cycleSummaries: cycles.map((c) => ({
      tag: c.tag,
      durationMin: c.durationS === null ? null : c.durationS / 60,
      steps: c.reasoningSteps,
      dispatchChars: c.dispatchChars,
      type: c.cycleType,
      halted: c.halted,
    })),
  };
}

/**
 * Where the elapsed day goes (SPEC.md §5.5).
 *
 * This is the one metric where intervals are clipped at midnight, so the bands
 * sum to the day's window. An overnight gap is therefore not counted as
 * seventeen hours of operator wait.
 */
export function computeElapsed(slice: DaySlice, timezone: string): ElapsedPartition {
  const { day, cycles } = slice;
  if (!slice.firstEventAt || !slice.lastEventAt) return emptyElapsed();

  const lo = Math.max(
    new Date(slice.firstEventAt).getTime(),
    dayStart(day, timezone).getTime(),
  );
  const hi = Math.min(new Date(slice.lastEventAt).getTime(), dayEnd(day, timezone).getTime());
  const windowS = Math.max(0, (hi - lo) / 1000);

  const inCycleS = sum(
    cycles
      .filter((c) => c.endedAt)
      .map((c) => clipToDay(c.startedAt, c.endedAt!, day, timezone)),
  );

  // Operator wait: from each close-out to the next dispatch.
  const ordered = [...cycles].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  let operatorWaitS = 0;
  for (let i = 0; i < ordered.length - 1; i++) {
    const end = ordered[i].endedAt;
    if (!end) continue;
    const nextStart = ordered[i + 1].startedAt;
    if (nextStart > end) operatorWaitS += clipToDay(end, nextStart, day, timezone);
  }

  const otherS = Math.max(0, windowS - inCycleS - operatorWaitS);
  return { windowS, inCycleS, operatorWaitS, otherS };
}
