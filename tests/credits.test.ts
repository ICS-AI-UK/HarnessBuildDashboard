/**
 * Credit parsing, spend metrics and burndown (SPEC.md §5.11, §5.12).
 *
 * The fixture is a real export in the newer format: a `## Credit usage`
 * preamble, and a `(n credits)` suffix on every agent message.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/lib/parser/pipeline';
import { scanTranscript } from '../src/lib/parser/scan';
import { computeDayMetrics } from '../src/lib/metrics/compute';
import { sliceFromParse } from '../src/lib/metrics/slice';
import { aggregateRange } from '../src/lib/metrics/aggregate';
import { computeBurndown } from '../src/lib/metrics/burndown';
import type { DayMetrics } from '../src/lib/metrics/compute';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/credits-2026-09-23.md'), 'utf8');
const CTX = { timezone: 'UTC', workingLanguage: 'en' };

describe('the credit export format', () => {
  const s = scanTranscript(FIXTURE);

  it('does not drop events that carry a credit suffix', () => {
    // The original header pattern required the kind to end the line, so every
    // priced message was silently skipped — 81 of 921 events survived.
    expect(s.events.length).toBe(959);
    expect(s.events.filter((e) => e.credits !== null).length).toBe(876);
  });

  it('reads the declared credit block', () => {
    expect(s.declaredCredits).toEqual({
      total: 15543.87,
      byDay: { '2026-09-23': 6815.31, '2026-09-24': 8728.57 },
    });
  });

  it('takes the message count from an "Exported ..." preamble', () => {
    expect(s.declaredMessageCount).toBe(1022);
    // That wording states when the file was written, not what it covers, so it
    // must not be read as a date range.
    expect(s.declaredRangeText).toBeNull();
  });

  it('leaves operator messages unpriced rather than free', () => {
    const operator = s.events.filter((e) => e.role === 'User');
    expect(operator.length).toBeGreaterThan(0);
    expect(operator.every((e) => e.credits === null)).toBe(true);
  });

  it('still parses an export with no credit data at all', () => {
    const plain = readFileSync(join(__dirname, 'fixtures/workbench-2026-09-21.md'), 'utf8');
    const p = scanTranscript(plain);
    expect(p.events.length).toBe(612);
    expect(p.declaredCredits).toBeNull();
    expect(p.events.every((e) => e.credits === null)).toBe(true);
  });
});

describe('per-message credits are costs, not a running total', () => {
  const r = runPipeline(FIXTURE);

  it('sums to the platform’s own daily figures', () => {
    const d23 = computeDayMetrics(sliceFromParse(r, '2026-09-23'), CTX);
    const d24 = computeDayMetrics(sliceFromParse(r, '2026-09-24'), CTX);

    // Summed from values rounded to 2dp, so a few hundredths of drift over
    // hundreds of messages is expected; anything more is not.
    expect(d23.credits!).toBeCloseTo(6815.31, 0);
    expect(d24.credits!).toBeCloseTo(8728.57, 0);
    expect(Math.abs(d23.credits! - d23.declaredCredits!)).toBeLessThan(1);
    expect(Math.abs(d24.credits! - d24.declaredCredits!)).toBeLessThan(1);
  });

  it('reconciles across the whole file', () => {
    const days = r.days.map((d) => computeDayMetrics(sliceFromParse(r, d.day), CTX));
    const range = aggregateRange(r.days[0].day, r.days[r.days.length - 1].day, days);
    expect(range.credits!).toBeCloseTo(15543.87, 0);
    expect(range.daysWithCredits).toBe(2);
  });

  it('attributes spend to the roles that incurred it', () => {
    const d = computeDayMetrics(sliceFromParse(r, '2026-09-23'), CTX);
    // The worker does the work, so it carries most of the cost.
    expect(d.creditsByRole.worker).toBeGreaterThan(d.creditsByRole.orchestrator);
    expect(d.creditsByRole.operator ?? 0).toBe(0);
  });

  it('derives per-cycle and per-step spend', () => {
    const d = computeDayMetrics(sliceFromParse(r, '2026-09-23'), CTX);
    expect(d.creditsPerCycle.value).toBeCloseTo(d.credits! / d.cycles, 5);
    expect(d.creditsPerStep.value).toBeCloseTo(d.credits! / d.reasoningSteps, 5);
    expect(d.costliestCycle).not.toBeNull();
  });
});

describe('a transcript without credits reads as unknown, not free', () => {
  const plain = runPipeline(readFileSync(join(__dirname, 'fixtures/workbench-2026-09-21.md'), 'utf8'));
  const d = computeDayMetrics(sliceFromParse(plain, '2026-09-21'), CTX);

  it('leaves the day total null', () => {
    expect(d.credits).toBeNull();
    expect(d.declaredCredits).toBeNull();
  });

  it('suppresses the derived rates rather than dividing by nothing', () => {
    expect(d.creditsPerCycle.value).toBeNull();
    expect(d.creditsPerStep.value).toBeNull();
    expect(d.costliestCycle).toBeNull();
  });

  it('keeps a range null too', () => {
    const range = aggregateRange('2026-09-21', '2026-09-21', [d]);
    expect(range.credits).toBeNull();
    expect(range.creditsPerActiveDay.value).toBeNull();
    expect(range.daysWithCredits).toBe(0);
  });
});

describe('models named on each message', () => {
  const s = scanTranscript(FIXTURE);
  const r = runPipeline(FIXTURE);

  it('does not drop events that carry a model suffix', () => {
    // The model arrives after the credits, so a pattern anchored at the credits
    // rejects every priced-and-modelled header — 44 of 959 events survived.
    expect(s.events.length).toBe(959);
    expect(s.events.filter((e) => e.model !== null).length).toBeGreaterThan(900);
  });

  it('reads the declared models block', () => {
    expect(s.declaredModels).toEqual([
      { model: 'claude-opus-5', messages: 931, credits: 15543.87 },
      { model: 'claude-opus-5-5', messages: 33, credits: 0 },
      { model: 'd2-20260917', messages: 9, credits: 0 },
    ]);
  });

  it('records a model even on messages that cost nothing', () => {
    // Operator turns are unpriced but still name the model that served them.
    const free = s.events.filter((e) => e.credits === null && e.model !== null);
    expect(free.length).toBeGreaterThan(0);
  });

  it('tallies models per day, separating messages from spend', () => {
    const d23 = computeDayMetrics(sliceFromParse(r, '2026-09-23'), CTX);
    const d24 = computeDayMetrics(sliceFromParse(r, '2026-09-24'), CTX);

    expect(d23.primaryModel).toBe('claude-opus-5');
    expect(d24.primaryModel).toBe('claude-opus-5');

    // A model can hold a share of the messages and none of the cost, which is
    // exactly why the two are counted separately.
    expect(d23.modelUsage['d2-20260917'].messages).toBeGreaterThan(0);
    expect(d23.modelUsage['d2-20260917'].credits).toBe(0);

    // Per-model credits sum back to the day's total.
    const summed = Object.values(d23.modelUsage).reduce((a, v) => a + v.credits, 0);
    expect(summed).toBeCloseTo(d23.credits!, 5);
  });

  it('aggregates models across a range, with a series per day', () => {
    const days = r.days.map((d) => computeDayMetrics(sliceFromParse(r, d.day), CTX));
    const range = aggregateRange(r.days[0].day, r.days[r.days.length - 1].day, days);

    expect(Object.keys(range.modelUsage).sort()).toEqual([
      'claude-opus-5',
      'claude-opus-5-5',
      'd2-20260917',
    ]);
    expect(range.modelsByDay.length).toBe(2);
    expect(range.modelUsage['claude-opus-5'].credits).toBeCloseTo(range.credits!, 1);
  });

  it('leaves a modelless export empty rather than inventing one', () => {
    const plain = runPipeline(readFileSync(join(__dirname, 'fixtures/workbench-2026-09-21.md'), 'utf8'));
    const d = computeDayMetrics(sliceFromParse(plain, '2026-09-21'), CTX);
    expect(d.modelUsage).toEqual({});
    expect(d.primaryModel).toBeNull();
    expect(plain.declaredModels).toBeNull();
  });
});

// --- Burndown --------------------------------------------------------------

function day(d: string, credits: number | null): DayMetrics {
  return { day: d, activeDays: 1, cycles: 1, credits, reasoningSteps: 1 } as unknown as DayMetrics;
}

describe('credit burndown', () => {
  it('subtracts only spend on or after the balance date', () => {
    const b = computeBurndown({
      balance: 1000,
      asOf: '2026-09-10',
      days: [day('2026-09-09', 500), day('2026-09-10', 100), day('2026-09-11', 100)],
      today: '2026-09-11',
    });
    // The 500 spent the day before the balance was stated is already reflected in it.
    expect(b.spentSinceAsOf).toBe(200);
    expect(b.remainingNow).toBe(800);
  });

  it('separates the working-day rate from the calendar-day rate', () => {
    // 200 credits on each of two days, across a ten-day window.
    const b = computeBurndown({
      balance: 2000,
      asOf: '2026-09-01',
      days: [day('2026-09-01', 200), day('2026-09-10', 200)],
      today: '2026-09-10',
    });
    expect(b.ratePerActiveDay).toBe(200);
    expect(b.activeDayDensity).toBeCloseTo(2 / 10, 5);
    expect(b.ratePerCalendarDay).toBeCloseTo(40, 5);

    // Runway in calendar days uses the calendar rate, not the working one.
    expect(b.activeDaysRemaining).toBeCloseTo(1600 / 200, 5);
    expect(b.daysRemaining).toBeCloseTo(1600 / 40, 5);
  });

  it('projects a date and lands the line on zero', () => {
    const b = computeBurndown({
      balance: 300,
      asOf: '2026-09-01',
      days: [day('2026-09-01', 100)],
      today: '2026-09-01',
    });
    expect(b.status).toBe('ok');
    expect(b.exhaustionDate).not.toBeNull();
    expect(b.series.at(-1)!.remaining).toBe(0);
    expect(b.series.at(-1)!.kind).toBe('projected');
    // Actual points never run past today.
    expect(b.series.filter((p) => p.kind === 'actual').every((p) => p.day <= '2026-09-01')).toBe(true);
  });

  it('reports an overspent balance rather than projecting into the negative', () => {
    const b = computeBurndown({
      balance: 100,
      asOf: '2026-09-01',
      days: [day('2026-09-01', 250)],
      today: '2026-09-01',
    });
    expect(b.status).toBe('exhausted');
    expect(b.remainingNow).toBe(-150);
    expect(b.exhaustionDate).toBeNull();
    expect(b.series.every((p) => p.kind === 'actual')).toBe(true);
  });

  it('says so when there is nothing to estimate a rate from', () => {
    const b = computeBurndown({
      balance: 1000,
      asOf: '2026-09-01',
      days: [day('2026-09-01', null)],
      today: '2026-09-01',
    });
    expect(b.status).toBe('no-data');
    expect(b.ratePerActiveDay).toBeNull();
    expect(b.daysRemaining).toBeNull();
  });

  it('runs on the real fixture', () => {
    const r = runPipeline(FIXTURE);
    const days = r.days.map((d) => computeDayMetrics(sliceFromParse(r, d.day), CTX));
    const b = computeBurndown({
      balance: 100_000,
      asOf: '2026-09-23',
      days,
      today: '2026-09-24',
    });
    expect(b.spentSinceAsOf).toBeCloseTo(15543.87, 0);
    expect(b.remainingNow).toBeCloseTo(84456.13, 0);
    expect(b.ratePerActiveDay).toBeCloseTo(7771.94, 0);
    // Both days were worked, so calendar and working rates coincide here.
    expect(b.ratePerCalendarDay).toBeCloseTo(7771.94, 0);
    expect(b.exhaustionDate).not.toBeNull();
  });
});
