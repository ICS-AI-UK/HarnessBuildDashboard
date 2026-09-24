import Link from 'next/link';
import { PortfolioBars } from '@/components/charts';
import { Button, Card, EMPTY, Empty, Method, Pill, SeriesDot, fmt, fmtInt } from '@/components/ui';
import { buildPortfolio, mergeModelMetrics, type AverageMode, type PortfolioEntry } from '@/lib/metrics/aggregate';
import { getProjectSpan, getRange, listProjects } from '@/lib/queries';
import { formatDayLong, todayKey } from '@/lib/time';
import { BurndownPanel } from '@/components/Burndown';
import { ModelsPanel } from '@/components/Models';
import { computeBurndown } from '@/lib/metrics/burndown';
import { getPortfolioSettings } from '@/lib/repo';
import { getDayMetrics } from '@/lib/queries';
import { updatePortfolioBalance } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; mode?: string; balanceSaved?: string }>;
}) {
  const sp = await searchParams;
  const mode: AverageMode = sp.mode === 'pooled' ? 'pooled' : 'macro';

  const projects = await listProjects();
  if (projects.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-[22px] font-semibold tracking-tight">Portfolio</h1>
        <Empty action={<Button href="/" variant="primary">Create a project</Button>}>
          Nothing to compare yet.
        </Empty>
      </div>
    );
  }

  const spans = await Promise.all(projects.map((p) => getProjectSpan(p.slug)));
  const present = spans.filter((s): s is { from: string; to: string } => s !== null);
  const from = sp.from ?? (present.length ? present.map((s) => s.from).sort()[0] : todayKey());
  const to = sp.to ?? (present.length ? present.map((s) => s.to).sort().reverse()[0] : todayKey());

  const entries: PortfolioEntry[] = await Promise.all(
    projects.map(async (project) => {
      const metrics = await getRange(project.slug, from, to);
      const enough = metrics.cycles >= project.minCyclesForAverage;
      return {
        projectId: project.slug,
        slug: project.slug,
        name: project.name,
        colour: project.colour,
        metrics,
        included: enough,
        exclusionReason: enough
          ? null
          : `${metrics.cycles} cycle${metrics.cycles === 1 ? '' : 's'} in range, below this project's minimum of ${project.minCyclesForAverage}`,
      };
    }),
  );

  const rows = buildPortfolio(entries, mode);
  const included = entries.filter((e) => e.included);
  const excluded = entries.filter((e) => !e.included);

  // Estate-wide spend: total credits over the days that actually carry credit
  // data, rather than an average of per-project averages.
  const creditValues = included
    .map((e) => e.metrics.credits)
    .filter((v): v is number => v !== null);
  const creditTotal = creditValues.length ? creditValues.reduce((a, b) => a + b, 0) : null;
  const creditDays = included.reduce((a, e) => a + e.metrics.daysWithCredits, 0);

  // Estate burndown: one balance drawn down by every project's spend, summed
  // per day so two projects working the same day count once against the pool.
  const portfolio = await getPortfolioSettings();
  let estateBurndown = null;
  if (portfolio.creditBalance !== null && portfolio.creditBalanceAsOf !== null) {
    const today = todayKey();
    const perProject = await Promise.all(
      included.map((e) => getDayMetrics(e.slug, portfolio.creditBalanceAsOf as string, today)),
    );
    const byDay = new Map<string, number | null>();
    for (const series of perProject) {
      for (const d of series) {
        if (d.credits === null) continue;
        byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.credits);
      }
    }
    const combined = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, credits]) => ({ day, credits, activeDays: 1 }) as never);
    estateBurndown = computeBurndown({
      balance: portfolio.creditBalance,
      asOf: portfolio.creditBalanceAsOf,
      days: combined,
      today,
    });
  }

  const qs = (m: AverageMode) => `/portfolio?from=${from}&to=${to}&mode=${m}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Portfolio</h1>
          <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-muted)' }}>
            {formatDayLong(from)} &ndash; {formatDayLong(to)} &middot; {included.length} project
            {included.length === 1 ? '' : 's'} in the average
          </p>
        </div>
        <div className="flex gap-1.5">
          <Link
            href={qs('macro')}
            className="focusable rounded-md px-3 py-1.5 text-[12.5px]"
            style={{
              border: '1px solid var(--border)',
              background: mode === 'macro' ? 'var(--accent-soft)' : 'transparent',
              color: mode === 'macro' ? 'var(--accent)' : 'var(--text-muted)',
            }}
          >
            Macro average
          </Link>
          <Link
            href={qs('pooled')}
            className="focusable rounded-md px-3 py-1.5 text-[12.5px]"
            style={{
              border: '1px solid var(--border)',
              background: mode === 'pooled' ? 'var(--accent-soft)' : 'transparent',
              color: mode === 'pooled' ? 'var(--accent)' : 'var(--text-muted)',
            }}
          >
            Pooled
          </Link>
        </div>
      </div>

      <Card>
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {mode === 'macro' ? (
            <>
              <strong style={{ color: 'var(--text)' }}>Macro</strong> averages each project&rsquo;s
              own value, so every project counts once. It answers &ldquo;what does a typical project
              look like?&rdquo; Medians here are averages of per-project medians.
            </>
          ) : (
            <>
              <strong style={{ color: 'var(--text)' }}>Pooled</strong> recomputes each figure over
              every cycle from every project. It answers &ldquo;what happened across the
              estate?&rdquo; Medians are recomputed from the combined cycle set, never averaged.
            </>
          )}
        </p>
      </Card>

      <Card title="Comparison" subtitle="Each project against the average, with its deviation.">
        <div className="overflow-x-auto">
          <table className="text-[13px]">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 text-left font-medium">Metric</th>
                {entries.map((e) => (
                  <th key={e.projectId} className="pb-2 text-right font-medium">
                    <Link href={`/p/${e.slug}`} className="focusable inline-flex items-center gap-1.5 rounded hover:underline">
                      <SeriesDot colour={e.colour} />
                      {e.name}
                    </Link>
                  </th>
                ))}
                <th className="pb-2 text-right font-medium" style={{ color: 'var(--text)' }}>
                  Average
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} style={{ borderTop: '1px solid var(--border)' }}>
                  <th scope="row" className="py-2 pr-4 text-left font-normal" style={{ color: 'var(--text-muted)' }}>
                    {row.label}
                    {row.unit && row.unit !== 'r' && (
                      <span style={{ color: 'var(--text-faint)' }}> ({row.unit})</span>
                    )}
                  </th>
                  {entries.map((e) => {
                    const v = row.values.find((x) => x.projectId === e.projectId);
                    return (
                      <td key={e.projectId} className="num py-2 pl-4 text-right">
                        {v?.value === null || v === undefined ? (
                          <span style={{ color: 'var(--text-faint)' }}>{EMPTY}</span>
                        ) : (
                          <span className={v.outlier ? 'font-semibold' : ''} style={v.outlier ? { color: 'var(--warn)' } : undefined}>
                            {fmt(v.value, row.dp)}
                            {v.deviation !== null && Math.abs(v.deviation) > 0.005 && (
                              <span className="ml-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                                {v.deviation > 0 ? '+' : ''}
                                {fmt(v.deviation, row.dp)}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="num py-2 pl-4 text-right font-semibold">
                    {fmt(row.average, row.dp)}
                    <span className="ml-1 text-[11px] font-normal" style={{ color: 'var(--text-faint)' }}>
                      n={row.n}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Method>
          A project more than one standard deviation from the mean is highlighted. With only a
          handful of projects an average is a description, not a law &mdash; n is shown on every row.
        </Method>
      </Card>

      {excluded.length > 0 && (
        <Card title="Excluded from the average">
          <ul className="space-y-1.5 text-[13px]">
            {excluded.map((e) => (
              <li key={e.projectId} className="flex flex-wrap items-center gap-2">
                <SeriesDot colour={e.colour} />
                <Link href={`/p/${e.slug}`} className="focusable rounded hover:underline">
                  {e.name}
                </Link>
                <span style={{ color: 'var(--text-muted)' }}>{e.exclusionReason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {rows
          .filter((r) =>
            ['creditsPerActiveDay', 'creditsPerCycle', 'medianCycleMin', 'interruptionRate'].includes(r.key),
          )
          .map((row) => (
            <Card key={row.key} title={row.label} subtitle={`Average ${fmt(row.average, row.dp)}${row.unit && row.unit !== 'r' ? ` ${row.unit}` : ''}`}>
              <PortfolioBars values={row.values} average={row.average} dp={row.dp} unit={row.unit} />
            </Card>
          ))}
      </div>

      <Card
        title="Account credit balance"
        subtitle="One pool covering every project. Used for the estate burndown below."
      >
        {sp.balanceSaved && (
          <div className="mb-3">
            <Pill tone="good">Balance saved</Pill>
          </div>
        )}
        <form action={updatePortfolioBalance} className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              Credits remaining
            </span>
            <input
              type="number"
              name="creditBalance"
              step="0.01"
              min={0}
              defaultValue={portfolio.creditBalance ?? ''}
              placeholder="e.g. 250000"
              className="w-56"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              True as of
            </span>
            <input type="date" name="creditBalanceAsOf" defaultValue={portfolio.creditBalanceAsOf ?? ''} />
          </label>
          <Button type="submit" variant="primary">
            Save balance
          </Button>
        </form>
        <Method>
          Leave the amount blank to turn the estate projection off. Individual projects can carry
          their own balance in project settings, for pools that are billed separately.
        </Method>
      </Card>

      <BurndownPanel
        burndown={estateBurndown}
        scope={`All ${included.length} tracked project${included.length === 1 ? '' : 's'}`}
        settingsHref="/portfolio"
      />

      {/* Models across the estate: each project's per-day tallies merged, so a
          day worked in two projects shows both projects' models stacked. */}
      <ModelsPanel
        metrics={mergeModelMetrics(included.map((e) => e.metrics))}
        scope={`All ${included.length} tracked project${included.length === 1 ? '' : 's'}`}
      />

      <Card title="Totals across the portfolio" subtitle="Sums, not averages.">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Cycles', fmtInt(included.reduce((a, e) => a + e.metrics.cycles, 0))],
            ['Reasoning steps', fmtInt(included.reduce((a, e) => a + e.metrics.reasoningSteps, 0))],
            ['Active days', fmtInt(included.reduce((a, e) => a + e.metrics.activeDays, 0))],
            [
              'Credits spent',
              creditTotal === null ? EMPTY : fmt(creditTotal, 0),
            ],
            [
              'Credits per day, all projects',
              creditDays > 0 && creditTotal !== null ? fmt(creditTotal / creditDays, 0) : EMPTY,
            ],
            ['Platform errors', fmtInt(included.reduce((a, e) => a + e.metrics.platformErrors, 0))],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="num text-[26px] font-semibold tracking-tight">{value}</div>
              <div className="mt-1 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {included.length === 1 && (
        <Card>
          <Pill tone="warn">One project</Pill>
          <p className="mt-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            An average across one project is that project. Upload a second to make this view useful.
          </p>
        </Card>
      )}
    </div>
  );
}
