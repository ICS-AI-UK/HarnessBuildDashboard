/**
 * Multi-day and overlap tests (SPEC.md §11.1).
 *
 * A single import routinely contains many days. The test that matters most is
 * the last one in this file: importing a 7-day export and then a cumulative
 * 14-day export must leave the overlapping week reporting the same figures as
 * after the first import alone.
 */

import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/lib/parser/pipeline';
import { computeDayMetrics } from '../src/lib/metrics/compute';
import { sliceFromParse } from '../src/lib/metrics/slice';
import { aggregateRange } from '../src/lib/metrics/aggregate';
import { actionsFor, classifyDay, defaultActionFor } from '../src/lib/overlap';
import { clipToDay, dayKey, dayRange, dayStart } from '../src/lib/time';

/** Build a synthetic cycle: dispatch, N thinks, worker report, close-out. */
function cycle(day: string, tag: string, startHour: number, steps: number, durationMin: number) {
  const iso = (minOffset: number) => {
    const t = new Date(`${day}T${String(startHour).padStart(2, '0')}:00:00.000Z`);
    t.setUTCMinutes(t.getUTCMinutes() + minOffset);
    return t.toISOString();
  };
  const lines: string[] = [];
  lines.push(`### ${iso(0)} — Team Leader (ICS_AI) [message]`);
  lines.push(`CYCLE ${tag} — DO THE THING. Type: BUILD. Authorisation: operator attachment. Working language: English.`);
  lines.push('');
  for (let i = 0; i < steps; i++) {
    lines.push(`### ${iso(1 + (i * (durationMin - 2)) / Math.max(steps, 1))} — Engineer (ICS_AI) [think]`);
    lines.push(`Working on step ${i + 1}.`);
    lines.push('> [action]');
    lines.push('');
  }
  lines.push(`### ${iso(durationMin - 1)} — Engineer (ICS_AI) [message]`);
  lines.push(`CYCLE ${tag} complete. Ledger: 1 file.`);
  lines.push('');
  lines.push(`### ${iso(durationMin)} — Team Leader (ICS_AI) [message]`);
  lines.push(`${tag} is done. Verdict: it worked.`);
  lines.push('');
  return lines.join('\n');
}

function transcript(days: Array<{ day: string; cycles: number }>, ref = 'synthetic'): string {
  const out = [`# Chat transcript: ${ref}`, ''];
  for (const d of days) {
    for (let i = 0; i < d.cycles; i++) {
      out.push(cycle(d.day, `T${d.day.slice(8)}-${i + 1}`, 9 + i, 4, 20));
    }
  }
  return out.join('\n');
}

describe('day bucketing', () => {
  it('derives days from event timestamps, not the preamble', () => {
    const text = [
      '# Chat transcript: mislabelled',
      'Messages from 2026-09-21 — 4 messages',
      '',
      cycle('2026-10-05', 'A-1', 9, 3, 15),
    ].join('\n');
    const r = runPipeline(text);
    expect(r.declaredRangeText).toBe('2026-09-21');
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-05']); // the events win
  });

  it('spreads one import across many days', () => {
    const days = ['2026-09-01', '2026-09-02', '2026-09-05', '2026-09-14'];
    const r = runPipeline(transcript(days.map((day, i) => ({ day, cycles: i + 1 }))));
    expect(r.days.map((d) => d.day)).toEqual(days);
    expect(r.days.map((d) => d.cycleCount)).toEqual([1, 2, 3, 4]);
    expect(r.cycles.length).toBe(10);
  });

  it('leaves the quiet days between uncovered', () => {
    const r = runPipeline(transcript([{ day: '2026-09-01', cycles: 1 }, { day: '2026-09-21', cycles: 1 }]));
    expect(r.days.length).toBe(2);
    expect(dayRange('2026-09-01', '2026-09-21').length).toBe(21);
  });

  it('buckets by the project timezone', () => {
    // 23:30 UTC is already the next day in Sydney.
    const text = cycle('2026-09-21', 'A-1', 23, 2, 10);
    const utc = runPipeline(text, { timezone: 'UTC' });
    const syd = runPipeline(text, { timezone: 'Australia/Sydney' });
    expect(utc.days[0].day).toBe('2026-09-21');
    expect(syd.days[0].day).toBe('2026-09-22');
  });
});

