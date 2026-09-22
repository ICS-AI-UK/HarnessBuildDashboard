import Link from 'next/link';
import { Sparkline } from '@/components/charts';
import { Button, Card, EMPTY, Empty, Pill, SeriesDot, fmt, fmtInt } from '@/components/ui';
import { getProjectSummaries, listProjects } from '@/lib/queries';
import { formatDayLong } from '@/lib/time';
import { createProject } from './actions';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const projects = await listProjects(true);
  const summaries = await getProjectSummaries(projects);
  const active = summaries.filter((s) => !s.project.archivedAt);
  const archived = summaries.filter((s) => s.project.archivedAt);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-muted)' }}>
            Each project holds its own transcripts, calendar and dashboard.
          </p>
        </div>
        <Button href="/upload" variant="primary">
          Upload a transcript
        </Button>
      </div>

      {active.length === 0 && archived.length === 0 ? (
        <Empty>No projects yet. Create one below, then upload a transcript into it.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((s) => (
            <Link
              key={s.project.slug}
              href={`/p/${s.project.slug}`}
              className="focusable card block p-4 transition-shadow hover:shadow-md"
            >
              <div className="flex items-center gap-2">
                <SeriesDot colour={s.project.colour} />
                <h2 className="truncate text-[14.5px] font-semibold tracking-tight">{s.project.name}</h2>
              </div>
              {s.project.description && (
                <p className="mt-1 line-clamp-2 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                  {s.project.description}
                </p>
              )}

              <dl className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
                <div title="Cycles resolved across every day this project holds">
                  <dt style={{ color: 'var(--text-faint)' }}>Cycles</dt>
                  <dd className="num text-[16px] font-semibold">{fmtInt(s.cycles)}</dd>
                </div>
                <div title="Days with at least one transcript covering them">
                  <dt style={{ color: 'var(--text-faint)' }}>Days</dt>
                  <dd className="num text-[16px] font-semibold">{fmtInt(s.days)}</dd>
                </div>
                <div title="Median cycle duration, dispatch to close-out, across every cycle in the project">
                  <dt style={{ color: 'var(--text-faint)' }}>Median cycle</dt>
                  <dd className="num text-[16px] font-semibold">
                    {s.medianCycleMin === null ? EMPTY : `${fmt(s.medianCycleMin, 1)} min`}
                  </dd>
                </div>
              </dl>

              {s.sparkline.length > 1 && (
                <div className="mt-3">
                  <div
                    className="mb-0.5 flex items-baseline justify-between text-[10.5px]"
                    style={{ color: 'var(--text-faint)' }}
                  >
                    <span>Cycles per day</span>
                    <span className="num">
                      {s.sparkline[0].day.slice(5)} &ndash; {s.sparkline[s.sparkline.length - 1].day.slice(5)}
                    </span>
                  </div>
                  <Sparkline data={s.sparkline} colour={s.project.colour} />
                </div>
              )}

              <p className="mt-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                {s.transcripts === 0
                  ? 'No transcripts yet'
                  : `${s.transcripts} transcript${s.transcripts === 1 ? '' : 's'}${
                      s.lastDay ? ` · latest day ${formatDayLong(s.lastDay)}` : ''
                    }`}
              </p>
            </Link>
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <Card title="Archived" subtitle="Excluded from cross-project averages.">
          <ul className="space-y-2">
            {archived.map((s) => (
              <li key={s.project.slug} className="flex items-center gap-2 text-[13px]">
                <SeriesDot colour={s.project.colour} />
                <Link href={`/p/${s.project.slug}`} className="focusable rounded hover:underline">
                  {s.project.name}
                </Link>
                <Pill>{fmtInt(s.cycles)} cycles</Pill>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="New project">
        <form action={createProject} className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              Name
            </span>
            <input type="text" name="name" required placeholder="SMART:LGR Workbench" className="w-full" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              Working language
            </span>
            <select name="workingLanguage" defaultValue="en" className="w-full">
              <option value="en">English</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="es">Spanish</option>
              <option value="nl">Dutch</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              Timezone
            </span>
            <select name="timezone" defaultValue="UTC" className="w-full">
              <option value="UTC">UTC</option>
              <option value="Europe/London">Europe/London</option>
              <option value="Europe/Dublin">Europe/Dublin</option>
              <option value="Europe/Paris">Europe/Paris</option>
              <option value="America/New_York">America/New_York</option>
              <option value="Asia/Kolkata">Asia/Kolkata</option>
              <option value="Australia/Sydney">Australia/Sydney</option>
            </select>
          </label>
          <Button type="submit" variant="primary">
            Create
          </Button>
        </form>
      </Card>
    </div>
  );
}
