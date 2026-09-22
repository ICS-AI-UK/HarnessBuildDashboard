import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, EMPTY, Pill, fmt, fmtInt } from '@/components/ui';
import { getDay, getProject, listTranscripts } from '@/lib/repo';
import { reparse } from '@/lib/ingest';
import { mergeSlices } from '@/lib/metrics/slice';
import { formatClockSeconds, formatDayLong } from '@/lib/time';

export const dynamic = 'force-dynamic';

/**
 * Cycle detail. The dashboards read aggregates, but this view needs the actual
 * messages, so it re-parses the stored transcript on demand (SPEC.md §3.4).
 */
export default async function CyclePage({
  params,
}: {
  params: Promise<{ slug: string; date: string; index: string }>;
}) {
  const { slug, date, index } = await params;
  const project = await getProject(slug);
  if (!project) notFound();

  const [doc, transcripts] = await Promise.all([getDay(slug, date), listTranscripts(slug)]);
  if (!doc) notFound();

  const contributing = doc.contributions.filter((c) => {
    const t = transcripts.find((x) => x.sha256 === c.sha256);
    return t?.days.find((d) => d.day === date)?.contributes ?? false;
  });

  // Same ordering the metrics used, so the index matches the cycle table.
  const ordered = mergeSlices(contributing.map((c) => c.slice)).cycles;
  const i = Number(index);
  const cycle = Number.isInteger(i) ? ordered[i] : undefined;
  if (!cycle) notFound();

  const owner = contributing.find((c) =>
    c.slice.cycles.some(
      (x) => x.dispatchSeq === cycle.dispatchSeq && +new Date(x.startedAt) === +new Date(cycle.startedAt),
    ),
  );
  if (!owner) notFound();

  const reparsed = await reparse(project, owner.sha256);
  const events = reparsed
    ? reparsed.parsed.events.filter(
        (e) =>
          e.seq >= cycle.dispatchSeq &&
          e.seq <= (cycle.closeoutSeq ?? reparsed.parsed.events.length - 1),
      )
    : [];

  const dispatch = events[0] ?? null;
  const closeout =
    cycle.closeoutSeq !== null ? (events[events.length - 1] ?? null) : null;

  const gaps = events.map((e, k) =>
    k === 0 ? null : (e.tsUtc.getTime() - events[k - 1].tsUtc.getTime()) / 1000,
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/p/${slug}/d/${date}`}
          className="focusable rounded text-[12.5px] hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          &larr; {formatDayLong(date)}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">{cycle.tag}</h1>
          {cycle.cycleType !== 'UNKNOWN' && <Pill tone="accent">{cycle.cycleType}</Pill>}
          {cycle.halted && <Pill tone="warn">halted</Pill>}
          {cycle.isOpen && <Pill tone="warn">open &mdash; no close-out</Pill>}
          {!cycle.authorisationRecorded && <Pill tone="warn">authorisation not in the record</Pill>}
          {cycle.classificationConfidence < 0.7 && (
            <Pill tone="warn">low confidence ({Math.round(cycle.classificationConfidence * 100)}%)</Pill>
          )}
        </div>
        <p className="mt-1 text-[12px]" style={{ color: 'var(--text-faint)' }}>
          Rebuilt from{' '}
          <Link href={`/p/${slug}/t/${owner.sha256}`} className="mono focusable rounded hover:underline">
            {owner.filename}
          </Link>
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Duration', cycle.durationS === null ? EMPTY : `${fmt(cycle.durationS / 60, 1)} min`],
            ['Reasoning steps', fmtInt(cycle.reasoningSteps)],
            ['Tool actions', fmtInt(cycle.toolActions)],
            [
              'Minutes per step',
              cycle.durationS !== null && cycle.reasoningSteps > 0
                ? fmt(cycle.durationS / 60 / cycle.reasoningSteps, 2)
                : EMPTY,
            ],
            [
              'Step latency',
              cycle.medianStepLatencyS === null ? EMPTY : `${fmt(cycle.medianStepLatencyS, 1)}s`,
            ],
            ['Operator answers', fmtInt(cycle.operatorAnswers)],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="num text-[20px] font-semibold tracking-tight">{value}</div>
              <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Dispatch"
          subtitle={`${fmtInt(cycle.dispatchChars)} characters${
            cycle.operatorDispatchChars !== null
              ? ` · operator's own: ${fmtInt(cycle.operatorDispatchChars)}`
              : ' · arrived as an attachment'
          }`}
        >
          <pre
            className="max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded-md p-3 text-[12.5px] leading-relaxed"
            style={{ background: 'var(--surface-2)', fontFamily: 'inherit' }}
          >
            {dispatch?.body ?? 'The stored transcript is no longer available.'}
          </pre>
        </Card>
        <Card
          title="Close-out"
          subtitle={closeout ? `${fmtInt(closeout.bodyChars)} characters` : 'No close-out in the record'}
        >
          {closeout ? (
            <pre
              className="max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded-md p-3 text-[12.5px] leading-relaxed"
              style={{ background: 'var(--surface-2)', fontFamily: 'inherit' }}
            >
              {closeout.body}
            </pre>
          ) : (
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              This dispatch had no close-out before the end of the transcript. The cycle is counted
              but excluded from duration statistics.
            </p>
          )}
        </Card>
      </div>

      <Card title="Timeline" subtitle="Per-step latency between consecutive events.">
        <div className="overflow-x-auto">
          <table className="text-[13px]">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 text-left font-medium">Time</th>
                <th className="pb-2 text-right font-medium">Gap</th>
                <th className="pb-2 text-left font-medium">Role</th>
                <th className="pb-2 text-left font-medium">Kind</th>
                <th className="pb-2 text-left font-medium">Body</th>
                <th className="pb-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, k) => (
                <tr key={e.seq} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="num py-1.5 whitespace-nowrap">
                    {formatClockSeconds(e.tsUtc, project.timezone)}
                  </td>
                  <td
                    className="num py-1.5 text-right"
                    style={{ color: gaps[k] !== null && gaps[k]! > 60 ? 'var(--warn)' : 'var(--text-faint)' }}
                  >
                    {gaps[k] === null ? EMPTY : `${gaps[k]!.toFixed(1)}s`}
                  </td>
                  <td className="py-1.5" style={{ color: 'var(--text-muted)' }}>
                    {e.role}
                  </td>
                  <td className="py-1.5">
                    <Pill>{e.kind}</Pill>
                    {e.detectedLanguage && e.detectedLanguage !== project.workingLanguage && (
                      <span className="ml-1">
                        <Pill tone="warn">{e.detectedLanguage}</Pill>
                      </span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <span className="line-clamp-1" style={{ color: 'var(--text-muted)' }}>
                      {e.body.slice(0, 120)}
                    </span>
                  </td>
                  <td className="num py-1.5 text-right" style={{ color: 'var(--text-faint)' }}>
                    {e.actionCount || EMPTY}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
