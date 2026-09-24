export const PARSER_VERSION = '1.0.0';

export type RoleClass = 'operator' | 'orchestrator' | 'worker';
export type EventKind = 'think' | 'message';
export type BoundaryRole = 'dispatch' | 'closeout' | 'neither';

export type ParsedEvent = {
  seq: number;
  tsUtc: Date;
  day: string;
  role: string;
  roleClass: RoleClass;
  kind: EventKind;
  body: string;
  bodyChars: number;
  actionCount: number;
  /** Credits this message cost, or null when the export does not record them. */
  credits: number | null;
  /** The model that produced it, or null when the export names none. */
  model: string | null;
  fingerprint: string;
  detectedLanguage: string | null;
  languageConfidence: number | null;
  boundary: BoundaryRole;
};

export type ParsedCycle = {
  tag: string;
  cycleType: string;
  day: string;
  dispatchSeq: number;
  closeoutSeq: number | null;
  startedAt: Date;
  endedAt: Date | null;
  durationS: number | null;
  dispatchChars: number;
  operatorDispatchChars: number | null;
  reasoningSteps: number;
  toolActions: number;
  operatorAnswers: number;
  /** Credits spent between dispatch and close-out, null when not recorded. */
  credits: number | null;
  medianStepLatencyS: number | null;
  halted: boolean;
  authorisationRecorded: boolean;
  classificationConfidence: number;
  isOpen: boolean;
};

export type ParsedOperatorTurn = {
  seq: number;
  day: string;
  tsUtc: Date;
  chars: number;
  classification: 'answer' | 'dispatch';
  excerpt: string;
  cycleTag: string | null;
};

export type ParsedDrift = {
  seq: number;
  day: string;
  tsUtc: Date;
  detectedLanguage: string;
  eventClass: 'dispatch' | 'closeout' | 'internal';
  role: string;
  challenged: boolean;
  challengeSeq: number | null;
  excerpt: string;
};

export type ParsedPlatformError = {
  seq: number;
  day: string;
  tsUtc: Date;
  ruleId: string;
  label: string;
  severity: string;
  excerpt: string;
};

export type DayCoverage = {
  day: string;
  eventCount: number;
  cycleCount: number;
  fingerprints: string[];
};

export type ParseWarning = {
  code: string;
  message: string;
  seq?: number;
};

export type ParseSettings = {
  timezone: string;
  workingLanguage: string;
  answerThreshold: number;
  roleMap: Record<string, RoleClass>;
  overrides: Record<number, BoundaryRole>;
  platformErrorRules: PlatformErrorRule[];
};

export type PlatformErrorRule = {
  id: string;
  label: string;
  pattern: string;
  severity: 'low' | 'medium' | 'high';
};

export type ParseResult = {
  parserVersion: string;
  transcriptRef: string | null;
  declaredRangeText: string | null;
  declaredMessageCount: number | null;
  declaredCredits: { total: number | null; byDay: Record<string, number> } | null;
  declaredModels: Array<{ model: string; messages: number; credits: number }> | null;
  events: ParsedEvent[];
  cycles: ParsedCycle[];
  operatorTurns: ParsedOperatorTurn[];
  drifts: ParsedDrift[];
  platformErrors: ParsedPlatformError[];
  days: DayCoverage[];
  rolesObserved: Record<string, RoleClass>;
  englishRequests: number;
  /** Seqs of the operator messages that asked for the working language, so the
   *  count can be attributed to the day each one fell on. */
  englishRequestSeqs: number[];
  warnings: ParseWarning[];
  firstEventAt: Date | null;
  lastEventAt: Date | null;
};

export const DEFAULT_ROLE_MAP: Record<string, RoleClass> = {
  user: 'operator',
  operator: 'operator',
  human: 'operator',
  'team leader': 'orchestrator',
  lead: 'orchestrator',
  orchestrator: 'orchestrator',
  manager: 'orchestrator',
  engineer: 'worker',
  worker: 'worker',
  developer: 'worker',
  agent: 'worker',
};

/** Seeded from the reference dashboard's error categories (SPEC.md §5.8). */
export const DEFAULT_PLATFORM_ERROR_RULES: PlatformErrorRule[] = [
  {
    id: 'overload',
    label: 'Overload',
    pattern: '\\b(overloaded|overload error|529|rate limit(ed)?|too many requests)\\b',
    severity: 'high',
  },
  {
    id: 'container',
    label: 'Container failure',
    pattern: '\\b(container (failed|crashed|died|restart)|sandbox (failed|died)|OOM ?killed)\\b',
    severity: 'high',
  },
  {
    id: 'quota',
    label: 'Quota exhausted',
    pattern: '\\b(quota (exceeded|exhausted)|out of credits|usage limit reached)\\b',
    severity: 'high',
  },
  {
    id: 'corruption',
    label: 'Corruption',
    pattern: '\\b(corrupt(ed|ion)?|checksum mismatch|truncated response)\\b',
    severity: 'medium',
  },
  {
    id: 'timeout',
    label: 'Timeout',
    pattern: '\\b(timed out|timeout after|deadline exceeded|504 gateway)\\b',
    severity: 'medium',
  },
];
