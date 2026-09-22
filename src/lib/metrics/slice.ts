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
  fingerprints: string[];
  cycles: ParsedCycle[];
  turns: ParsedOperatorTurn[];
  drifts: ParsedDrift[];
  errors: ParsedPlatformError[];
};

/** Dates survive JSON as ISO strings; revive them before computing. */
export function reviveSlice(raw: DaySlice): DaySlice {
  return {
    ...raw,
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
  return {
    day,
    eventCount: events.length,
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