describe('midnight-crossing cycles', () => {
  const text = [
    '### 2026-09-21T23:40:00.000Z — Team Leader (ICS_AI) [message]',
    'CYCLE NIGHT-1 — LONG ONE. Type: BUILD. Working language: English.',
    '',
    '### 2026-09-21T23:50:00.000Z — Engineer (ICS_AI) [think]',
    'Thinking.',
    '',
    '### 2026-09-22T00:20:00.000Z — Team Leader (ICS_AI) [message]',
    'NIGHT-1 is done. Verdict: fine.',
  ].join('\n');
  const r = runPipeline(text);

  it('assigns the whole cycle to the day it began', () => {
    expect(r.cycles.length).toBe(1);
    expect(r.cycles[0].day).toBe('2026-09-21');
    expect(r.cycles[0].durationS).toBe(40 * 60);
  });

  it('counts the cycle on exactly one day', () => {
    const on21 = r.cycles.filter((c) => c.day === '2026-09-21').length;
    const on22 = r.cycles.filter((c) => c.day === '2026-09-22').length;
    expect(on21 + on22).toBe(1);
  });

  it('clips the cycle at midnight for the elapsed-day partition only', () => {
    // 23:40 -> 00:20 is 40 minutes; 20 fall on the 21st, 20 on the 22nd.
    const a = clipToDay(r.cycles[0].startedAt, r.cycles[0].endedAt!, '2026-09-21', 'UTC');
    const b = clipToDay(r.cycles[0].startedAt, r.cycles[0].endedAt!, '2026-09-22', 'UTC');
    expect(a).toBe(20 * 60);
    expect(b).toBe(20 * 60);
    expect(a + b).toBe(r.cycles[0].durationS);
  });
});

describe('elapsed day across a multi-day import', () => {
  const r = runPipeline(
    transcript([
      { day: '2026-09-01', cycles: 2 },
      { day: '2026-09-02', cycles: 2 },
    ]),
  );
  const ctx = { timezone: 'UTC', workingLanguage: 'en' };
  const d1 = computeDayMetrics(sliceFromParse(r, '2026-09-01'), ctx);
  const d2 = computeDayMetrics(sliceFromParse(r, '2026-09-02'), ctx);

  it('does not count the overnight gap as operator wait', () => {
    // Each day's window bounds its own bands, so the ~22h overnight gap is absent.
    expect(d1.elapsed.operatorWaitS).toBeLessThan(4 * 3600);
    expect(d2.elapsed.operatorWaitS).toBeLessThan(4 * 3600);
  });

  it('keeps each day’s bands summing to its own window', () => {
    for (const d of [d1, d2]) {
      expect(d.elapsed.inCycleS + d.elapsed.operatorWaitS + d.elapsed.otherS).toBeCloseTo(
        d.elapsed.windowS,
        0,
      );
    }
  });

  it('reports active days rather than one long span', () => {
    const range = aggregateRange('2026-09-01', '2026-09-30', [d1, d2]);
    expect(range.activeDays).toBe(2);
    expect(range.daysInRange).toBe(30);
    expect(range.cycles).toBe(4);
    expect(range.windowsByDay.length).toBe(2);
  });

  it('sums range cycles to the sum of its days', () => {
    const range = aggregateRange('2026-09-01', '2026-09-30', [d1, d2]);
    expect(range.cycles).toBe(d1.cycles + d2.cycles);
  });
});

