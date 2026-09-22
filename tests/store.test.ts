/**
 * Store and ingest round-trip, against the filesystem driver.
 *
 * The same code path runs on Netlify Blobs, so what this proves about
 * aggregates and overlap resolution holds in both environments.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __setStore } from '../src/lib/store';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hbd-'));
  process.env.STORAGE_DRIVER = 'filesystem';
  process.env.STORAGE_DIR = dir;
  __setStore(null);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STORAGE_DIR;
  delete process.env.STORAGE_DRIVER;
});

const FIXTURE = readFileSync(join(__dirname, 'fixtures/workbench-2026-09-21.md'), 'utf8');

function project(slug = 'test') {
  const now = new Date().toISOString();
  return {
    slug,
    name: 'Test',
    description: null,
    colour: '#1d4ed8',
    workingLanguage: 'en',
    timezone: 'UTC',
    answerThreshold: 600,
    minCyclesForAverage: 5,
    roleMap: {},
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('document store', () => {
  it('round-trips text and JSON', async () => {
    const { getStore } = await import('../src/lib/store');
    const store = await getStore();
    expect(store.driver).toBe('filesystem');

    await store.setText('raw/a/b.md', 'hello');
    expect(await store.getText('raw/a/b.md')).toBe('hello');

    await store.setJSON('projects/x.json', { a: 1 });
    expect(await store.getJSON('projects/x.json')).toEqual({ a: 1 });

    expect(await store.getText('missing/key')).toBeNull();
    expect(await store.getJSON('missing/key')).toBeNull();
  });

  it('lists by prefix and deletes', async () => {
    const { getStore } = await import('../src/lib/store');
    const store = await getStore();
    await store.setJSON('days/p/2026-09-01.json', {});
    await store.setJSON('days/p/2026-09-02.json', {});
    await store.setJSON('days/q/2026-09-01.json', {});

    expect((await store.list('days/p/')).sort()).toEqual([
      'days/p/2026-09-01.json',
      'days/p/2026-09-02.json',
    ]);

    await store.delete('days/p/2026-09-01.json');
    expect(await store.list('days/p/')).toEqual(['days/p/2026-09-02.json']);
  });
});

describe('ingest stores aggregates, not events', () => {
  it('imports the sample transcript and computes the golden figures', async () => {
    const { saveProject } = await import('../src/lib/repo');
    const { commit } = await import('../src/lib/ingest');
    const { getRange } = await import('../src/lib/queries');

    const p = project('golden');
    await saveProject(p);
    const result = await commit(p, 'workbench.md', FIXTURE);

    expect(result.imported).toEqual(['2026-09-21']);

    const m = await getRange('golden', '2026-09-21', '2026-09-21');
    expect(m.cycles).toBe(24);
    expect(m.reasoningSteps).toBe(456);
    expect(m.operatorAnswers).toBe(1);
    expect(m.drifts).toBe(12);
    expect(m.driftsUnchallenged).toBe(11);
    expect(m.languageRequests).toBe(1);
    expect(m.medianCycleMin.value).toBeCloseTo(7.01, 1);
  });

  it('writes a handful of documents rather than a row per event', async () => {
    const { getStore } = await import('../src/lib/store');
    const store = await getStore();
    const written = (await store.list('')).filter((k) => k.includes('golden'));
    // One project, one transcript record, one raw transcript, one day.
    // 612 events, 4 documents.
    expect(written.length).toBeLessThan(10);
  });

  it('rebuilds event-level evidence on demand from the stored transcript', async () => {
    const { getProject } = await import('../src/lib/repo');
    const { reparse } = await import('../src/lib/ingest');
    const p = (await getProject('golden'))!;
    const rebuilt = await reparse(p, (await import('../src/lib/parser/scan')).sha256(FIXTURE));
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.parsed.events.length).toBe(612);
    expect(rebuilt!.parsed.cycles.length).toBe(24);
  });
});

describe('cumulative re-export does not double-count, end to end', () => {
  it('skips days already held and imports only the new ones', async () => {
    const { saveProject } = await import('../src/lib/repo');
    const { analyse, commit } = await import('../src/lib/ingest');
    const { getRange } = await import('../src/lib/queries');

    const p = project('cumulative');
    await saveProject(p);

    // Two days, then a re-export containing the same two plus a third.
    const day = (d: string, tag: string) =>
      [
        `### ${d}T09:00:00.000Z — Team Leader (ICS_AI) [message]`,
        `CYCLE ${tag} — WORK. Type: BUILD. Working language: English.`,
        '',
        `### ${d}T09:05:00.000Z — Engineer (ICS_AI) [think]`,
        'Thinking about it.',
        '',
        `### ${d}T09:20:00.000Z — Team Leader (ICS_AI) [message]`,
        `${tag} is done. Verdict: fine.`,
        '',
      ].join('\n');

    const first = ['# Chat transcript: w1', '', day('2026-08-03', 'A-1'), day('2026-08-04', 'A-2')].join('\n');
    const cumulative = [
      '# Chat transcript: w1w2',
      '',
      day('2026-08-03', 'A-1'),
      day('2026-08-04', 'A-2'),
      day('2026-08-05', 'A-3'),
    ].join('\n');

    await commit(p, 'week1.md', first);
    const before = await getRange('cumulative', '2026-08-03', '2026-08-04');
    expect(before.cycles).toBe(2);

    const { report } = await analyse(p, 'cumulative.md', cumulative);
    expect(report.days.map((d) => `${d.day}:${d.overlapClass}`)).toEqual([
      '2026-08-03:identical',
      '2026-08-04:identical',
      '2026-08-05:new',
    ]);

    const result = await commit(p, 'cumulative.md', cumulative);
    expect(result.imported).toEqual(['2026-08-05']);
    expect(result.skipped).toEqual(['2026-08-03', '2026-08-04']);

    // The regression that protects every figure: the overlapping days read
    // exactly what they did before.
    const after = await getRange('cumulative', '2026-08-03', '2026-08-04');
    expect(after.cycles).toBe(before.cycles);
    expect(after.reasoningSteps).toBe(before.reasoningSteps);
    expect(after.medianCycleMin.value).toBe(before.medianCycleMin.value);

    const whole = await getRange('cumulative', '2026-08-03', '2026-08-05');
    expect(whole.cycles).toBe(3);
    expect(whole.activeDays).toBe(3);
  });

  it('rejects an identical file outright', async () => {
    const { getProject } = await import('../src/lib/repo');
    const { commit } = await import('../src/lib/ingest');
    const p = (await getProject('cumulative'))!;
    await expect(commit(p, 'week1-again.md', ['# Chat transcript: w1', ''].join('\n'))).rejects.toThrow();
  });
});

describe('retiring and restoring a day', () => {
  it('recomputes without re-parsing, and never counts a day twice', async () => {
    const { saveProject, getTranscript, saveTranscript, rebuildDays } = await import('../src/lib/repo');
    const { commit } = await import('../src/lib/ingest');
    const { getRange } = await import('../src/lib/queries');

    const p = project('retire');
    await saveProject(p);

    const text = [
      '# Chat transcript: r1',
      '',
      '### 2026-08-10T09:00:00.000Z — Team Leader (ICS_AI) [message]',
      'CYCLE R-1 — WORK. Type: BUILD. Working language: English.',
      '',
      '### 2026-08-10T09:10:00.000Z — Team Leader (ICS_AI) [message]',
      'R-1 is done. Verdict: fine.',
      '',
    ].join('\n');

    const { sha256 } = await commit(p, 'r1.md', text);
    expect((await getRange('retire', '2026-08-10', '2026-08-10')).cycles).toBe(1);

    const record = (await getTranscript('retire', sha256))!;
    record.days[0].contributes = false;
    await saveTranscript('retire', record);
    await rebuildDays(p, ['2026-08-10']);

    const retired = await getRange('retire', '2026-08-10', '2026-08-10');
    expect(retired.cycles).toBe(0);
    expect(retired.activeDays).toBe(0);

    record.days[0].contributes = true;
    await saveTranscript('retire', record);
    await rebuildDays(p, ['2026-08-10']);

    const restored = await getRange('retire', '2026-08-10', '2026-08-10');
    expect(restored.cycles).toBe(1);
  });
});
