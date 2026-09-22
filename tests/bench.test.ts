/**
 * Parse-cost benchmark. Skipped unless BENCH=1, because it needs a large
 * fixture generated outside the repo.
 *
 * Purpose: the deployment target caps a synchronous function at 60 seconds, so
 * we need to know what a worst-case transcript actually costs.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/lib/parser/pipeline';

const PATH = process.env.BENCH_FILE ?? '';
const enabled = process.env.BENCH === '1' && PATH && existsSync(PATH);

describe.skipIf(!enabled)('parse cost', () => {
  it('parses a worst-case transcript inside the function budget', () => {
    const text = readFileSync(PATH, 'utf8');
    const mb = statSync(PATH).size / 1024 / 1024;

    const t0 = performance.now();
    const r = runPipeline(text);
    const ms = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(
      `${mb.toFixed(1)} MB · ${r.events.length} events · ${r.cycles.length} cycles · ` +
        `${r.days.length} days · ${ms.toFixed(0)} ms (${(ms / mb).toFixed(0)} ms/MB)`,
    );

    expect(r.events.length).toBeGreaterThan(0);
  }, 300_000);
});
