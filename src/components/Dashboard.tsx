import Link from 'next/link';
import { Card, EMPTY, Figure, Method, Pill, fmt, fmtInt, fmtR, fmtStat } from './ui';
import { CorrelationScatter, DurationHistogram, ElapsedBar } from './charts';
import { buildInsights, type InsightContext } from '@/lib/insights';
import { languageName } from '@/lib/parser/language';
import { formatClock, formatDayLong } from '@/lib/time';
import type { RangeMetrics } from '@/lib/metrics/aggregate';

function windowLabel(m: RangeMetrics, timezone: string): string {
  if (m.windowsByDay.length === 0) return EMPTY;
  const starts = m.windowsByDay.filter((w) => w.start).map((w) => new Date(w.start!));
  const ends = m.windowsByDay.filter((w) => w.end).map((w) => new Date(w.end!));
  if (!starts.length || !ends.length) return EMPTY;
  // Per day, never one span from the first event to the last (SPEC.md §5.1).
  const earliest = starts.reduce((a, b) => (formatClock(a, timezone) <= formatClock(b, timezone) ? a : b));
  const latest = ends.reduce((a, b) => (formatClock(a, timezone) >= formatClock(b, timezone) ? a : b));
  const span = `${formatClock(earliest, timezone)}–${formatClock(latest, timezone)}`;
  return m.activeDays === 1 ? span : `${span} across ${m.activeDays} active days`;
}

export function HeadlineStrip({
  metrics,
  timezone,
  scopeNote,
}: {
  metrics: RangeMetrics;
  timezone: string;
  scopeNote: string;
}) {
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13.5px] font-medium">{scopeNote}</p>
        <p className="num text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
          Working hours {windowLabel(metrics, timezone)}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Figure value={fmtInt(metrics.cycles)} label="Cycles" size="lg" note={metrics.openCycles ? `${metrics.openCycles} still open` : undefined} />
        <Figure value={fmtInt(metrics.reasoningSteps)} label="Reasoning steps" size="lg" />
        <Figure
          value={fmtInt(metrics.platformErrors)}
          label="Platform errors"
          size="lg"
          tone={metrics.platformErrors === 0 ? 'good' : 'bad'}
        />
        <Figure value={fmtInt(metrics.activeDays)} label="Active days" size="lg" note={`of ${metrics.daysInRange} in range`} />
      </div>
    </Card>
  );
}

/** Just the dates, for panels that sit below one already carrying the full label. */
export function periodSpan(m: RangeMetrics): string {
  return m.from === m.to
    ? formatDayLong(m.from)
    : `${formatDayLong(m.from)} – ${formatDayLong(m.to)}`;
}

/** Plain-English description of the scope a panel is showing. */
export function periodLabel(m: RangeMetrics): string {
  const one = m.from === m.to;
  const span = one ? formatDayLong(m.from) : `${formatDayLong(m.from)} – ${formatDayLong(m.to)}`;
  if (m.activeDays === 0) return `${span} · no days with transcripts`;
  if (one) return span;
  return `${span} · ${m.activeDays} of ${m.daysInRange} day${m.daysInRange === 1 ? '' : 's'} have transcripts`;
}

export function AtAGlance({ metrics }: { metrics: RangeMetrics }) {
  const rows: Array<[string, string, string?]> = [
    ['Cycles', fmtInt(metrics.cycles)],
    ['Median cycle', fmtStat(metrics.medianCycleMin, 1, 'min')],
    ['90th percentile', fmtStat(metrics.p90CycleMin, 1, 'min')],
    ['Longest cycle', fmtStat(metrics.longestCycleMin, 1, 'min')],
    ['Minutes per reasoning step', fmtStat(metrics.minutesPerStep, 2)],
    ['Step latency, median', fmtStat(metrics.stepLatencyS, 1, 's')],
    ['Platform errors', fmtInt(metrics.platformErrors)],
    ['Mid-work operator answers', fmtInt(metrics.operatorAnswers)],
  ];
  return (
    <Card title="At a glance" subtitle={periodLabel(metrics)}>
      <table>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} style={{ borderTop: '1px solid var(--border)' }}>
              <th scope="row" className="py-2 pr-4 text-left text-[13px] font-normal" style={{ color: 'var(--text-muted)' }}>
                {label}
              </th>
              <td className="num py-2 text-right text-[14px] font-medium">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Method>
        A cycle that crosses midnight is counted wholly on the day it began. Open cycles are counted
        but excluded from duration figures.
      </Method>
    </Card>
  );
}

