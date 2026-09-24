/**
 * A day's worth of derived data, in the form it is stored.
 *
 * Deliberately excludes per-event rows: metrics only ever needed the day's
 * first and last timestamps and its event count, not the events themselves.
 * Event-level evidence is rebuilt by re-parsing the stored transcript on demand.
 */

import type {
  ParseResult,
  ParsedCycle,
  ParsedDrift,
  ParsedOperatorTurn,
  ParsedPlatformError,
} from '../parser/types';

/** Truncated fingerprint: enough to detect overlap, a quarter of the size. */
export const FINGERPRINT_LENGTH = 16;

export type DaySlice = {
  day: string;
  eventCount: number;
  firstEventAt: string | null; // ISO
  lastEventAt: string | null; // ISO
  englishRequests: number;
  /** Credits recorded on this day's events; null when the export has none. */
  credits: number | null;
  /** The platform's own figure for the day, when the export declares one. */
  declaredCredits: number | null;
  /** Credits by role class, for showing where the spend goes. */
  creditsByRole: Record<string, number>;
  /** Messages and credits per model on this day; empty when none are named. */
  modelUsage: Record<string, { messages: number; credits: number }>;
  fingerprints: string[];
  cycles: ParsedCycle[];
  turns: ParsedOperatorTurn[];
  drifts: ParsedDrift[];
  errors: ParsedPlatformError[];
};

/**
 * Dates survive JSON as ISO strings; revive them before computing.
 *
 * Also fills fields added after a document was written. Slices stored before
 * credit tracking existed have no credit keys at all, and `undefined` is not
 * `null` — one means "not recorded", the other crashes anything that reads it.
 */
export function reviveSlice(raw: DaySlice): DaySlice {
  return {
    ...raw,
    // `??` rather than spread defaults: a stored `null` is meaningful and must
    // survive, while a missing key needs filling.
    credits: raw.credits ?? null,
    declaredCredits: raw.declaredCredits ?? null,
    creditsByRole: raw.creditsByRole ?? {},
    modelUsage: raw.modelUsage ?? {},
    cycles: raw.cycles.map((c) => ({
      ...c,
      startedAt: new Date(c.startedAt),
      endedAt: c.endedAt ? new Date(c.endedAt) : null,
    })),
    turns: raw.turns.map((t) => ({ ...t, tsUtc: new Date(t.tsUtc) })),
    drifts: raw.drifts.map((d) => ({ ...d, tsUtc: new Date(d.tsUtc) })),
    errors: raw.errors.map((e) => ({ ...e, tsUtc: new Date(e.tsUtc) })),
  };
}

export function sliceFromParse(parse: ParseResult, day: string): DaySlice {
  const events = parse.events.filter((e) => e.day === day);
  const withCredits = events.filter((e) => e.credits !== null);
  const creditsByRole: Record<string, number> = {};
  for (const e of withCredits) {
    creditsByRole[e.roleClass] = (creditsByRole[e.roleClass] ?? 0) + (e.credits as number);
  }
  // Every message names its model, including the unpriced operator ones, so
  // message counts and credit totals are tallied separately.
  const modelUsage: Record<string, { messages: number; credits: number }> = {};
  for (const e of events) {
    if (!e.model) continue;
    const row = (modelUsage[e.model] ??= { messages: 0, credits: 0 });
    row.messages += 1;
    row.credits += e.credits ?? 0;
  }
  return {
    day,
    eventCount: events.length,
    credits: withCredits.length ? withCredits.reduce((a, e) => a + (e.credits as number), 0) : null,
    declaredCredits: parse.declaredCredits?.byDay[day] ?? null,
    creditsByRole,
    modelUsage,
    firstEventAt: events.length ? events[0].tsUtc.toISOString() : null,
    lastEventAt: events.length ? events[events.length - 1].tsUtc.toISOString() : null,
    englishRequests: events.filter(
      (e) => e.kind === 'message' && e.roleClass === 'operator' && parse.englishRequestSeqs.includes(e.seq),
    ).length,
    fingerprints: events.map((e) => e.fingerprint.slice(0, FINGERPRINT_LENGTH)),
    cycles: parse.cycles.filter((c) => c.day === day),
    turns: parse.operatorTurns.filter((t) => t.day === day),
    drifts: parse.drifts.filter((d) => d.day === day),
    errors: parse.platformErrors.filter((e) => e.day === day),
  };
}

/** Pool several contributing transcripts' slices for one day. */
export function mergeSlices(slices: DaySlice[]): DaySlice {
  if (slices.length === 0) {
    return {
      day: '',
      eventCount: 0,
      firstEventAt: null,
      lastEventAt: null,
      englishRequests: 0,
      credits: null,
      declaredCredits: null,
      creditsByRole: {},
      modelUsage: {},
      fingerprints: [],
      cycles: [],
      turns: [],
      drifts: [],
      errors: [],
    };
  }
  if (slices.length === 1) return slices[0];

  const firsts = slices.map((s) => s.firstEventAt).filter((v): v is string => v !== null);
  const lasts = slices.map((s) => s.lastEventAt).filter((v): v is string => v !== null);

  return {
    day: slices[0].day,
    eventCount: slices.reduce((a, s) => a + s.eventCount, 0),
    firstEventAt: firsts.length ? firsts.sort()[0] : null,
    lastEventAt: lasts.length ? lasts.sort()[lasts.length - 1] : null,
    englishRequests: slices.reduce((a, s) => a + s.englishRequests, 0),
    credits: slices.some((s) => s.credits !== null)
      ? slices.reduce((a, s) => a + (s.credits ?? 0), 0)
      : null,
    declaredCredits: slices.some((s) => s.declaredCredits !== null)
      ? slices.reduce((a, s) => a + (s.declaredCredits ?? 0), 0)
      : null,
    creditsByRole: slices.reduce<Record<string, number>>((acc, s) => {
      for (const [k, v] of Object.entries(s.creditsByRole ?? {})) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {}),
    modelUsage: slices.reduce<Record<string, { messages: number; credits: number }>>((acc, s) => {
      for (const [k, v] of Object.entries(s.modelUsage ?? {})) {
        const row = (acc[k] ??= { messages: 0, credits: 0 });
        row.messages += v.messages;
        row.credits += v.credits;
      }
      return acc;
    }, {}),
    fingerprints: [...new Set(slices.flatMap((s) => s.fingerprints))],
    cycles: slices
      .flatMap((s) => s.cycles)
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()),
    turns: slices.flatMap((s) => s.turns),
    drifts: slices.flatMap((s) => s.drifts),
    errors: slices.flatMap((s) => s.errors),
  };
}

export type { ParsedCycle, ParsedDrift, ParsedOperatorTurn, ParsedPlatformError };
