/**
 * Accidental duplicate and overlapping uploads.
 *
 * The question these answer: if someone uploads the same day more than once,
 * by accident or in one batch, do the figures stay right?
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __setStore } from '../src/lib/store';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hbd-batch-'));
  process.env.STORAGE_DRIVER = 'filesystem';
  process.env.STORAGE_DIR = dir;
  __setStore(null);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STORAGE_DIR;
  delete process.env.STORAGE_DRIVER;
});

function project(slug: string) {
  const now = new Date().toISOString();
  return {
    slug,
    name: slug,
    description: null,
    colour: '#1d4ed8',
    workingLanguage: 'en',
    timezone: 'UTC',
    answerThreshold: 600,
    minCyclesForAverage: 5,
    roleMap: {},
    creditBalance: null,
    creditBalanceAsOf: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** One cycle on a given day, with a tag that makes its content distinct. */
function cycleOn(day: string, tag: string, hour = 9) {
  const h = String(hour).padStart(2, '0');
  return [
    `### ${day}T${h}:00:00.000Z — Team Leader (ICS_AI) [message]`,
    `CYCLE ${tag} — WORK. Type: BUILD. Working language: English.`,
    '',
    `### ${day}T${h}:05:00.000Z — Engineer (ICS_AI) [think]`,
    `Thinking about ${tag}.`,
    '',
    `### ${day}T${h}:20:00.000Z — Team Leader (ICS_AI) [message]`,
    `${tag} is done. Verdict: fine.`,
    '',
  ].join('\n');
}

describe('the same day uploaded twice', () => {
  it('rejects a byte-identical re-upload outright', async () => {
    const { saveProject } = await import('../src/lib/repo');
    const { commit } = await import('../src/lib/ingest');
    const p = project('dup-exact');
    await saveProject(p);

    const text = ['# Chat transcript: x', '', cycleOn('2026-10-01', 'A-1')].join('\n');
    await commit(p, 'a.md', text);
    await expect(commit(p, 'a-copy.md', text)).rejects.toThrow(/already been imported/);
  });

  it('skips a differently-named file with identical content for the day', async () => {
    const { saveProject } = await import('../src/lib/repo');
    const { commit } = await import('../src/lib/ingest');
    const { getRange } = await import('../src/lib/queries');
    const p = project('dup-renamed');
    await saveProject(p);

    // Same events, different preamble, so a different file hash.
    const a = ['# Chat transcript: export-1', '', cycleOn('2026-10-01', 'A-1')].join('\n');
    const b = ['# Chat transcript: export-2', '', cycleOn('2026-10-01', 'A-1')].join('\n');

    await commit(p, 'a.md', a);
    const second = await commit(p, 'b.md', b);

    expect(second.skipped).toEqual(['2026-10-01']);
    expect(second.imported).toEqual([]);
    const m = await getRange('dup-renamed', '2026-10-01', '2026-10-01');
    expect(m.cycles).toBe(1);
    expect(m.reasoningSteps).toBe(1);
  });
});

describe('a stale resolution cannot force a double count', () => {
  /**
   * Two files covering the same day are previewed together, so both are
   * analysed before either is committed and both look "new". Committing the
   * first makes the second's stored answer wrong. The server must not honour a
   * resolution that the freshly computed overlap no longer allows.
   */
  it('ignores an import resolution once the day is already held', async () => {
    const { saveProject } = await import('../src/lib/repo');
    const { analyse, commit } = await import('../src/lib/ingest');
    const { getRange } = await import('../src/lib/queries');
    const p = project('stale');
    await saveProject(p);

    const a = ['# Chat transcript: one', '', cycleOn('2026-10-02', 'A-1')].join('\n');
    const b = ['# Chat transcript: two', '', cycleOn('2026-10-02', 'A-1')].join('\n');

    // Both previewed against an empty project: both say "new / import".
    const pa = await analyse(p, 'a.md', a);
    const pb = await analyse(p, 'b.md', b);
    expect(pa.report.days[0].defaultAction).toBe('import');
    expect(pb.report.days[0].defaultAction).toBe('import');

    await commit(p, 'a.md', a, { '2026-10-02': 'import' });
    // The stale answer from b's preview would pool an identical day.
    const second = await commit(p, 'b.md', b, { '2026-10-02': 'import' });

    expect(second.imported).toEqual([]);
    expect(second.adjusted).toContainEqual(
      expect.objectContaining({ day: '2026-10-02', requested: 'import', applied: 'skip' }),
    );

    const m = await getRange('stale', '2026-10-02', '2026-10-02');
    expect(m.cycles).toBe(1); // not 2
    expect(m.reasoningSteps).toBe(1);
  });

  it('still honours a resolution the fresh overlap allows', async () => {
    const { saveProject } = await import('../src/lib/repo');
    const { commit } = await import('../src/lib/ingest');
    const { getRange } = await import('../src/lib/queries');
    const p = project('honoured');
    await saveProject(p);

    const a = ['# Chat transcript: one', '', cycleOn('2026-10-03', 'A-1')].join('\n');
    // A superset: the same cycle plus another one later the same day.
    const b = [
      '# Chat transcript: two',
      '',
      cycleOn('2026-10-03', 'A-1'),
      cycleOn('2026-10-03', 'A-2', 14),
    ].join('\n');

    await commit(p, 'a.md', a);
    const second = await commit(p, 'b.md', b, { '2026-10-03': 'supersede' });
    expect(second.imported).toEqual(['2026-10-03']);

    // Superseded, not pooled: two cycles, not three.
    const m = await getRange('honoured', '2026-10-03', '2026-10-03');
    expect(m.cycles).toBe(2);
  });
});

describe('genuinely separate sessions on one day', () => {
  it('pools them, because they share no events', async () => {
    const { saveProject } = await import('../src/lib/repo');
    const { commit } = await import('../src/lib/ingest');
    const { getRange } = await import('../src/lib/queries');
    const p = project('sessions');
    await saveProject(p);

    const morning = ['# Chat transcript: am', '', cycleOn('2026-10-04', 'AM-1', 9)].join('\n');
    const afternoon = ['# Chat transcript: pm', '', cycleOn('2026-10-04', 'PM-1', 15)].join('\n');

    await commit(p, 'am.md', morning);
    const second = await commit(p, 'pm.md', afternoon);
    expect(second.report.days[0].overlapClass).toBe('disjoint');
    expect(second.imported).toEqual(['2026-10-04']);

    const m = await getRange('sessions', '2026-10-04', '2026-10-04');
    expect(m.cycles).toBe(2);
    expect(m.reasoningSteps).toBe(2);
  });
});
