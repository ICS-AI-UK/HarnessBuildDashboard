/**
 * Documents written by earlier versions must keep working.
 *
 * The shape of a stored project grows as features land, so a record saved
 * before a field existed is simply missing that key. `undefined` is not `null`,
 * and a guard written as `x !== null` passes for a missing key — which is how a
 * deployed build threw `Cannot read properties of undefined (reading 'split')`
 * from inside the date arithmetic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __setStore } from '../src/lib/store';
import { computeBurndown } from '../src/lib/metrics/burndown';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hbd-legacy-'));
  process.env.STORAGE_DRIVER = 'filesystem';
  process.env.STORAGE_DIR = dir;
  __setStore(null);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STORAGE_DIR;
  delete process.env.STORAGE_DRIVER;
});

/** A project exactly as an earlier version wrote it: no credit fields at all. */
const LEGACY_PROJECT = {
  slug: 'legacy',
  name: 'Legacy',
  description: null,
  colour: '#1d4ed8',
  workingLanguage: 'en',
  timezone: 'UTC',
  answerThreshold: 600,
  minCyclesForAverage: 5,
  roleMap: {},
  archivedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('a project saved before the credit fields existed', () => {
  it('reads back with those fields as null, not undefined', async () => {
    const { getStore, keys } = await import('../src/lib/store');
    const { getProject } = await import('../src/lib/repo');

    const store = await getStore();
    await store.setJSON(keys.project('legacy'), LEGACY_PROJECT);

    const p = (await getProject('legacy'))!;
    expect(p.creditBalance).toBeNull();
    expect(p.creditBalanceAsOf).toBeNull();

    // The guard the project page uses must now reject it.
    expect(p.creditBalance != null && p.creditBalanceAsOf != null).toBe(false);
  });

  it('survives a document missing almost everything', async () => {
    const { getStore, keys } = await import('../src/lib/store');
    const { getProject } = await import('../src/lib/repo');

    const store = await getStore();
    await store.setJSON(keys.project('sparse'), { slug: 'sparse' });

    const p = (await getProject('sparse'))!;
    expect(p.timezone).toBe('UTC');
    expect(p.workingLanguage).toBe('en');
    expect(p.answerThreshold).toBe(600);
    expect(p.roleMap).toEqual({});
    expect(p.name).toBe('sparse');
  });

  it('lists legacy projects without crashing', async () => {
    const { listProjects } = await import('../src/lib/repo');
    const all = await listProjects(true);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.every((p) => p.creditBalanceAsOf === null)).toBe(true);
  });

  it('normalises portfolio settings the same way', async () => {
    const { getStore, keys } = await import('../src/lib/store');
    const { getPortfolioSettings } = await import('../src/lib/repo');

    const store = await getStore();
    await store.setJSON(keys.portfolio(), {});
    const s = await getPortfolioSettings();
    expect(s.creditBalance).toBeNull();
    expect(s.creditBalanceAsOf).toBeNull();
  });
});

describe('the burndown refuses unusable input instead of throwing', () => {
  it('handles an undefined balance date', () => {
    // This is the exact call the deployed page made.
    const b = computeBurndown({
      balance: undefined as unknown as number,
      asOf: undefined as unknown as string,
      days: [],
      today: '2026-09-24',
    });
    expect(b.status).toBe('no-data');
    expect(b.series).toEqual([]);
    expect(b.daysRemaining).toBeNull();
  });

  it('handles a malformed balance date', () => {
    const b = computeBurndown({
      balance: 1000,
      asOf: 'not-a-date',
      days: [],
      today: '2026-09-24',
    });
    expect(b.status).toBe('no-data');
    expect(b.remainingNow).toBe(1000);
  });

  it('still works on valid input', () => {
    const b = computeBurndown({
      balance: 1000,
      asOf: '2026-09-23',
      days: [{ day: '2026-09-23', credits: 100, activeDays: 1 } as never],
      today: '2026-09-23',
    });
    expect(b.status).toBe('ok');
    expect(b.remainingNow).toBe(900);
  });
});