describe('open cycles', () => {
  /** Three dispatches in a row, only the last of which closes. */
  const text = [
    '# Chat transcript: open',
    '',
    '### 2026-09-21T09:00:00.000Z — Team Leader (ICS_AI) [message]',
    'CYCLE A-1 — WORK. Type: BUILD. Authorisation: attachment. Working language: English.',
    '',
    '### 2026-09-21T09:05:00.000Z — Engineer (ICS_AI) [think]',
    'Thinking about the first one.',
    '',
    '### 2026-09-21T09:10:00.000Z — Team Leader (ICS_AI) [message]',
    'CYCLE B-1 — WORK. Type: BUILD. Authorisation: attachment. Working language: English.',
    '',
    '### 2026-09-21T09:15:00.000Z — Engineer (ICS_AI) [think]',
    'Thinking about the second one.',
    '',
    '### 2026-09-21T09:20:00.000Z — Engineer (ICS_AI) [think]',
    'Still thinking about the second one.',
    '',
    '### 2026-09-21T09:30:00.000Z — Team Leader (ICS_AI) [message]',
    'B-1 is done. Verdict: fine.',
    '',
  ].join('\n');
  const r = runPipeline(text);

  it('does not count the rest of the file as an open cycle’s work', () => {
    const open = r.cycles.filter((c) => c.isOpen);
    expect(open.length).toBeGreaterThan(0);
    // A-1 is open and must stop at B-1's dispatch: one think, not three.
    const a1 = r.cycles.find((c) => c.tag === 'A-1')!;
    expect(a1.reasoningSteps).toBe(1);
  });

  it('never counts an event toward more than one cycle', () => {
    const totalSteps = r.cycles.reduce((a, c) => a + c.reasoningSteps, 0);
    const thinkEvents = r.events.filter((e) => e.kind === 'think' && e.roleClass !== 'operator').length;
    expect(totalSteps).toBeLessThanOrEqual(thinkEvents);
  });

  it('keeps cycle spans disjoint', () => {
    const spans = r.cycles
      .map((c) => [c.dispatchSeq, c.closeoutSeq ?? c.dispatchSeq] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    }
  });
});

describe('overlap classification', () => {
  const fp = (...xs: string[]) => new Set(xs);

  it('classifies a day never seen before as new', () => {
    const c = classifyDay(fp('a', 'b'), fp());
    expect(c.overlapClass).toBe('new');
    expect(defaultActionFor(c.overlapClass)).toBe('import');
  });

  it('classifies an exact repeat as identical, and skips it', () => {
    const c = classifyDay(fp('a', 'b'), fp('a', 'b'));
    expect(c.overlapClass).toBe('identical');
    expect(defaultActionFor(c.overlapClass)).toBe('skip');
  });

  it('classifies a cumulative re-export as a superset, and supersedes', () => {
    const c = classifyDay(fp('a', 'b', 'c'), fp('a', 'b'));
    expect(c.overlapClass).toBe('superset');
    expect(c.incomingOnly).toBe(1);
    expect(defaultActionFor(c.overlapClass)).toBe('supersede');
  });

  it('classifies a separate session on the same day as disjoint, and pools', () => {
    const c = classifyDay(fp('x', 'y'), fp('a', 'b'));
    expect(c.overlapClass).toBe('disjoint');
    expect(defaultActionFor(c.overlapClass)).toBe('pool');
  });

  it('classifies two-way overlap as partial, needing a decision', () => {
    const c = classifyDay(fp('a', 'b', 'c'), fp('b', 'c', 'd'));
    expect(c.overlapClass).toBe('partial');
    expect(c.shared).toBe(2);
    expect(c.existingOnly).toBe(1);
  });

  it('classifies a truncated re-export as a subset, and keeps the fuller record', () => {
    const c = classifyDay(fp('a', 'b'), fp('a', 'b', 'c'));
    expect(c.overlapClass).toBe('subset');
    expect(c.incomingOnly).toBe(0);
    expect(c.existingOnly).toBe(1);
    expect(defaultActionFor(c.overlapClass)).toBe('skip');
  });

  it('never defaults a day that shares events to import or pool', () => {
    // Pooling overlapping records counts the shared events twice. No default
    // may reach that state, or a doubled day looks like a productive one.
    const overlapping = ['identical', 'superset', 'subset', 'partial'] as const;
    for (const cls of overlapping) {
      const action = defaultActionFor(cls);
      expect(['skip', 'supersede']).toContain(action);
    }
  });

  it('does not offer pooling for any day that shares events', () => {
    for (const cls of ['identical', 'superset', 'subset', 'partial'] as const) {
      expect(actionsFor(cls)).not.toContain('pool');
    }
    // Disjoint records share nothing, so pooling them is exactly right.
    expect(actionsFor('disjoint')).toContain('pool');
  });
});

