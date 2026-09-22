/**
 * Read paths for the dashboards.
 *
 * Dashboards read only stored day aggregates — never the raw transcripts — so
 * they stay instant regardless of how large an import was.
 */

import { computeDayMetrics, type DayMetrics } from './metrics/compute';
import { aggregateRange, type RangeMetrics } from './metrics/aggregate';
import { dayRange } from './time';
import { getDay, listDays, listProjects, listTranscripts, type Project } from './repo';

export { getProject, listProjects, type Project } from './repo';

function emptyDay(day: string): DayMetrics {
  return computeDayMetrics(
    {
      day,
      eventCount: 0,
      firstEventAt: null,
      lastEventAt: null,
      englishRequests: 0,
      fingerprints: [],
      cycles: [],
      turns: [],
      drifts: [],
      errors: [],
    },
    { timezone: 'UTC', workingLanguage: 'en' },
  );
}

export async function getDayMetrics(
  slug: string,
  from: string,
  to: string,
): Promise<DayMetrics[]> {
  const available = (await listDays(slug)).filter((d) => d >= from && d <= to);
  const docs = await Promise.all(available.map((d) => getDay(slug, d)));
  const byDay = new Map<string, DayMetrics>();
  for (const doc of docs) {
    if (doc?.metrics) byDay.set(doc.day, doc.metrics);
  }
  return dayRange(from, to).map((d) => byDay.get(d) ?? emptyDay(d));
}

export async function getRange(slug: string, from: string, to: string): Promise<RangeMetrics> {
  return aggregateRange(from, to, await getDayMetrics(slug, from, to));
}

/** The full span of days a project holds, for defaulting a date range. */
export async function getProjectSpan(
  slug: string,
): Promise<{ from: string; to: string } | null> {
  const days = await listDays(slug);
  if (days.length === 0) return null;
  return { from: days[0], to: days[days.length - 1] };
}

export type CalendarDay = {
  day: string;
  projects: Array<{
    slug: string;
    name: string;
    colour: string;
    cycles: number;
    transcripts: number;
  }>;
  totalCycles: number;
  transcripts: number;
};

/** Calendar coverage. A day with an upload but no cycles is distinct from no upload. */
export async function getCalendar(
  from: string,
  to: string,
  only?: Project,
): Promise<Map<string, CalendarDay>> {
  const projects = only ? [only] : await listProjects();
  const out = new Map<string, CalendarDay>();

  for (const project of projects) {
    const days = (await listDays(project.slug)).filter((d) => d >= from && d <= to);
    for (const day of days) {
      const doc = await getDay(project.slug, day);
      if (!doc) continue;
      const transcripts = await listTranscripts(project.slug);
      const contributing = doc.contributions.filter((c) => {
        const t = transcripts.find((x) => x.sha256 === c.sha256);
        return t?.days.find((d) => d.day === day)?.contributes ?? false;
      });
      if (contributing.length === 0) continue;

      let entry = out.get(day);
      if (!entry) {
        entry = { day, projects: [], totalCycles: 0, transcripts: 0 };
        out.set(day, entry);
      }
      const cycles = doc.metrics?.cycles ?? 0;
      entry.projects.push({
        slug: project.slug,
        name: project.name,
        colour: project.colour,
        cycles,
        transcripts: contributing.length,
      });
      entry.totalCycles += cycles;
      entry.transcripts += contributing.length;
    }
  }
  return out;
}

export type ProjectSummary = {
  project: Project;
  transcripts: number;
  days: number;
  cycles: number;
  lastDay: string | null;
  lastUpload: string | null;
  medianCycleMin: number | null;
  sparkline: Array<{ day: string; cycles: number }>;
};

export async function getProjectSummaries(projects: Project[]): Promise<ProjectSummary[]> {
  return Promise.all(
    projects.map(async (project) => {
      const [dayKeys, transcripts] = await Promise.all([
        listDays(project.slug),
        listTranscripts(project.slug),
      ]);
      const docs = await Promise.all(dayKeys.map((d) => getDay(project.slug, d)));
      const metrics = docs.map((d) => d?.metrics).filter((m): m is DayMetrics => Boolean(m));

      const durations = metrics.flatMap((m) => m.durationsMin).sort((a, b) => a - b);
      const median =
        durations.length === 0
          ? null
          : (() => {
              const h = (durations.length - 1) * 0.5;
              const lo = Math.floor(h);
              const hi = Math.ceil(h);
              return lo === hi
                ? durations[lo]
                : durations[lo] + (h - lo) * (durations[hi] - durations[lo]);
            })();

      return {
        project,
        transcripts: transcripts.length,
        days: metrics.filter((m) => m.activeDays > 0).length,
        cycles: metrics.reduce((a, m) => a + m.cycles, 0),
        lastDay: dayKeys.length ? dayKeys[dayKeys.length - 1] : null,
        lastUpload: transcripts.length ? transcripts[0].uploadedAt : null,
        medianCycleMin: median,
        sparkline: metrics.slice(-30).map((m) => ({ day: m.day, cycles: m.cycles })),
      };
    }),
  );
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

export const PALETTE = [
  '#1d4ed8',
  '#0f766e',
  '#b45309',
  '#7c3aed',
  '#be185d',
  '#0369a1',
  '#4d7c0f',
  '#9f1239',
];
