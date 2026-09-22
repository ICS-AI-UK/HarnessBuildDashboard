/**
 * The insight rules (SPEC.md §5.10) — "four things worth doing".
 *
 * Deterministic rules over computed figures. No model is involved: everything
 * on this dashboard has to be reproducible from the transcript alone.
 */

import type { RangeMetrics } from './metrics/aggregate';

export type Insight = {
  id: string;
  headline: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
  href?: string;
};

export type InsightContext = {
  portfolioInterruptionRate: number | null; // 0..1
  slug?: string;
  day?: string;
};

export function buildInsights(m: RangeMetrics, ctx: InsightContext = { portfolioInterruptionRate: null }): Insight[] {
  const out: Insight[] = [];
  const base = ctx.slug ? (ctx.day ? `/p/${ctx.slug}/d/${ctx.day}` : `/p/${ctx.slug}`) : undefined;

  if (m.driftsUnchallenged > 0) {
    out.push({
      id: 'halt-on-drift',
      headline: 'Halt on language drift',
      detail: `${m.drifts} drift${m.drifts === 1 ? '' : 's'}, ${m.driftsUnchallenged} unchallenged. The harness does not stop on it.`,
      severity: m.driftsUnchallenged >= 5 ? 'high' : 'medium',
      href: base ? `${base}#drift` : undefined,
    });
  }

  if (m.cycles > 0 && m.unrecordedAuthorisations / m.cycles > 0.1) {
    const pct = Math.round((m.unrecordedAuthorisations / m.cycles) * 100);
    out.push({
      id: 'paste-dispatches',
      headline: 'Paste dispatches, do not attach them',
      detail: `${m.unrecordedAuthorisations} of ${m.cycles} cycles (${pct}%) cite an authorisation that is not in the record. Pasting makes it auditable and the relay verifiable, at no extra effort.`,
      severity: pct > 25 ? 'high' : 'medium',
      href: base ? `${base}#audit` : undefined,
    });
  }

  const rate = m.interruptionRate.value;
  if (rate !== null && ctx.portfolioInterruptionRate !== null && rate - ctx.portfolioInterruptionRate > 0.1) {
    out.push({
      id: 'interruptions',
      headline: 'Find why this harness interrupts',
      detail: `${Math.round(rate * 100)}% of operator turns were interruptions, against ${Math.round(
        ctx.portfolioInterruptionRate * 100,
      )}% across the portfolio.`,
      severity: 'high',
      href: base ? `${base}#interruptions` : undefined,
    });
  }

  const r = m.dispatchLengthVsDuration;
  if (r.value !== null && Math.abs(r.value) < 0.2) {
    out.push({
      id: 'write-in-full',
      headline: 'Keep writing dispatches in full',
      detail: `Dispatch length predicts nothing (r = ${r.value.toFixed(2)} over ${r.n} cycles${
        m.dispatchCharsMin !== null
          ? `, ${m.dispatchCharsMin.toLocaleString()}–${m.dispatchCharsMax!.toLocaleString()} characters`
          : ''
      }). Detail costs drafting time, not cycle time.`,
      severity: 'low',
      href: base ? `${base}#complexity` : undefined,
    });
  }

  if (m.platformErrors === 0 && m.cycles > 0) {
    out.push({
      id: 'clean-platform',
      headline: 'The platform had a clean run',
      detail: `No overload, container failure, quota or corruption across ${m.cycles} cycles.`,
      severity: 'low',
    });
  }

  if (m.elapsed.windowS > 0) {
    const waitPct = Math.round((m.elapsed.operatorWaitS / m.elapsed.windowS) * 100);
    if (waitPct >= 35) {
      out.push({
        id: 'operator-wait',
        headline: 'Most of the elapsed time is waiting for you',
        detail: `${Math.round(m.elapsed.operatorWaitS / 60)} minutes (${waitPct}%) sat between a finished report and the next instruction. It is the largest block of elapsed time, and it is not an agent cost.`,
        severity: 'medium',
        href: base ? `${base}#elapsed` : undefined,
      });
    }
  }

  return out;
}
