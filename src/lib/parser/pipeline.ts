/**
 * The parsing pipeline (SPEC.md §10).
 *
 * A pure function of (text, settings) — no clock, no randomness, no I/O — so
 * re-parsing is deterministic and the whole thing is directly testable.
 */

import { dayKey } from '../time';
import { median } from '../metrics/stats';
import { fingerprintEvent, scanTranscript } from './scan';
import { extractCycleType, extractTag, resolveBoundaries, scoreOrchestratorMessage, type Scored } from './cycles';
import { detectLanguage, isLanguageRequest } from './language';
import {
  DEFAULT_PLATFORM_ERROR_RULES,
  DEFAULT_ROLE_MAP,
  PARSER_VERSION,
  type DayCoverage,
  type ParseResult,
  type ParseSettings,
  type ParseWarning,
  type ParsedCycle,
  type ParsedDrift,
  type ParsedEvent,
  type ParsedOperatorTurn,
  type ParsedPlatformError,
  type RoleClass,
} from './types';

export const DEFAULT_SETTINGS: ParseSettings = {
  timezone: 'UTC',
  workingLanguage: 'en',
  answerThreshold: 600,
  roleMap: {},
  overrides: {},
  platformErrorRules: DEFAULT_PLATFORM_ERROR_RULES,
};

function classifyRole(role: string, map: Record<string, RoleClass>): RoleClass {
  const key = role.trim().toLowerCase();
  return map[key] ?? DEFAULT_ROLE_MAP[key] ?? 'worker';
}

/**
 * Sum recorded credits, returning null when none of the events carry them.
 * Null and zero are different: an export without credit data must not read as
 * a free day.
 */
function sumCredits(events: Array<{ credits: number | null }>): number | null {
  const known = events.filter((e) => e.credits !== null);
  if (known.length === 0) return null;
  return known.reduce((a, e) => a + (e.credits as number), 0);
}