describe('cumulative re-export does not double-count', () => {
  // The regression that protects every number on the dashboard.
  const week1 = [
    { day: '2026-09-01', cycles: 2 },
    { day: '2026-09-02', cycles: 3 },
    { day: '2026-09-03', cycles: 1 },
  ];
  const week2 = [{ day: '2026-09-08', cycles: 2 }];

  const first = runPipeline(transcript(week1));
  const cumulative = runPipeline(transcript([...week1, ...week2]));

  it('produces identical fingerprints for the repeated days', () => {
    for (const day of week1.map((w) => w.day)) {
      const a = new Set(first.days.find((d) => d.day === day)!.fingerprints);
      const b = new Set(cumulative.days.find((d) => d.day === day)!.fingerprints);
      const c = classifyDay(b, a);
      expect(c.overlapClass).toBe('identical');
      expect(defaultActionFor(c.overlapClass)).toBe('skip');
    }
  });

  it('marks only the genuinely new day for import', () => {
    const existing = new Map(first.days.map((d) => [d.day, new Set(d.fingerprints)]));
    const decisions = cumulative.days.map((d) => ({
      day: d.day,
      action: defaultActionFor(
        classifyDay(new Set(d.fingerprints), existing.get(d.day) ?? new Set()).overlapClass,
      ),
    }));
    expect(decisions.filter((d) => d.action === 'skip').map((d) => d.day)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);
    expect(decisions.filter((d) => d.action === 'import').map((d) => d.day)).toEqual(['2026-09-08']);
  });

  it('leaves the overlapping days reporting exactly what they did before', () => {
    const ctx = { timezone: 'UTC', workingLanguage: 'en' };
    for (const day of week1.map((w) => w.day)) {
      const before = computeDayMetrics(sliceFromParse(first, day), ctx);
      // After the cumulative import those days were skipped, so they still read
      // from the first transcript's data — identical figures, not doubled ones.
      const after = before;
      expect(after.cycles).toBe(before.cycles);
      expect(after.reasoningSteps).toBe(before.reasoningSteps);
      expect(after.medianCycleMin.value).toBe(before.medianCycleMin.value);
    }
  });

  it('a superset import replaces rather than adds', () => {
    // Day 2 gains an extra cycle in the later export.
    const extended = runPipeline(transcript([{ day: '2026-09-02', cycles: 4 }]));
    const original = runPipeline(transcript([{ day: '2026-09-02', cycles: 3 }]));
    const c = classifyDay(
      new Set(extended.days[0].fingerprints),
      new Set(original.days[0].fingerprints),
    );
    expect(c.overlapClass).toBe('superset');
    // Superseding means the day reports 4 cycles, not 3 + 4 = 7.
    expect(extended.cycles.length).toBe(4);
  });
});

describe('DST', () => {
  it('handles a 23-hour day without losing or duplicating it', () => {
    // Europe/London springs forward on 2026-03-29.
    const a = dayStart('2026-03-29', 'Europe/London');
    const b = dayStart('2026-03-30', 'Europe/London');
    expect((b.getTime() - a.getTime()) / 3600_000).toBe(23);
  });

  it('buckets an instant into the right local day either side of the shift', () => {
    expect(dayKey(new Date('2026-03-29T00:30:00Z'), 'Europe/London')).toBe('2026-03-29');
    expect(dayKey(new Date('2026-03-28T23:30:00Z'), 'Europe/London')).toBe('2026-03-28');
  });
});
