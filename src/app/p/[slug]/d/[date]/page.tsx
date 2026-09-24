import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AtAGlance,
  AuditPanel,
  ComplexityPanel,
  CreditPanel,
  CycleDistribution,
  CycleTable,
  DriftPanel,
  ElapsedPanel,
  HeadlineStrip,
  InsightsPanel,
  InterruptionsPanel,
} from '@/components/Dashboard';
import { Button, Card, Empty, Pill } from '@/components/ui';
import { ModelsPanel } from '@/components/Models';
import { getDay, getProject, listTranscripts } from '@/lib/repo';
import { getRange } from '@/lib/queries';
import { formatDayLong, nextDay, prevDay } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function DayPage({
  params,
}: {
  params: Promise<{ slug: string; date: string }>;
}) {
  const { slug, date } = await params;
  const project = await getProject(slug);
  if (!project) notFound();

  const [metrics, doc, transcripts] = await Promise.all([
    getRange(slug, date, date),
    getDay(slug, date),
    listTranscripts(slug),
  ]);

  const contributing = (doc?.contributions ?? []).filter((c) => {
    const t = transcripts.find((x) => x.sha256 === c.sha256);
    return t?.days.find((d) => d.day === date)?.contributes ?? false;
  });

  const empty = metrics.activeDays === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={`/p/${slug}`}
            className="focusable rounded text-[12.5px] hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            &larr; {project.name}
          </Link>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">{formatDayLong(date)}</h1>
        </div>
        <div className="flex gap-2">
          <Button href={`/p/${slug}/d/${prevDay(date)}`} variant="ghost">
            &lsaquo; Previous
          </Button>
          <Button href={`/p/${slug}/d/${nextDay(date)}`} variant="ghost">
            Next &rsaquo;
          </Button>
        </div>
      </div>

      {empty ? (
        <Empty action={<Button href={`/upload?project=${slug}`}>Upload a transcript</Button>}>
          No transcript covers this day.
        </Empty>
      ) : (
        <>
          {contributing.length > 1 && (
            <Card title="Assembled from several transcripts" subtitle="Their cycles pool for this day.">
              <ul className="flex flex-wrap gap-2">
                {contributing.map((c) => (
                  <li key={c.sha256}>
                    <Link href={`/p/${slug}/t/${c.sha256}`} className="focusable rounded">
                      <Pill tone="accent">{c.filename}</Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <HeadlineStrip
            metrics={metrics}
            timezone={project.timezone}
            scopeNote={`${project.name} · ${formatDayLong(date)}`}
          />

          <div className="grid gap-6 lg:grid-cols-2">
            <AtAGlance metrics={metrics} />
            <CycleDistribution metrics={metrics} />
          </div>

          <CreditPanel metrics={metrics} colour={project.colour} />
          <ModelsPanel metrics={metrics} scope={project.name} />
      <ComplexityPanel metrics={metrics} />
          <ElapsedPanel metrics={metrics} />

          <div className="grid gap-6 lg:grid-cols-2">
            <InterruptionsPanel metrics={metrics} />
            <AuditPanel metrics={metrics} />
          </div>

          <DriftPanel metrics={metrics} workingLanguage={project.workingLanguage} />
          <InsightsPanel
            metrics={metrics}
            ctx={{ portfolioInterruptionRate: null, slug, day: date }}
          />
          <CycleTable metrics={metrics} slug={slug} day={date} />
        </>
      )}
    </div>
  );
}