function excerpt(body: string, n = 180): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export function runPipeline(text: string, partial: Partial<ParseSettings> = {}): ParseResult {
  const settings: ParseSettings = { ...DEFAULT_SETTINGS, ...partial };
  const scan = scanTranscript(text);
  const warnings: ParseWarning[] = [...scan.warnings];
  const rolesObserved: Record<string, RoleClass> = {};

  // --- 3. Normalise -------------------------------------------------------
  const events: ParsedEvent[] = scan.events.map((e) => {
    const roleClass = classifyRole(e.role, settings.roleMap);
    rolesObserved[e.role] = roleClass;
    const det = e.kind === 'message' ? detectLanguage(e.body) : { language: null, confidence: 0 };
    return {
      seq: e.seq,
      tsUtc: e.tsUtc,
      day: dayKey(e.tsUtc, settings.timezone),
      role: e.role,
      roleClass,
      kind: e.kind,
      body: e.body,
      bodyChars: e.body.length,
      actionCount: e.actionCount,
      credits: e.credits,
      model: e.model,
      fingerprint: fingerprintEvent(e.tsUtc.toISOString(), e.role, e.kind, e.body),
      detectedLanguage: det.language,
      languageConfidence: det.confidence,
      boundary: 'neither',
    };
  });

  if (events.length === 0) {
    return {
      parserVersion: PARSER_VERSION,
      transcriptRef: scan.transcriptRef,
      declaredRangeText: scan.declaredRangeText,
      declaredMessageCount: scan.declaredMessageCount,
      declaredCredits: scan.declaredCredits,
      declaredModels: scan.declaredModels,
      events: [],
      cycles: [],
      operatorTurns: [],
      drifts: [],
      platformErrors: [],
      days: [],
      rolesObserved,
      englishRequests: 0,
      englishRequestSeqs: [],
      warnings,
      firstEventAt: null,
      lastEventAt: null,
    };
  }

  for (const role of Object.keys(rolesObserved)) {
    const known =
      settings.roleMap[role.toLowerCase()] !== undefined ||
      DEFAULT_ROLE_MAP[role.toLowerCase()] !== undefined;
    if (!known) {
      warnings.push({
        code: 'unknown-role',
        message: `Role "${role}" was not recognised and has been mapped to "worker". Set it in project settings if that is wrong.`,
      });
    }
  }

  // --- 7. Resolve cycles --------------------------------------------------
  // Runs over the whole transcript in timestamp order, not per day, so a
  // dispatch before midnight still pairs with its close-out after it.
  const orchMessages = events.filter((e) => e.roleClass === 'orchestrator' && e.kind === 'message');
  const scored: Scored[] = orchMessages.map((e, i) => {
    const prevThinkBodies = events
      .slice(Math.max(0, e.seq - 3), e.seq)
      .map((p) => p.body);
    const nextBodies = events.slice(e.seq + 1, e.seq + 4).map((n) => ({
      body: n.body,
      isOperatorMessage: n.roleClass === 'operator' && n.kind === 'message',
      isOrchestratorThink: n.roleClass === 'orchestrator' && n.kind === 'think',
    }));
    const s = scoreOrchestratorMessage({ seq: e.seq, body: e.body, prevThinkBodies, nextBodies });
    return { index: i, seq: e.seq, ...s };
  });

  const resolutions = resolveBoundaries(scored, settings.overrides);
  const bySeq = new Map(resolutions.map((r) => [r.seq, r]));
  for (const e of events) {
    const r = bySeq.get(e.seq);
    if (r) e.boundary = r.role;
  }

  // --- 8. Classify operator turns ----------------------------------------
  const operatorTurns: ParsedOperatorTurn[] = events
    .filter((e) => e.roleClass === 'operator' && e.kind === 'message')
    .map((e) => ({
      seq: e.seq,
      day: e.day,
      tsUtc: e.tsUtc,
      chars: e.bodyChars,
      classification: e.bodyChars < settings.answerThreshold ? ('answer' as const) : ('dispatch' as const),
      excerpt: excerpt(e.body),
      cycleTag: null,
    }));

  // --- Pair dispatches with close-outs ------------------------------------
  const ordered = resolutions.slice().sort((a, b) => a.seq - b.seq);
  const cycles: ParsedCycle[] = [];
  let unmatchedCloseouts = 0;

  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].role !== 'dispatch') {
      if (cycles.length === 0 || ordered[i - 1]?.role === 'closeout') unmatchedCloseouts++;
      continue;
    }
    const dispatch = events[ordered[i].seq];
    const next = ordered[i + 1];
    const closeout = next && next.role === 'closeout' ? events[next.seq] : null;

    // An open cycle ends at the next dispatch, not at the end of the file.
    // Running it to the end would count the rest of the transcript as this
    // cycle's work, and with several open cycles the same events would be
    // counted once per cycle — inflating step counts without bound.
    const endSeq = closeout
      ? closeout.seq
      : (ordered.slice(i + 1).find((r) => r.role === 'dispatch')?.seq ?? events.length);

    const inner = events.filter((e) => e.seq > dispatch.seq && e.seq < endSeq);
    const reasoningSteps = inner.filter((e) => e.kind === 'think' && e.roleClass !== 'operator').length;
    const toolActions = inner.reduce((a, e) => a + e.actionCount, 0);
    const answers = inner.filter(
      (e) => e.roleClass === 'operator' && e.kind === 'message' && e.bodyChars < settings.answerThreshold,
    );

    // Step latency: gaps between consecutive agent events inside the cycle.
    // Cross-boundary gaps are operator wait, not agent latency, so they are out.
    const agentEvents = [dispatch, ...inner.filter((e) => e.roleClass !== 'operator')];
    if (closeout) agentEvents.push(closeout);
    const gaps: number[] = [];
    for (let k = 1; k < agentEvents.length; k++) {
      gaps.push((agentEvents[k].tsUtc.getTime() - agentEvents[k - 1].tsUtc.getTime()) / 1000);
    }

    // Authorisation: was there an operator dispatch between the previous
    // close-out and this one? If not, it arrived as an attachment (§5.7).
    const prevCloseoutSeq = cycles.length ? (cycles[cycles.length - 1].closeoutSeq ?? -1) : -1;
    const authorising = events.find(
      (e) =>
        e.seq > prevCloseoutSeq &&
        e.seq < dispatch.seq &&
        e.roleClass === 'operator' &&
        e.kind === 'message' &&
        e.bodyChars >= settings.answerThreshold,
    );

    const durationS = closeout
      ? Math.round((closeout.tsUtc.getTime() - dispatch.tsUtc.getTime()) / 1000)
      : null;

    cycles.push({
      tag: extractTag(dispatch.body, cycles.length),
      cycleType: extractCycleType(dispatch.body),
      day: dispatch.day, // a midnight-crossing cycle belongs wholly to its start day
      dispatchSeq: dispatch.seq,
      closeoutSeq: closeout ? closeout.seq : null,
      startedAt: dispatch.tsUtc,
      endedAt: closeout ? closeout.tsUtc : null,
      durationS,
      dispatchChars: dispatch.bodyChars,
      operatorDispatchChars: authorising ? authorising.bodyChars : null,
      reasoningSteps,
      toolActions,
      operatorAnswers: answers.length,
      credits: sumCredits([dispatch, ...inner, ...(closeout ? [closeout] : [])]),
      medianStepLatencyS: gaps.length ? median(gaps) : null,
      halted: closeout ? /\bhalt(ed)?\b/i.test(closeout.body.slice(0, 400)) : false,
      authorisationRecorded: Boolean(authorising),
      classificationConfidence: Math.min(
        ordered[i].confidence,
        next && next.role === 'closeout' ? next.confidence : 1,
      ),
      isOpen: !closeout,
    });
  }

  if (unmatchedCloseouts > 0) {
    warnings.push({
      code: 'unmatched-closeout',
      message: `${unmatchedCloseouts} close-out message(s) had no preceding dispatch; they are excluded from cycle statistics.`,
    });
  }
  const openCycles = cycles.filter((c) => c.isOpen).length;
  if (openCycles > 0) {
    warnings.push({
      code: 'open-cycle',
      message: `${openCycles} dispatch(es) had no close-out before the end of the file. They are counted but excluded from duration statistics.`,
    });
  }
  const lowConfidence = cycles.filter((c) => c.classificationConfidence < 0.7).length;
  if (lowConfidence > 0) {
    warnings.push({
      code: 'low-confidence',
      message: `${lowConfidence} cycle boundary/boundaries were classified with low confidence. Review them on the transcript screen.`,
    });
  }

  // Attribute operator answers to the cycle they landed inside.
  for (const turn of operatorTurns) {
    if (turn.classification !== 'answer') continue;
    const c = cycles.find(
      (cy) => turn.seq > cy.dispatchSeq && (cy.closeoutSeq === null || turn.seq < cy.closeoutSeq),
    );
    turn.cycleTag = c ? c.tag : null;
  }

  // --- 9a. Platform errors (§5.8) ----------------------------------------
  const platformErrors: ParsedPlatformError[] = [];
  const COLLAPSE_WINDOW_S = 120;
  for (const rule of settings.platformErrorRules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      warnings.push({ code: 'bad-rule', message: `Platform-error rule "${rule.id}" has an invalid pattern.` });
      continue;
    }
    let lastAt = -Infinity;
    for (const e of events) {
      if (!re.test(e.body)) continue;
      const t = e.tsUtc.getTime() / 1000;
      if (t - lastAt < COLLAPSE_WINDOW_S) continue; // collapse a burst into one incident
      lastAt = t;
      platformErrors.push({
        seq: e.seq,
        day: e.day,
        tsUtc: e.tsUtc,
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        excerpt: excerpt(e.body),
      });
    }
  }

  // --- 9b. Language drift (§5.9) -----------------------------------------
  //
  // "Times you asked for English" counts the operator asking. Every dispatch
  // carries a standing `Working language: English` line; counting that would
  // report the boilerplate rather than anyone actually intervening.
  const englishRequestSeqs = events
    .filter(
      (e) =>
        e.kind === 'message' &&
        e.roleClass === 'operator' &&
        isLanguageRequest(e.body, settings.workingLanguage),
    )
    .map((e) => e.seq);
  const englishRequests = englishRequestSeqs.length;

  // A worker's last message inside a cycle is its report — the close-out that
  // the orchestrator then relays. Drift there is the finding, so it is classed
  // as a close-out rather than internal chatter.
  const workerReportSeqs = new Set<number>();
  for (const c of cycles) {
    const end = c.closeoutSeq ?? events.length;
    let lastWorkerMessage = -1;
    for (const e of events) {
      if (e.seq <= c.dispatchSeq) continue;
      if (e.seq >= end) break;
      if (e.roleClass === 'worker' && e.kind === 'message') lastWorkerMessage = e.seq;
    }
    if (lastWorkerMessage >= 0) workerReportSeqs.add(lastWorkerMessage);
  }

  const dispatchSeqs = new Set(cycles.map((c) => c.dispatchSeq));
  const drifts: ParsedDrift[] = [];

  for (const e of events) {
    if (e.kind !== 'message' || e.roleClass === 'operator') continue;
    if (!e.detectedLanguage || e.detectedLanguage === settings.workingLanguage) continue;
    if ((e.languageConfidence ?? 0) < 0.3) continue;

    // Challenged if someone asks for the working language within the next 3
    // messages AND before the next dispatch. The next dispatch bounds the
    // window deliberately: its standing language line is not a challenge to
    // the drift that preceded it — nobody intervened, the next cycle simply began.
    const nextDispatchSeq = cycles.find((c) => c.dispatchSeq > e.seq)?.dispatchSeq ?? Infinity;
    let challengeSeq: number | null = null;
    let seen = 0;
    for (const n of events) {
      if (n.seq <= e.seq) continue;
      if (n.seq >= nextDispatchSeq || seen >= 3) break;
      if (n.kind !== 'message') continue;
      seen++;
      if (isLanguageRequest(n.body, settings.workingLanguage)) {
        challengeSeq = n.seq;
        break;
      }
    }

    drifts.push({
      seq: e.seq,
      day: e.day,
      tsUtc: e.tsUtc,
      detectedLanguage: e.detectedLanguage,
      eventClass: dispatchSeqs.has(e.seq)
        ? 'dispatch'
        : e.boundary === 'closeout' || workerReportSeqs.has(e.seq)
          ? 'closeout'
          : 'internal',
      role: e.role,
      challenged: challengeSeq !== null,
      challengeSeq,
      excerpt: excerpt(e.body),
    });
  }

  // --- 4. Partition by day ------------------------------------------------
  const dayMap = new Map<string, DayCoverage>();
  for (const e of events) {
    let d = dayMap.get(e.day);
    if (!d) {
      d = { day: e.day, eventCount: 0, cycleCount: 0, fingerprints: [] };
      dayMap.set(e.day, d);
    }
    d.eventCount++;
    d.fingerprints.push(e.fingerprint);
  }
  for (const c of cycles) {
    const d = dayMap.get(c.day);
    if (d) d.cycleCount++;
  }
  const days = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  return {
    parserVersion: PARSER_VERSION,
    transcriptRef: scan.transcriptRef,
    declaredRangeText: scan.declaredRangeText,
    declaredMessageCount: scan.declaredMessageCount,
    declaredCredits: scan.declaredCredits,
    declaredModels: scan.declaredModels,
    events,
    cycles,
    operatorTurns,
    drifts,
    platformErrors,
    days,
    rolesObserved,
    englishRequests,
    englishRequestSeqs,
    warnings,
    firstEventAt: events[0].tsUtc,
    lastEventAt: events[events.length - 1].tsUtc,
  };
}
