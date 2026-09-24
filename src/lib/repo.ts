/**
 * Repository over the document store.
 *
 * Everything the app reads or writes goes through here. Documents are:
 *
 *   projects/<slug>.json          the project record
 *   raw/<slug>/<sha>.md           the transcript, kept so event-level evidence
 *                                 can be rebuilt on demand
 *   transcripts/<slug>/<sha>.json transcript metadata, parse report, per-day
 *                                 contributions and boundary overrides
 *   days/<slug>/<YYYY-MM-DD>.json one day: each contributing transcript's slice,
 *                                 plus the computed metrics
 *
 * A day document holds one slice per contributing transcript rather than a
 * merged blob, so retiring or restoring a contribution is a recompute rather
 * than a re-parse.
 */

import { getStore, keys } from './store';
import { computeDayMetrics, type DayMetrics } from './metrics/compute';
import { mergeSlices, reviveSlice, type DaySlice } from './metrics/slice';
import type { BoundaryRole, ParseSettings, RoleClass } from './parser/types';
import { DEFAULT_PLATFORM_ERROR_RULES } from './parser/types';
import type { OverlapClass } from './overlap';

export type Project = {
  slug: string;
  name: string;
  description: string | null;
  colour: string;
  workingLanguage: string;
  timezone: string;
  answerThreshold: number;
  minCyclesForAverage: number;
  roleMap: Record<string, RoleClass>;
  /** Credits remaining, as stated by the user, for the burndown (SPEC.md §5.12). */
  creditBalance: number | null;
  /** The date that balance was true on; spend from this day onwards reduces it. */
  creditBalanceAsOf: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptDayRecord = {
  day: string;
  overlapClass: OverlapClass;
  contributes: boolean;
  supersededBySha: string | null;
  resolvedBy: 'auto' | 'user';
};

export type TranscriptRecord = {
  sha256: string;
  filename: string;
  byteSize: number;
  transcriptRef: string | null;
  declaredRangeText: string | null;
  declaredMessageCount: number | null;
  parsedEventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  parserVersion: string;
  uploadedAt: string;
  days: TranscriptDayRecord[];
  report: unknown;
  boundaryOverrides: Record<number, BoundaryRole>;
};

export type DayDocument = {
  day: string;
  contributions: Array<{ sha256: string; filename: string; slice: DaySlice }>;
  metrics: DayMetrics;
};

// --- Projects -------------------------------------------------------------

/**
 * Fill fields added after a document was written.
 *
 * Stored projects are long-lived and the shape grows, so a record saved by an
 * earlier version is simply missing the newer keys. `undefined` is not `null`:
 * a guard like `x !== null` passes for a missing key and hands the absent value
 * straight to code that assumed it was there. Every read goes through here so
 * that cannot happen.
 */
function normaliseProject(raw: Partial<Project> & { slug: string }): Project {
  return {
    slug: raw.slug,
    name: raw.name ?? raw.slug,
    description: raw.description ?? null,
    colour: raw.colour ?? '#1d4ed8',
    workingLanguage: raw.workingLanguage ?? 'en',
    timezone: raw.timezone ?? 'UTC',
    answerThreshold: raw.answerThreshold ?? 600,
    minCyclesForAverage: raw.minCyclesForAverage ?? 5,
    roleMap: raw.roleMap ?? {},
    creditBalance: raw.creditBalance ?? null,
    creditBalanceAsOf: raw.creditBalanceAsOf ?? null,
    archivedAt: raw.archivedAt ?? null,
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
  };
}

export async function getProject(slug: string): Promise<Project | null> {
  const store = await getStore();
  const raw = await store.getJSON<Project>(keys.project(slug));
  return raw ? normaliseProject(raw) : null;
}

export async function saveProject(project: Project): Promise<void> {
  const store = await getStore();
  await store.setJSON(keys.project(project.slug), project);
}

export async function listProjects(includeArchived = false): Promise<Project[]> {
  const store = await getStore();
  const ks = await store.list(keys.projectPrefix());
  const projects = (await Promise.all(ks.map((k) => store.getJSON<Project>(k))))
    .filter((p): p is Project => p !== null)
    .map(normaliseProject);
  return projects
    .filter((p) => includeArchived || !p.archivedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Delete every transcript, raw file and day a project holds, keeping the
 * project and its settings. Returns what was removed, so the caller can say so.
 */
export async function clearProjectData(
  slug: string,
): Promise<{ transcripts: number; days: number }> {
  const store = await getStore();
  const transcriptKeys = await store.list(keys.transcriptPrefix(slug));
  const dayKeys = await store.list(keys.dayPrefix(slug));
  const rawKeys = await store.list(`raw/${slug}/`);

  await Promise.all([...transcriptKeys, ...dayKeys, ...rawKeys].map((k) => store.delete(k)));
  return { transcripts: transcriptKeys.length, days: dayKeys.length };
}

export async function deleteProject(slug: string): Promise<void> {
  const store = await getStore();
  await clearProjectData(slug);
  await store.delete(keys.project(slug));
}

// --- Account-wide settings ------------------------------------------------

export type PortfolioSettings = {
  /** A single pool covering every project, for the estate-wide burndown. */
  creditBalance: number | null;
  creditBalanceAsOf: string | null;
  updatedAt: string | null;
};

const EMPTY_PORTFOLIO: PortfolioSettings = {
  creditBalance: null,
  creditBalanceAsOf: null,
  updatedAt: null,
};

export async function getPortfolioSettings(): Promise<PortfolioSettings> {
  const store = await getStore();
  const raw = await store.getJSON<PortfolioSettings>(keys.portfolio());
  if (!raw) return EMPTY_PORTFOLIO;
  // Same reasoning as normaliseProject: a missing key must read as null.
  return {
    creditBalance: raw.creditBalance ?? null,
    creditBalanceAsOf: raw.creditBalanceAsOf ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

export async function savePortfolioSettings(settings: PortfolioSettings): Promise<void> {
  const store = await getStore();
  await store.setJSON(keys.portfolio(), { ...settings, updatedAt: new Date().toISOString() });
}

export function settingsFor(project: Project, overrides: Record<number, BoundaryRole> = {}): ParseSettings {
  return {
    timezone: project.timezone,
    workingLanguage: project.workingLanguage,
    answerThreshold: project.answerThreshold,
    roleMap: project.roleMap ?? {},
    overrides,
    platformErrorRules: DEFAULT_PLATFORM_ERROR_RULES,
  };
}

// --- Transcripts ----------------------------------------------------------

export async function getTranscript(slug: string, sha: string): Promise<TranscriptRecord | null> {
  const store = await getStore();
  return store.getJSON<TranscriptRecord>(keys.transcript(slug, sha));
}

export async function saveTranscript(slug: string, record: TranscriptRecord): Promise<void> {
  const store = await getStore();
  await store.setJSON(keys.transcript(slug, record.sha256), record);
}

export async function listTranscripts(slug: string): Promise<TranscriptRecord[]> {
  const store = await getStore();
  const ks = await store.list(keys.transcriptPrefix(slug));
  const rows = (await Promise.all(ks.map((k) => store.getJSON<TranscriptRecord>(k)))).filter(
    (t): t is TranscriptRecord => t !== null,
  );
  return rows.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export async function getRawTranscript(slug: string, sha: string): Promise<string | null> {
  const store = await getStore();
  return store.getText(keys.raw(slug, sha));
}

export async function saveRawTranscript(slug: string, sha: string, text: string): Promise<void> {
  const store = await getStore();
  await store.setText(keys.raw(slug, sha), text);
}

export async function deleteTranscript(slug: string, sha: string): Promise<string[]> {
  const store = await getStore();
  const record = await getTranscript(slug, sha);
  const days = record?.days.map((d) => d.day) ?? [];

  await store.delete(keys.transcript(slug, sha));
  await store.delete(keys.raw(slug, sha));

  // Anything this transcript superseded starts contributing again.
  const others = await listTranscripts(slug);
  const touched = new Set(days);
  for (const other of others) {
    let changed = false;
    for (const d of other.days) {
      if (d.supersededBySha === sha) {
        d.contributes = true;
        d.supersededBySha = null;
        changed = true;
        touched.add(d.day);
      }
    }
    if (changed) await saveTranscript(slug, other);
  }

  return [...touched];
}

// --- Days -----------------------------------------------------------------

export async function getDay(slug: string, day: string): Promise<DayDocument | null> {
  const store = await getStore();
  const doc = await store.getJSON<DayDocument>(keys.day(slug, day));
  if (!doc) return null;
  return {
    ...doc,
    contributions: doc.contributions.map((c) => ({ ...c, slice: reviveSlice(c.slice) })),
  };
}

export async function saveDay(slug: string, doc: DayDocument): Promise<void> {
  const store = await getStore();
  await store.setJSON(keys.day(slug, doc.day), doc);
}

export async function deleteDay(slug: string, day: string): Promise<void> {
  const store = await getStore();
  await store.delete(keys.day(slug, day));
}

/** Every day key a project holds, ascending. */
export async function listDays(slug: string): Promise<string[]> {
  const store = await getStore();
  const prefix = keys.dayPrefix(slug);
  const ks = await store.list(prefix);
  return ks
    .map((k) => k.slice(prefix.length).replace(/\.json$/, ''))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

/**
 * Rebuild a day's metrics from whichever transcripts currently contribute.
 * Reads the stored slices, so no transcript needs re-parsing.
 */
export async function rebuildDay(project: Project, day: string): Promise<DayDocument | null> {
  const transcripts = await listTranscripts(project.slug);
  const existing = await getDay(project.slug, day);

  const contributions: DayDocument['contributions'] = [];
  for (const t of transcripts) {
    const d = t.days.find((x) => x.day === day);
    if (!d || !d.contributes) continue;
    const stored = existing?.contributions.find((c) => c.sha256 === t.sha256);
    if (stored) contributions.push(stored);
  }

  // Keep retired contributions in the document so a restore does not need a
  // re-parse, but compute only from the contributing ones.
  const retained = existing
    ? existing.contributions.filter((c) => !contributions.some((k) => k.sha256 === c.sha256))
    : [];

  if (contributions.length === 0 && retained.length === 0) {
    await deleteDay(project.slug, day);
    return null;
  }

  const merged = mergeSlices(contributions.map((c) => c.slice));
  const metrics = computeDayMetrics(
    { ...merged, day },
    { timezone: project.timezone, workingLanguage: project.workingLanguage },
  );

  const doc: DayDocument = { day, contributions: [...contributions, ...retained], metrics };
  await saveDay(project.slug, doc);
  return doc;
}

export async function rebuildDays(project: Project, days: string[]): Promise<void> {
  for (const day of [...new Set(days)]) await rebuildDay(project, day);
}

export async function rebuildProject(project: Project): Promise<number> {
  const days = await listDays(project.slug);
  await rebuildDays(project, days);
  return days.length;
}
