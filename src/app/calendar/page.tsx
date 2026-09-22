import Link from 'next/link';
import { MonthGrid, YearStrip } from '@/components/Calendar';
import { Card, Empty, SeriesDot, fmtInt } from '@/components/ui';
import { getCalendar, listProjects } from '@/lib/queries';
import { addMonths, monthBounds, todayKey } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month: monthParam } = await searchParams;
  const month = monthParam ?? todayKey().slice(0, 7);
  const { from, to } = monthBounds(`${month}-01`);

  const [projects, coverage, yearCoverage] = await Promise.all([
    listProjects(),
    getCalendar(from, to),
    getCalendar(`${addMonths(month, -11)}-01`, to),
  ]);

  const monthTotals = [...coverage.values()];
  const cycles = monthTotals.reduce((a, c) => a + c.totalCycles, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Calendar</h1>
        <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-muted)' }}>
          Which days have transcripts, across every project. One import can cover a whole month.
        </p>
      </div>

      {projects.length === 0 ? (
        <Empty>No projects yet.</Empty>
      ) : (
        <>
          <Card>
            <YearStrip month={month} coverage={yearCoverage} basePath="/calendar" />
          </Card>

          <Card
            title="Month"
            subtitle={`${monthTotals.length} covered day${monthTotals.length === 1 ? '' : 's'}, ${fmtInt(cycles)} cycles`}
          >
            <MonthGrid month={month} coverage={coverage} basePath="/calendar" />
          </Card>

          <Card title="Projects" subtitle="Dot colours on the grid.">
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
              {projects.map((p) => {
                const days = monthTotals.filter((c) => c.projects.some((x) => x.slug === p.slug));
                const c = days.reduce(
                  (a, d) => a + (d.projects.find((x) => x.slug === p.slug)?.cycles ?? 0),
                  0,
                );
                return (
                  <li key={p.slug} className="flex items-center gap-1.5">
                    <SeriesDot colour={p.colour} />
                    <Link href={`/p/${p.slug}`} className="focusable rounded hover:underline">
                      {p.name}
                    </Link>
                    <span style={{ color: 'var(--text-faint)' }}>
                      {days.length} day{days.length === 1 ? '' : 's'}, {fmtInt(c)} cycles
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