export function CycleDistribution({ metrics }: { metrics: RangeMetrics }) {
  const durations = metrics.series.flatMap((d) => d.durationsMin);
  return (
    <Card
      title="Cycle time distribution"
      subtitle={`Minutes, dispatch to close-out — ${durations.length} cycle${durations.length === 1 ? '' : 's'} · ${periodSpan(metrics)}`}
    >
      {durations.length ? (
        <DurationHistogram
          durations={durations}
          median={metrics.medianCycleMin.value}
          p90={metrics.p90CycleMin.value}
        />
      ) : (
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          No closed cycles in this period.
        </p>
      )}
    </Card>
  );
}

export function ComplexityPanel({ metrics }: { metrics: RangeMetrics }) {
  const points = metrics.series.flatMap((d) =>
    d.cycleSummaries
      .filter((c) => c.durationMin !== null)
      .map((c) => ({ x: c.dispatchChars, y: c.durationMin!, tag: c.tag })),
  );
  const stepPoints = metrics.series.flatMap((d) =>
    d.cycleSummaries
      .filter((c) => c.durationMin !== null)
      .map((c) => ({ x: c.steps, y: c.durationMin!, tag: c.tag })),
  );

  const r = metrics.dispatchLengthVsDuration;
  const rs = metrics.stepsVsDuration;

  return (
    <Card
      id="complexity"
      title="What actually costs time"
      subtitle={`Correlation with cycle duration \u00b7 ${periodSpan(metrics)}`}
    >
      <div className="grid gap-7 md:grid-cols-2">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="num text-[30px] font-semibold tracking-tight">
              {fmtR(r.value)}
            </span>
            <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              dispatch length vs duration
            </span>
          </div>
          <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
            {r.value === null
              ? `Suppressed: n = ${r.n}, below the minimum of 8.`
              : metrics.dispatchCharsMin !== null
                ? `Dispatches ran from ${metrics.dispatchCharsMin.toLocaleString()} to ${metrics.dispatchCharsMax!.toLocaleString()} characters over ${r.n} cycles.`
                : ''}
          </p>
          <div className="mt-2">
            <CorrelationScatter points={points} xLabel="dispatch characters" colour="var(--series-1)" />
          </div>
        </div>

        <div>
          <div className="flex items-baseline gap-3">
            <span
              className="num text-[30px] font-semibold tracking-tight"
              style={{
                // Only colour it as a finding when it actually is one.
                color: rs.value !== null && Math.abs(rs.value) >= 0.5 ? 'var(--good)' : 'var(--text)',
              }}
            >
              {fmtR(rs.value)}
            </span>
            <span className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              reasoning steps vs duration
            </span>
          </div>
          <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
            {rs.value === null
              ? `Suppressed: n = ${rs.n}, below the minimum of 8.`
              : Math.abs(rs.value) >= 0.5
                ? `Work size predicts duration${
                    r.value !== null && Math.abs(r.value) < 0.2 ? '; dispatch length does not' : ''
                  }.`
                : 'Neither measure explains duration here.'}
          </p>
          <div className="mt-2">
            <CorrelationScatter points={stepPoints} xLabel="reasoning steps" colour="var(--series-2)" />
          </div>
        </div>
      </div>
      <Method>
        Pearson r, suppressed below n = 8 or when either variable is constant. Open cycles excluded.
      </Method>
    </Card>
  );
}

