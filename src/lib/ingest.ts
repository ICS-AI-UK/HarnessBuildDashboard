/**
 * Ingest: parse, classify overlap per day, store aggregates, rebuild days
 * (SPEC.md §6.2, §10).
 *
 * Only aggregates are stored — one record per transcript and one per day — plus
 * the raw transcript, kept so event-level evidence can be rebuilt on demand.
 */

import { runPipeline } from './parser/pipeline';
import { sha256 } from './parser/scan';
import { PARSER_VERSION, type RoleClass } from './parser/types';
import { FINGERPRINT_LENGTH, sliceFromParse } from './metrics/slice';
import {
  actionsFor,
  classifyDay,
  defaultActionFor,
  needsDecision,
  recommendationFor,
  type DayAction,
  type DayOverlap,
} from './overlap';
import {
  getDay,
  getTranscript,
  listTranscripts,
  rebuildDays,
  saveDay,
  saveRawTranscript,
  saveTranscript,
  settingsFor,
  type DayDocument,
  type Project,
  type TranscriptRecord,
} from './repo';

export type ParseReport = {
  filename: string;
  byteSize: number;
  sha256: string;
  transcriptRef: string | null;
  declaredRangeText: string | null;
  declaredMessageCount: number | null;
  parsedEventCount: number;
  cycles: number;
  openCycles: number;
  lowConfidenceCycles: number;
  rolesObserved: Record<string, RoleClass>;
  days: DayOverlap[];
  warnings: Array<{ code: string; message: string }>;
  duplicateOfSha: string | null;
  needsDecision: boolean;
};

/**
 * Parse and classify without writing anything — the dry run, and the default
 * whenever an import touches days that already hold data.
 */
export async function analyse(
  project: Project,
  filename: string,
  text: string,
  opts: { excludeSha?: string } = {},
): Promise<{ report: ParseReport; parsed: ReturnType<typeof runPipeline> }> {
  const hash = sha256(text);
  const existingTranscripts = await listTranscripts(project.slug);
  const duplicate = existingTranscripts.find(
    (t) => t.sha256 === hash && t.sha256 !== opts.excludeSha,
  );

  const parsed = runPipeline(text, settingsFor(project));

  // Fingerprints already held for these days, from contributions that count.
  const held = new Map<string, { fps: Set<string>; shas: Set<string> }>();
  for (const dayCoverage of parsed.days) {
    const doc = await getDay(project.slug, dayCoverage.day);
    const entry = { fps: new Set<string>(), shas: new Set<string>() };
    if (doc) {
      for (const c of doc.contributions) {
        if (c.sha256 === opts.excludeSha) continue;
        const t = existingTranscripts.find((x) => x.sha256 === c.sha256);
        const contributes = t?.days.find((d) => d.day === dayCoverage.day)?.contributes ?? false;
        if (!contributes) continue;
        entry.shas.add(c.sha256);
        for (const f of c.slice.fingerprints) entry.fps.add(f);
      }
    }
    held.set(dayCoverage.day, entry);
  }

  const days: DayOverlap[] = parsed.days.map((d) => {
    const store = held.get(d.day) ?? { fps: new Set<string>(), shas: new Set<string>() };
    const incoming = new Set(d.fingerprints.map((f) => f.slice(0, FINGERPRINT_LENGTH)));
    const { overlapClass, shared, incomingOnly, existingOnly } = classifyDay(incoming, store.fps);
    return {
      day: d.day,
      eventCount: d.eventCount,
      cycleCount: d.cycleCount,
      overlapClass,
      sharedFingerprints: shared,
      incomingOnly,
      existingOnly,
      existingTranscriptIds: [...store.shas],
      defaultAction: defaultActionFor(overlapClass),
      recommendation: recommendationFor(overlapClass, { shared, incomingOnly, existingOnly }),
    };
  });

  const report: ParseReport = {
    filename,
    byteSize: Buffer.byteLength(text, 'utf8'),
    sha256: hash,
    transcriptRef: parsed.transcriptRef,
    declaredRangeText: parsed.declaredRangeText,
    declaredMessageCount: parsed.declaredMessageCount,
    parsedEventCount: parsed.events.length,
    cycles: parsed.cycles.length,
    openCycles: parsed.cycles.filter((c) => c.isOpen).length,
    lowConfidenceCycles: parsed.cycles.filter((c) => c.classificationConfidence < 0.7).length,
    rolesObserved: parsed.rolesObserved,
    days,
    warnings: parsed.warnings.map((w) => ({ code: w.code, message: w.message })),
    duplicateOfSha: duplicate?.sha256 ?? null,
    needsDecision: days.some((d) => needsDecision(d.overlapClass)),
  };

  return { report, parsed };
}

export type CommitResult = {
  sha256: string;
  report: ParseReport;
  imported: string[];
  skipped: string[];
  superseded: Array<{ day: string; shas: string[] }>;
  /** Resolutions the fresh overlap no longer permitted, and what was done instead. */
  adjusted: Array<{ day: string; requested: DayAction; applied: DayAction; reason: string }>;
};

