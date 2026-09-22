/**
 * Re-read a stored transcript and rewrite its day slices.
 *
 * Needed when a project setting that affects parsing changes — the answer
 * threshold, the role map, boundary overrides — since the stored aggregates
 * were derived under the old settings.
 */

import { runPipeline } from './parser/pipeline';
import { FINGERPRINT_LENGTH, sliceFromParse } from './metrics/slice';
import {
  getDay,
  getRawTranscript,
  getTranscript,
  saveDay,
  saveTranscript,
  settingsFor,
  type DayDocument,
  type Project,
} from './repo';

/** Returns the days whose stored slices changed, for the caller to rebuild. */
export async function reparseAndStore(project: Project, sha: string): Promise<string[]> {
  const [record, raw] = await Promise.all([
    getTranscript(project.slug, sha),
    getRawTranscript(project.slug, sha),
  ]);
  if (!record || raw === null) return [];

  const parsed = runPipeline(raw, settingsFor(project, record.boundaryOverrides));
  const touched = new Set<string>(record.days.map((d) => d.day));

  for (const coverage of parsed.days) {
    // Only days this transcript already contributes to are rewritten; a
    // timezone change that moves events onto a new day is handled by the
    // project rebuild, not here.
    if (!record.days.some((d) => d.day === coverage.day)) continue;

    const slice = sliceFromParse(parsed, coverage.day);
    slice.fingerprints = slice.fingerprints.map((f) => f.slice(0, FINGERPRINT_LENGTH));

    const doc: DayDocument =
      (await getDay(project.slug, coverage.day)) ??
      ({ day: coverage.day, contributions: [], metrics: null as never });

    doc.contributions = [
      ...doc.contributions.filter((c) => c.sha256 !== sha),
      { sha256: sha, filename: record.filename, slice },
    ];
    await saveDay(project.slug, doc);
    touched.add(coverage.day);
  }

  record.parsedEventCount = parsed.events.length;
  record.parserVersion = parsed.parserVersion;
  await saveTranscript(project.slug, record);

  return [...touched];
}