export function ElapsedPanel({ metrics }: { metrics: RangeMetrics }) {
  const { elapsed } = metrics;
  const waitPct = elapsed.windowS ? Math.round((elapsed.operatorWaitS / elapsed.windowS) * 100) : 0;
  return (
    <Card
      id="elapsed"
      title="Where the elapsed time goes"
      subtitle={
        elapsed.operatorWaitS > 0
          ? `${Math.round(elapsed.operatorWaitS / 60)} minutes (${waitPct}%) sat between a finished report and the next instruction — not an agent cost.`
          : undefined
      }
    >
      <ElapsedBar inCycleS={elapsed.inCycleS} operatorWaitS={elapsed.operatorWaitS} otherS={elapsed.otherS} />
      <Method>
        Intervals are clipped at midnight so the bands sum to each day&rsquo;s own window; an overnight
        gap is therefore never counted as operator wait. This differs deliberately from the cycle
        figures above, which assign a whole cycle to the day it started.
      </Method>
    </Card>
  );
}

export function InterruptionsPanel({ metrics }: { metrics: RangeMetrics }) {
  const rate = metrics.interruptionRate;
  const answers = metrics.series.flatMap((d) => d.answerTexts);
  return (
    <Card
      id="interruptions"
      title="Mid-work operator answers"
      subtitle="Operator turns shorter than the project's threshold are answers, not dispatches."
    >
      <div className="grid gap-6 sm:grid-cols-3">
        <Figure value={fmtInt(metrics.operatorAnswers)} label="Answers (interruptions)" />
        <Figure value={fmtInt(metrics.operatorDispatches)} label="Pasted dispatches" />
        <Figure
          value={rate.value === null ? EMPTY : `${Math.round(rate.value * 100)}%`}
          label="Interruption rate"
          note={`over ${rate.n} operator turn${rate.n === 1 ? '' : 's'}`}
          tone={rate.value !== null && rate.value > 0.3 ? 'warn' : 'default'}
        />
      </div>
      {answers.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            What it asked you
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {answers.slice(0, 20).map((a, i) => (
              <li key={i}>
                <span
                  className="mono inline-block rounded px-2 py-1 text-[12px]"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                >
                  &ldquo;{a}&rdquo;
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function AuditPanel({ metrics }: { metrics: RangeMetrics }) {
  const u = metrics.unrecordedAuthorisations;
  const rate = metrics.unrecordedRate;
  return (
    <Card
      id="audit"
      title="An attached dispatch leaves no record"
      subtitle="When a dispatch is attached rather than pasted, the transcript shows no operator message at all."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <Figure
          value={`${fmtInt(u)} of ${fmtInt(metrics.cycles)}`}
          label="Cycles whose authorisation is not in the record"
          note={rate.value === null ? undefined : `${Math.round(rate.value * 100)}% of cycles`}
          tone={u > 0 ? 'warn' : 'good'}
        />
        <div
          className="mono rounded-md p-3 text-[11.5px] leading-relaxed"
          style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        >
          <div>08:34:29 Team Leader [message] SEED-1 is done&hellip;</div>
          <div style={{ color: 'var(--warn)' }}>
            &nbsp;&nbsp;&laquo; your instruction goes here, and is not recorded &raquo;
          </div>
          <div>08:46:05 Team Leader [think] I&rsquo;m getting started.</div>
          <div>08:46:36 Team Leader [message] CYCLE FIN-1 &mdash; its own version, relayed</div>
        </div>
      </div>
      <Method>
        Detected as a dispatch with no operator message between it and the previous close-out. The
        cycle&rsquo;s stated authority cannot be audited, and the relay cannot be compared against
        the original.
      </Method>
    </Card>
  );
}

export function DriftPanel({
  metrics,
  workingLanguage,
}: {
  metrics: RangeMetrics;
  workingLanguage: string;
}) {
  const byClass = metrics.series.reduce<Record<string, number>>((acc, d) => {
    for (const [k, v] of Object.entries(d.driftsByClass)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
  const closeouts = byClass.closeout ?? 0;

  return (
    <Card
      id="drift"
      title="Language drift"
      subtitle={`Working language: ${languageName(workingLanguage)}. Detected on every agent message, with code and paths stripped first.`}
    >
      <div className="grid gap-6 sm:grid-cols-3">
        <Figure value={fmtInt(metrics.drifts)} label={`Replies not in ${languageName(workingLanguage)}`} />
        <Figure value={fmtInt(metrics.languageRequests)} label="Times you asked for it" />
        <Figure
          value={fmtInt(metrics.driftsUnchallenged)}
          label="Drifts that went unchallenged"
          tone={metrics.driftsUnchallenged > 0 ? 'warn' : 'good'}
        />
      </div>
      {metrics.drifts > 0 && (
        <p className="mt-4 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {closeouts === metrics.drifts ? (
            <>
              <strong style={{ color: 'var(--text)' }}>Every drift was a close-out report</strong> —
              the verdicts the period&rsquo;s decisions rest on came back in another language.
            </>
          ) : (
            <>
              {closeouts} of {metrics.drifts} drifts were close-out reports; the rest were internal
              messages.
            </>
          )}
        </p>
      )}
      <Method>
        A drift counts as challenged only if someone asks for the working language before the next
        dispatch. The standing &ldquo;Working language&rdquo; line every dispatch carries is
        boilerplate, not an intervention, so it is not counted.
      </Method>
    </Card>
  );
}

export function InsightsPanel({
  metrics,
  ctx,
}: {
  metrics: RangeMetrics;
  ctx: InsightContext;
}) {
  const insights = buildInsights(metrics, ctx);
  if (insights.length === 0) return null;
  return (
    <Card title="Worth doing" subtitle="Rules over the computed figures — no model is involved.">
      <ol className="space-y-3">
        {insights.map((ins, i) => (
          <li key={ins.id} className="flex gap-3">
            <span
              className="num mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold"
              style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
            >
              {i + 1}
            </span>
            <div>
              <div className="flex items-center gap-2">
                {ins.href ? (
                  <Link href={ins.href} className="focusable rounded text-[13.5px] font-semibold hover:underline">
                    {ins.headline}
                  </Link>
                ) : (
                  <span className="text-[13.5px] font-semibold">{ins.headline}</span>
                )}
                <Pill tone={ins.severity === 'high' ? 'bad' : ins.severity === 'medium' ? 'warn' : 'good'}>
                  {ins.severity}
                </Pill>
              </div>
              <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                {ins.detail}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function CycleTable({
  metrics,
  slug,
  day,
}: {
  metrics: RangeMetrics;
  slug: string;
  /** When the scope is a single day, cycles link to their detail view. */
  day?: string;
}) {
  const rows = metrics.series.flatMap((d) =>
    d.cycleSummaries.map((c, i) => ({ ...c, day: d.day, index: i })),
  );
  if (rows.length === 0) return null;
  return (
    <Card title="Cycles" subtitle={`${rows.length} in this period`}>
      <div className="overflow-x-auto">
        <table className="text-[13px]">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              <th className="pb-2 text-left font-medium">Cycle</th>
              <th className="pb-2 text-left font-medium">Day</th>
              <th className="pb-2 text-left font-medium">Type</th>
              <th className="pb-2 text-right font-medium">Minutes</th>
              <th className="pb-2 text-right font-medium">Steps</th>
              <th className="pb-2 text-right font-medium">Dispatch chars</th>
              <th className="pb-2 text-right font-medium">Min/step</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const href = day ? `/p/${slug}/d/${c.day}/c/${c.index}` : null;
              return (
                <tr key={`${c.day}-${c.tag}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="py-1.5 font-medium">
                    {href ? (
                      <Link href={href} className="focusable rounded hover:underline">
                        {c.tag}
                      </Link>
                    ) : (
                      c.tag
                    )}
                    {c.halted && (
                      <span className="ml-2">
                        <Pill tone="warn">halted</Pill>
                      </span>
                    )}
                  </td>
                  <td className="num py-1.5" style={{ color: 'var(--text-muted)' }}>
                    {c.day}
                  </td>
                  <td className="py-1.5" style={{ color: 'var(--text-muted)' }}>
                    {c.type === 'UNKNOWN' ? EMPTY : c.type}
                  </td>
                  <td className="num py-1.5 text-right">{fmt(c.durationMin, 1)}</td>
                  <td className="num py-1.5 text-right">{fmtInt(c.steps)}</td>
                  <td className="num py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                    {fmtInt(c.dispatchChars)}
                  </td>
                  <td className="num py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                    {c.durationMin !== null && c.steps > 0 ? fmt(c.durationMin / c.steps, 2) : EMPTY}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