export async function commit(
  project: Project,
  filename: string,
  text: string,
  resolutions: Record<string, DayAction> = {},
): Promise<CommitResult> {
  const { report, parsed } = await analyse(project, filename, text);

  if (report.duplicateOfSha) {
    throw Object.assign(new Error('This exact file has already been imported into this project.'), {
      status: 409,
      duplicateOfSha: report.duplicateOfSha,
    });
  }
  if (parsed.events.length === 0) {
    throw Object.assign(new Error('No events could be parsed from this file.'), { status: 422 });
  }

  // Resolutions arrive from a preview, which was taken against the project as it
  // stood then. Anything committed since — another file in the same batch, or
  // another person — can have made that answer unsafe: a day previewed as "new"
  // may now be held, and importing it again would count its events twice. So a
  // resolution is honoured only if the overlap computed *now* still permits it.
  const actions = new Map<string, DayAction>();
  const adjusted: CommitResult['adjusted'] = [];
  for (const d of report.days) {
    const requested = resolutions[d.day];
    if (requested && !actionsFor(d.overlapClass).includes(requested)) {
      adjusted.push({
        day: d.day,
        requested,
        applied: d.defaultAction,
        reason: `This day is now "${d.overlapClass}" against what the project already holds, so "${requested}" is no longer safe.`,
      });
      actions.set(d.day, d.defaultAction);
    } else {
      actions.set(d.day, requested ?? d.defaultAction);
    }
  }

  const imported = report.days.filter((d) => actions.get(d.day) !== 'skip').map((d) => d.day);
  const skipped = report.days.filter((d) => actions.get(d.day) === 'skip').map((d) => d.day);
  const superseded: Array<{ day: string; shas: string[] }> = [];

  // The raw transcript is the evidence store: every detail view rebuilds from it.
  await saveRawTranscript(project.slug, report.sha256, text);

  const record: TranscriptRecord = {
    sha256: report.sha256,
    filename,
    byteSize: report.byteSize,
    transcriptRef: report.transcriptRef,
    declaredRangeText: report.declaredRangeText,
    declaredMessageCount: report.declaredMessageCount,
    parsedEventCount: parsed.events.length,
    firstEventAt: parsed.firstEventAt?.toISOString() ?? null,
    lastEventAt: parsed.lastEventAt?.toISOString() ?? null,
    parserVersion: PARSER_VERSION,
    uploadedAt: new Date().toISOString(),
    days: report.days
      .filter((d) => actions.get(d.day) !== 'skip')
      .map((d) => ({
        day: d.day,
        overlapClass: d.overlapClass,
        contributes: true,
        supersededBySha: null,
        resolvedBy: resolutions[d.day] ? ('user' as const) : ('auto' as const),
      })),
    report,
    boundaryOverrides: {},
  };
  await saveTranscript(project.slug, record);

  // Retire superseded contributions, then attach this transcript's slices.
  const others = await listTranscripts(project.slug);
  for (const d of report.days) {
    const action = actions.get(d.day)!;
    if (action === 'skip') continue;

    if (action === 'supersede' && d.existingTranscriptIds.length) {
      for (const other of others) {
        if (other.sha256 === record.sha256) continue;
        const od = other.days.find((x) => x.day === d.day);
        if (od && od.contributes && d.existingTranscriptIds.includes(other.sha256)) {
          od.contributes = false;
          od.supersededBySha = record.sha256;
          await saveTranscript(project.slug, other);
        }
      }
      superseded.push({ day: d.day, shas: d.existingTranscriptIds });
    }

    const existing = await getDay(project.slug, d.day);
    const slice = sliceFromParse(parsed, d.day);
    slice.fingerprints = slice.fingerprints.map((f) => f.slice(0, FINGERPRINT_LENGTH));

    const doc: DayDocument = existing ?? {
      day: d.day,
      contributions: [],
      metrics: null as never, // replaced by the rebuild below
    };
    doc.contributions = [
      ...doc.contributions.filter((c) => c.sha256 !== record.sha256),
      { sha256: record.sha256, filename, slice },
    ];
    await saveDay(project.slug, doc);
  }

  await rebuildDays(project, [...imported, ...superseded.map((s) => s.day)]);

  return { sha256: report.sha256, report, imported, skipped, superseded, adjusted };
}

/**
 * Rebuild event-level detail for a transcript by re-parsing the stored raw text.
 * Used only by the evidence views, never by the dashboards.
 */
export async function reparse(project: Project, sha: string) {
  const [record, raw] = await Promise.all([
    getTranscript(project.slug, sha),
    (await import('./repo')).getRawTranscript(project.slug, sha),
  ]);
  if (!record || raw === null) return null;
  return {
    record,
    parsed: runPipeline(raw, settingsFor(project, record.boundaryOverrides)),
  };
}
