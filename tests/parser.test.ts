/**
 * Golden-file tests (SPEC.md §11.1).
 *
 * The supplied transcript is the fixture and its derived values are asserted.
 * Any pipeline change that moves these numbers has to move them deliberately.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/lib/parser/pipeline';
import { scanTranscript } from '../src/lib/parser/scan';
import { computeDayMetrics } from '../src/lib/metrics/compute';
import { sliceFromParse } from '../src/lib/metrics/slice';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/workbench-2026-09-21.md'), 'utf8');

describe('scanner', () => {
  it('reads the preamble without trusting it for bucketing', () => {
    const s = scanTranscript(FIXTURE);
    expect(s.transcriptRef).toBe('e5ab9fac8b0647539a15aa97b04bff10');
    expect(s.declaredMessageCount).toBe(645);
  });

  it('parses every event header', () => {
    const s = scanTranscript(FIXTURE);
    expect(s.events.length).toBe(612);
  });

  it('warns when the declared count disagrees with the parsed count', () => {
    const s = scanTranscript(FIXTURE);
    expect(s.warnings.map((w) => w.code)).toContain('count-mismatch');
  });

  it('ignores headers inside fenced code blocks', () => {
    const text = [
      '# Chat transcript: test',
      '',
      '### 2026-01-01T09:00:00.000Z — Team Leader (X) [message]',
      'Body with a quoted transcript:',
      '```',
      '### 2026-01-01T09:30:00.000Z — Engineer (X) [think]',
      'this is quoted, not an event',
      '```',
      'and the body continues.',
      '',
      '### 2026-01-01T10:00:00.000Z — Team Leader (X) [message]',
      'CYCLE A-1 is done.',
    ].join('\n');
    const s = scanTranscript(text);
    expect(s.events.length).toBe(2);
  });

  it('sorts out-of-order events and says so', () => {
    const text = [
      '### 2026-01-01T10:00:00.000Z — Engineer (X) [think]',
      'second',
      '',
      '### 2026-01-01T09:00:00.000Z — Engineer (X) [think]',
      'first',
    ].join('\n');
    const s = scanTranscript(text);
    expect(s.events[0].body).toBe('first');
    expect(s.warnings.map((w) => w.code)).toContain('out-of-order');
  });
});

describe('pipeline — golden values for the sample transcript', () => {
  const r = runPipeline(FIXTURE);

  it('maps the three observed roles', () => {
    expect(r.rolesObserved).toEqual({
      'Team Leader': 'orchestrator',
      Engineer: 'worker',
      User: 'operator',
    });
  });

  it('resolves 24 cycles, none open', () => {
    expect(r.cycles.length).toBe(24);
    expect(r.cycles.filter((c) => c.isOpen).length).toBe(0);
  });

  it('names cycles from their dispatch tag', () => {
    const tags = r.cycles.map((c) => c.tag);
    expect(tags).toContain('SEED-1');
    expect(tags).toContain('AREA-4');
    expect(tags).toContain('MAPX-2');
  });

  it('counts 456 in-cycle reasoning steps', () => {
    const steps = r.cycles.reduce((a, c) => a + c.reasoningSteps, 0);
    expect(steps).toBe(456);
  });

  it('finds exactly one mid-work operator answer', () => {
    const answers = r.operatorTurns.filter((t) => t.classification === 'answer');
    expect(answers.length).toBe(1);
    expect(answers[0].excerpt).toBe('Submitted');
    expect(r.operatorTurns.filter((t) => t.classification === 'dispatch').length).toBe(18);
  });

  it('covers exactly one day', () => {
    expect(r.days.map((d) => d.day)).toEqual(['2026-09-21']);
    expect(r.days[0].cycleCount).toBe(24);
  });

  it('detects the French drift, and finds it is all close-out reports', () => {
    expect(r.drifts.length).toBe(12);
    expect(r.drifts.every((d) => d.detectedLanguage === 'fr')).toBe(true);
    // The finding: every drift is a close-out report — the verdicts the day's
    // decisions rest on — not internal chatter.
    expect(r.drifts.every((d) => d.eventClass === 'closeout')).toBe(true);
  });

  it('does not count standing dispatch boilerplate as a challenge', () => {
    // Every dispatch carries "Working language: English". That is not somebody
    // intervening, so the drifts stay unchallenged.
    expect(r.englishRequests).toBe(1);
    expect(r.drifts.filter((d) => !d.challenged).length).toBe(11);
  });

  it('parses the cycle type out of the dispatch', () => {
    const types = r.cycles.map((c) => c.cycleType);
    expect(types.filter((t) => t === 'BUILD').length).toBeGreaterThan(0);
    expect(types.filter((t) => t === 'MIXED').length).toBeGreaterThan(0);
    expect(types.filter((t) => t === 'INVESTIGATION').length).toBeGreaterThan(0);
  });

  it('records a clean platform day', () => {
    expect(r.platformErrors.length).toBe(0);
  });

  it('flags cycles whose authorisation arrived as an attachment', () => {
    const unrecorded = r.cycles.filter((c) => !c.authorisationRecorded);
    expect(unrecorded.length).toBeGreaterThan(0);
    expect(unrecorded.length).toBeLessThan(r.cycles.length);
  });
});

describe('metrics — golden values for the sample transcript', () => {
  const r = runPipeline(FIXTURE);
  const m = computeDayMetrics(sliceFromParse(r, '2026-09-21'), {
    timezone: 'UTC',
    workingLanguage: 'en',
  });

  it('reports the headline counts', () => {
    expect(m.cycles).toBe(24);
    expect(m.reasoningSteps).toBe(456);
    expect(m.platformErrors).toBe(0);
  });

  it('computes cycle duration percentiles', () => {
    // R-7 interpolation (SPEC.md §4), not nearest-rank.
    expect(m.medianCycleMin.value).toBeCloseTo(7.01, 1);
    expect(m.p90CycleMin.value).toBeCloseTo(10.41, 1);
    expect(m.longestCycleMin.value).toBeCloseTo(11.25, 1);
  });

  it('computes step latency in the reference band', () => {
    expect(m.stepLatencyS.value).toBeGreaterThan(5);
    expect(m.stepLatencyS.value).toBeLessThan(25);
  });

  it('finds no relationship between dispatch length and duration', () => {
    expect(Math.abs(m.dispatchLengthVsDuration.value!)).toBeLessThan(0.5);
  });

  it('finds a strong relationship between work size and duration', () => {
    // 0.74 on this transcript. The reference report quotes +0.99/+0.96 for its
    // own pooled dataset; what matters is the contrast with dispatch length.
    expect(m.stepsVsDuration.value!).toBeGreaterThan(0.6);
    expect(m.stepsVsDuration.value!).toBeGreaterThan(
      Math.abs(m.dispatchLengthVsDuration.value!) + 0.5,
    );
  });

  it('partitions the elapsed day into bands that sum to the window', () => {
    const total = m.elapsed.inCycleS + m.elapsed.operatorWaitS + m.elapsed.otherS;
    expect(total).toBeCloseTo(m.elapsed.windowS, 0);
  });

  it('attributes about three hours to operator wait', () => {
    expect(m.elapsed.operatorWaitS / 60).toBeGreaterThan(150);
    expect(m.elapsed.operatorWaitS / 60).toBeLessThan(200);
  });
});
