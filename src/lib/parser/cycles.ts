/**
 * Cycle resolution (SPEC.md §3.2).
 *
 * Orchestrator messages alternate dispatch / close-out, but parity alone breaks
 * the moment a cycle is left open or a stray message lands between. So each
 * orchestrator message is scored from its own content and neighbourhood, and
 * the sequence is then resolved by a two-state Viterbi pass whose transition
 * penalties encode "they normally alternate" without requiring it.
 */

import type { BoundaryRole } from './types';

export type Scored = {
  index: number; // index into the orchestrator-message list
  seq: number; // index into the full event list
  dispatchScore: number;
  closeoutScore: number;
};

export type Resolution = {
  seq: number;
  role: 'dispatch' | 'closeout';
  confidence: number;
};

type ScoreInput = {
  seq: number;
  body: string;
  prevThinkBodies: string[]; // up to 3 preceding events' bodies (any kind)
  nextBodies: Array<{ body: string; isOperatorMessage: boolean; isOrchestratorThink: boolean }>;
};

const DISPATCH_TAG_RE = /^\**\s*(?:CYCLE\s+)?[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b[^\n]*—/;
const DISPATCH_FIELD_RE = /\b(Authoris|Authoriz)ation:|(?:^|\n)\s*Type:|Working language:|(?:^|\n)===\s/;
const DISPATCH_IMPERATIVE_RE = /\b(READ-ONLY|DO NOT|Plan confirmed|proceed directly|BOUNDARIES|=== REPLY ===|Budget)\b/;
const DISPATCH_THINK_RE = /\b(dispatch|registering|register|task \d+|next cycle)\b/i;

const CLOSEOUT_OPENER_RE =
  /\b(is done|are done|is complete|complete[sd]?\b|termin[ée]|clos(e|ed|ing|é|e enregistr)|halted|halt(ed)? at Step 0|is ready|delivered)\b/i;
const CLOSEOUT_LEDGER_RE = /\b(Ledger|Verdict|VERDICTS?|Budget:|files written)\b/;
const CLOSEOUT_GETTING_STARTED_RE = /getting started/i;

/** How far into the body an opener still counts as "near the start". */
const OPENER_WINDOW = 220;

export function scoreOrchestratorMessage(input: ScoreInput): {
  dispatchScore: number;
  closeoutScore: number;
} {
  const { body } = input;
  const head = body.slice(0, OPENER_WINDOW);
  let d = 0;
  let c = 0;

  if (DISPATCH_TAG_RE.test(body)) d += 1;
  if (DISPATCH_FIELD_RE.test(body)) d += 1;
  if (DISPATCH_IMPERATIVE_RE.test(body)) d += 1;
  if (input.prevThinkBodies.some((b) => DISPATCH_THINK_RE.test(b))) d += 1;

  if (CLOSEOUT_OPENER_RE.test(head)) c += 1;
  if (CLOSEOUT_LEDGER_RE.test(body)) c += 1;
  if (
    input.nextBodies.some(
      (n) => n.isOperatorMessage || (n.isOrchestratorThink && CLOSEOUT_GETTING_STARTED_RE.test(n.body)),
    )
  ) {
    c += 1;
  }

  return { dispatchScore: d, closeoutScore: c };
}

const TRANSITION: Record<string, number> = {
  'dispatch>closeout': 0,
  'closeout>dispatch': 0,
  // A dispatch followed by another dispatch means the first was left open.
  // Possible, but it should have to earn it.
  'dispatch>dispatch': -1.5,
  'closeout>closeout': -1.5,
};

/** Two-state Viterbi over the scored orchestrator messages. */
export function resolveBoundaries(
  scored: Scored[],
  overrides: Record<number, BoundaryRole> = {},
): Resolution[] {
  if (scored.length === 0) return [];

  const states: Array<'dispatch' | 'closeout'> = ['dispatch', 'closeout'];
  const emission = (i: number, s: 'dispatch' | 'closeout'): number => {
    const ov = overrides[scored[i].seq];
    if (ov === 'dispatch') return s === 'dispatch' ? 100 : -100;
    if (ov === 'closeout') return s === 'closeout' ? 100 : -100;
    return s === 'dispatch' ? scored[i].dispatchScore : scored[i].closeoutScore;
  };

  // A transcript opens with a dispatch far more often than with a close-out.
  const START_BONUS = { dispatch: 0.5, closeout: -0.5 };

  const dp: number[][] = [];
  const back: number[][] = [];
  dp.push(states.map((s) => emission(0, s) + START_BONUS[s]));
  back.push([-1, -1]);

  for (let i = 1; i < scored.length; i++) {
    const row: number[] = [];
    const bk: number[] = [];
    for (let si = 0; si < states.length; si++) {
      let best = -Infinity;
      let bestPrev = 0;
      for (let pi = 0; pi < states.length; pi++) {
        const v = dp[i - 1][pi] + TRANSITION[`${states[pi]}>${states[si]}`];
        if (v > best) {
          best = v;
          bestPrev = pi;
        }
      }
      row.push(best + emission(i, states[si]));
      bk.push(bestPrev);
    }
    dp.push(row);
    back.push(bk);
  }

  const last = dp[dp.length - 1];
  let cur = last[0] >= last[1] ? 0 : 1;
  const path: number[] = new Array(scored.length);
  for (let i = scored.length - 1; i >= 0; i--) {
    path[i] = cur;
    cur = back[i][cur];
  }

  // Backward pass, so confidence can be a real max-marginal rather than a guess
  // from this message's own wording. Most messages are ambiguous read alone and
  // decisive read in sequence; scoring them alone would flag half of a correct
  // resolution as uncertain.
  const bw: number[][] = new Array(scored.length);
  bw[scored.length - 1] = [0, 0];
  for (let i = scored.length - 2; i >= 0; i--) {
    bw[i] = states.map((s) =>
      Math.max(
        ...states.map(
          (nx, ni) => TRANSITION[`${s}>${nx}`] + emission(i + 1, nx) + bw[i + 1][ni],
        ),
      ),
    );
  }

  return scored.map((s, i) => {
    const chosenIdx = path[i];
    const marginal = (si: number) => dp[i][si] + bw[i][si];
    const margin = marginal(chosenIdx) - marginal(1 - chosenIdx);
    const confidence =
      overrides[s.seq] !== undefined ? 1 : 1 / (1 + Math.exp(-margin));
    return {
      seq: s.seq,
      role: states[chosenIdx],
      confidence: Number(confidence.toFixed(3)),
    };
  });
}

/** `CYCLE SEED-1 — ...` -> `SEED-1`; `MAP-1 READ-BACK` -> `MAP-1`. */
export function extractTag(body: string, fallbackIndex: number): string {
  const stripped = body.replace(/^\**\s*/, '');
  const m = stripped.match(/^(?:CYCLE\s+)?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b/);
  if (m && m[1].length <= 20 && !/^(THE|AND|FOR|ALL|NOT|DONE)$/.test(m[1])) return m[1];
  return `#${fallbackIndex + 1}`;
}

export function extractCycleType(body: string): string {
  // `Type:` is usually inline in the dispatch's opening sentence
  // (`CYCLE SEED-1 — RUN THE SEED. Type: BUILD (data).`), not on its own line.
  const m = body.match(/\bType:\s*\**\s*([A-Za-z ()]+)/);
  if (!m) return 'UNKNOWN';
  const raw = m[1].trim().toUpperCase();
  if (raw.startsWith('BUILD')) return 'BUILD';
  if (raw.startsWith('MIXED')) return 'MIXED';
  if (raw.startsWith('INVESTIGATION')) return 'INVESTIGATION';
  return raw.split(/\s+/)[0] || 'UNKNOWN';
}
