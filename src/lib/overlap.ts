/**
 * Overlap classification (SPEC.md §3.4.1).
 *
 * Exports are often cumulative, so a later import re-covers days an earlier one
 * already did. Left alone that silently doubles every figure on the overlapping
 * days — and the failure looks like a productive week rather than an error.
 *
 * Whole-file SHA-256 cannot catch it, because the files genuinely differ. So
 * overlap is detected at event level and resolved per day, not per file.
 */

export type OverlapClass = 'new' | 'identical' | 'superset' | 'subset' | 'disjoint' | 'partial';
export type DayAction = 'import' | 'skip' | 'supersede' | 'pool';

export type DayOverlap = {
  day: string;
  eventCount: number;
  cycleCount: number;
  overlapClass: OverlapClass;
  sharedFingerprints: number;
  incomingOnly: number;
  existingOnly: number;
  existingTranscriptIds: string[];
  defaultAction: DayAction;
  recommendation: string;
};

export function classifyDay(
  incoming: Set<string>,
  existing: Set<string>,
): { overlapClass: OverlapClass; shared: number; incomingOnly: number; existingOnly: number } {
  let shared = 0;
  for (const f of incoming) if (existing.has(f)) shared++;
  const incomingOnly = incoming.size - shared;
  const existingOnly = existing.size - shared;

  let overlapClass: OverlapClass;
  if (existing.size === 0) overlapClass = 'new';
  else if (shared === 0) overlapClass = 'disjoint';
  else if (existingOnly === 0 && incomingOnly === 0) overlapClass = 'identical';
  else if (existingOnly === 0) overlapClass = 'superset';
  else if (incomingOnly === 0) overlapClass = 'subset';
  else overlapClass = 'partial';

  return { overlapClass, shared, incomingOnly, existingOnly };
}

/**
 * Defaults never pool a day that shares events with what is already held.
 * Pooling overlapping records counts the shared events twice, which is the one
 * failure this whole mechanism exists to prevent — and it looks like a
 * productive day rather than an error, so it must not be reachable by accident.
 */
export function defaultActionFor(overlapClass: OverlapClass): DayAction {
  switch (overlapClass) {
    case 'new':
      return 'import';
    case 'identical':
      return 'skip';
    case 'superset':
      return 'supersede';
    case 'subset':
      // The existing record is the more complete one. Keep it.
      return 'skip';
    case 'disjoint':
      return 'pool';
    case 'partial':
      // Neither side contains the other. Skipping is the only default that
      // cannot be wrong; the user is asked to choose.
      return 'skip';
  }
}

/**
 * Which actions are offered for a day. `pool` is withheld wherever the two
 * records share events, because pooling them would double-count the overlap.
 */
export function actionsFor(overlapClass: OverlapClass): DayAction[] {
  switch (overlapClass) {
    case 'new':
      return ['import', 'skip'];
    case 'identical':
      return ['skip', 'supersede'];
    case 'superset':
      return ['supersede', 'skip'];
    case 'subset':
      return ['skip', 'supersede'];
    case 'disjoint':
      return ['pool', 'supersede', 'skip'];
    case 'partial':
      return ['skip', 'supersede'];
  }
}

export function recommendationFor(
  overlapClass: OverlapClass,
  counts: { shared: number; incomingOnly: number; existingOnly: number },
): string {
  switch (overlapClass) {
    case 'new':
      return 'Not seen before — will be imported.';
    case 'identical':
      return 'Already held in full. Nothing to add, so this day will be skipped.';
    case 'superset':
      return `Contains everything already held plus ${counts.incomingOnly} new event${
        counts.incomingOnly === 1 ? '' : 's'
      }. This import will become authoritative for the day; the older one stops contributing.`;
    case 'subset':
      return `Contains less than the record already held (${counts.existingOnly} event${
        counts.existingOnly === 1 ? '' : 's'
      } missing here, nothing new). The existing record is the more complete one, so this day will be skipped.`;
    case 'disjoint':
      return 'No events in common — a separate session on the same day. Both will contribute and the day pools.';
    case 'partial':
      return `Overlaps in both directions (${counts.shared} shared, ${counts.incomingOnly} only here, ${counts.existingOnly} only in the existing record). Neither record contains the other, so this day needs your decision. It will be skipped unless you choose otherwise.`;
  }
}

export function needsDecision(overlapClass: OverlapClass): boolean {
  return overlapClass === 'partial';
}
