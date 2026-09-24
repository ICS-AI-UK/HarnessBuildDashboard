import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MonthGrid, YearStrip } from '@/components/Calendar';
import { DayTrend } from '@/components/charts';
import {
  AtAGlance,
  AuditPanel,
  ComplexityPanel,
  CreditPanel,
  CycleDistribution,
  DriftPanel,
  ElapsedPanel,
  HeadlineStrip,
  InsightsPanel,
  InterruptionsPanel,
} from '@/components/Dashboard';
import { DateRange } from '@/components/DateRange';
import { ModelsPanel } from '@/components/Models';
import { BurndownPanel } from '@/components/Burndown';
import { computeBurndown } from '@/lib/metrics/burndown';
import { Button, Card, EMPTY, Empty, Pill, SeriesDot, fmt, fmtInt } from '@/components/ui';
import { getProject, listTranscripts, type Project } from '@/lib/repo';
import { getCalendar, getDayMetrics, getProjectSpan, getRange } from '@/lib/queries';
import { addMonths, formatDayLong, monthBounds, todayKey } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string; month?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const project = await getProject(slug);
  if (!project) notFound();

  const span = await getProjectSpan(slug);

  if (!span) {
    return (
      <div className="space-y-6">
        <Header project={project} />
        <Empty action={<Button href={`/upload?project=${slug}`} variant="primary">Upload a transcript</Button>}>
          Nothing has been uploaded to this project yet.
        </Empty>
      </div>
    );
  }

  const from = sp.from ?? span.from;
  const to = sp.to ?? span.to;
  const month = sp.month ?? span.to.slice(0, 7);
  const { from: mFrom, to: mTo } = monthBounds(`${month}-01`);

  const [metrics, transcripts, calendar, yearCalendar] = await Promise.all([
    getRange(slug, from, to),
    listTranscripts(slug),
    getCalendar(mFrom, mTo, project),
    getCalendar(`${addMonths(month, -11)}-01`, mTo, project),
  ]);

  // The burndown runs over every day held, not the selected range: a balance
  // is drawn down by all spend since its date, whatever the dashboard is showing.
  const allDays = await getDayMetrics(slug, span.from, todayKey(project.timezone) > span.to ? todayKey(project.timezone) : span.to);
  const burndown =
    project.creditBalance != null && project.creditBalanceAsOf != null
      ? computeBurndown({
          balance: project.creditBalance,
          asOf: project.creditBalanceAsOf,
          days: allDays,
          today: todayKey(project.timezone),
        })
      : null;

  return (
    <div className="space-y-6">
      <Header project={project} />

      <DateRange basePath={`/p/${slug}`} from={from} to={to} span={span} />

      <HeadlineStrip
        metrics={metrics}
        timezone={project.timezone}
        scopeNote={`${formatDayLong(from)} – ${formatDayLong(to)} · ${metrics.activeDays} active day${metrics.activeDays === 1 ? '' : 's'}`}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
        <AtAGlance metrics={metrics} />
        <Card title="Calendar" subtitle="Days this project has transcripts for.">
          <div className="mb-4">
            <YearStrip month={month} coverage={yearCalendar} basePath={`/p/${slug}`} />
          </div>
          <MonthGrid month={month} coverage={calendar} basePath={`/p/${slug}`} projectSlug={slug} />
        </Card>
      </div>

      {metrics.activeDays > 1 && (
        <Card title="Per day" subtitle="Each metric across the range.">
          <div className="grid gap-6 md:grid-cols-2">
            <TrendBlock
              label="Cycles"
              data={metrics.series.map((d) => ({ day: d.day, value: d.activeDays ? d.cycles : null }))}
              colour={project.colour}
            />
            <TrendBlock
              label="Median cycle (min)"
              kind="line"
              data={metrics.series.map((d) => ({ day: d.day, value: d.medianCycleMin.value }))}
              colour="var(--series-2)"
            />
            <TrendBlock
              label="Reasoning steps"
              data={metrics.series.map((d) => ({ day: d.day, value: d.activeDays ? d.reasoningSteps : null }))}
              colour="var(--series-4)"
            />
            <TrendBlock
              label="Step latency (s)"
              kind="line"
              data={metrics.series.map((d) => ({ day: d.day, value: d.stepLatencyS.value }))}
              colour="var(--series-3)"
            />
            <TrendBlock
              label="Credits"
              data={metrics.series.map((d) => ({ day: d.day, value: d.credits }))}
              colour="var(--series-5)"
            />
          </div>
        </Card>
      )}

      <CycleDistribution metrics={metrics} />
      <CreditPanel metrics={metrics} colour={project.colour} />
      <BurndownPanel
        burndown={burndown}
        scope={project.name}
        settingsHref={`/p/${slug}/settings`}
        colour={project.colour}
      />
      <ModelsPanel metrics={metrics} scope={project.name} />
      <ComplexityPanel metrics={metrics} />
      <ElapsedPanel metrics={metrics} />

      <div className="grid gap-6 lg:grid-cols-2">
        <InterruptionsPanel metrics={metrics} />
        <AuditPanel metrics={metrics} />
      </div>

      <DriftPanel metrics={metrics} workingLanguage={project.workingLanguage} />
      <InsightsPanel metrics={metrics} ctx={{ portfolioInterruptionRate: null, slug }} />

      <Card title="Transcripts" subtitle={`${transcripts.length} imported`}>
        <div className="overflow-x-auto">
          <table className="text-[13px]">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 text-left font-medium">File</th>
                <th className="pb-2 text-right font-medium">Events</th>
                <th className="pb-2 text-right font-medium">Days</th>
                <th className="pb-2 text-left font-medium">Covers</th>
                <th className="pb-2 text-right font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {transcripts.map((t) => {
                const contributing = t.days.filter((d) => d.contributes);
                const days = contributing.map((d) => d.day).sort();
                return (
                  <tr key={t.sha256} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="py-2">
                      <Link href={`/p/${slug}/t/${t.sha256}`} className="mono focusable rounded hover:underline">
                        {t.filename}
                      </Link>
                      {contributing.length < t.days.length && (
                        <span className="ml-2">
                          <Pill tone="warn">{t.days.length - contributing.length} day(s) retired</Pill>
                        </span>
                      )}
                    </td>
                    <td className="num py-2 text-right">{fmtInt(t.parsedEventCount)}</td>
                    <td className="num py-2 text-right">{fmtInt(contributing.length)}</td>
                    <td className="num py-2" style={{ color: 'var(--text-muted)' }}>
                      {days.length === 0
                        ? EMPTY
                        : days.length === 1
                          ? days[0]
                          : `${days[0]} → ${days[days.length - 1]}`}
                    </td>
                    <td className="num py-2 text-right" style={{ color: 'var(--text-faint)' }}>
                      {t.uploadedAt.slice(0, 10)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Header({ project }: { project: Project }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <SeriesDot colour={project.colour} />
          <h1 className="text-[22px] font-semibold tracking-tight">{project.name}</h1>
        </div>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {project.description ? `${project.description} · ` : ''}
          Days bucketed in {project.timezone}.
        </p>
      </div>
      <div className="flex gap-2">
        <Button href={`/upload?project=${project.slug}`}>Upload</Button>
        <Button href={`/p/${project.slug}/settings`} variant="ghost">
          Settings
        </Button>
      </div>
    </div>
  );
}

function TrendBlock({
  label,
  data,
  colour,
  kind = 'bar',
}: {
  label: string;
  data: Array<{ day: string; value: number | null }>;
  colour: string;
  kind?: 'bar' | 'line';
}) {
  const values = data.map((d) => d.value).filter((v): v is number => v !== null);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span className="num text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {values.length ? `max ${fmt(Math.max(...values), 1)}` : EMPTY}
        </span>
      </div>
      <DayTrend data={data} label={label} colour={colour} kind={kind} />
    </div>
  );
}
