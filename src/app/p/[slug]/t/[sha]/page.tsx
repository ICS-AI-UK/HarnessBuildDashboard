import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, Card, EMPTY, Pill, fmtInt } from '@/components/ui';
import { BoundaryOverride } from '@/components/BoundaryOverride';
import { getProject, getTranscript, listTranscripts } from '@/lib/repo';
import { reparse, type ParseReport } from '@/lib/ingest';
import { deleteTranscript, reparseTranscript, setDayContributes } from '@/app/actions';

export const dynamic = 'force-dynamic';

const PAGE = 150;

export default async function TranscriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; sha: string }>;
  searchParams: Promise<{ page?: string; role?: string; kind?: string; day?: string; q?: string; reparsed?: string }>;
}) {
  const { slug, sha } = await params;
  const sp = await searchParams;
  const page = Math.max(0, Number(sp.page ?? 0) || 0);

  const project = await getProject(slug);
  if (!project) notFound();
  const record = await getTranscript(slug, sha);
  if (!record) notFound();

  const report = record.report as ParseReport | null;
  const others = await listTranscripts(slug);

  // Event-level views rebuild from the stored transcript; the dashboards never do.
  const rebuilt = await reparse(project, sha);
  const allEvents = rebuilt?.parsed.events ?? [];
  const cycles = rebuilt?.parsed.cycles ?? [];

  const roles = [...new Set(allEvents.map((e) => e.role))];
  const filtered = allEvents.filter(
    (e) =>
      (!sp.role || e.role === sp.role) &&
      (!sp.kind || e.kind === sp.kind) &&
      (!sp.day || e.day === sp.day) &&
      (!sp.q || e.body.toLowerCase().includes(sp.q.toLowerCase())),
  );
  const events = filtered.slice(page * PAGE, (page + 1) * PAGE);

  const boundaryOf = new Map<number, { role: 'dispatch' | 'closeout'; tag: string; confidence: number }>();
  for (const c of cycles) {
    boundaryOf.set(c.dispatchSeq, { role: 'dispatch', tag: c.tag, confidence: c.classificationConfidence });
    if (c.closeoutSeq !== null)
      boundaryOf.set(c.closeoutSeq, { role: 'closeout', tag: c.tag, confidence: c.classificationConfidence });
  }
  const orchestratorMessages = allEvents.filter(
    (e) => e.roleClass === 'orchestrator' && e.kind === 'message',
  );

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams({
      ...(sp.role ? { role: sp.role } : {}),
      ...(sp.kind ? { kind: sp.kind } : {}),
      ...(sp.day ? { day: sp.day } : {}),
      ...(sp.q ? { q: sp.q } : {}),
      ...extra,
    });
    return `/p/${slug}/t/${sha}?${p.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={`/p/${slug}`} className="focusable rounded text-[12.5px] hover:underline" style={{ color: 'var(--text-muted)' }}>
            &larr; {project.name}
          </Link>
          <h1 className="mono mt-1 text-[19px] font-semibold tracking-tight">{record.filename}</h1>
          <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            {fmtInt(record.parsedEventCount)} events &middot; {record.days.length} day
            {record.days.length === 1 ? '' : 's'} &middot; parser {record.parserVersion} &middot;
            uploaded {record.uploadedAt.slice(0, 16).replace('T', ' ')}
          </p>
        </div>
        <div className="flex gap-2">
          <form action={reparseTranscript}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="sha" value={sha} />
            <Button type="submit">Re-parse</Button>
          </form>
          <form action={deleteTranscript}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="sha" value={sha} />
            <Button type="submit" variant="danger">
              Delete
            </Button>
          </form>
        </div>
      </div>

      {sp.reparsed && <Pill tone="good">Re-parsed, {sp.reparsed} day(s) rebuilt</Pill>}

      <Card title="Days covered" subtitle="One import can cover many days. Each is resolved on its own.">
        <div className="overflow-x-auto">
          <table className="text-[13px]">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 text-left font-medium">Day</th>
                <th className="pb-2 text-left font-medium">Overlap</th>
                <th className="pb-2 text-left font-medium">Status</th>
                <th className="pb-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {record.days.map((d) => {
                const superseder = d.supersededBySha
                  ? others.find((t) => t.sha256 === d.supersededBySha)
                  : null;
                return (
                  <tr key={d.day} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="num py-2 font-medium">
                      <Link href={`/p/${slug}/d/${d.day}`} className="focusable rounded hover:underline">
                        {d.day}
                      </Link>
                    </td>
                    <td className="py-2">
                      <Pill tone={d.overlapClass === 'partial' ? 'warn' : 'default'}>{d.overlapClass}</Pill>
                    </td>
                    <td className="py-2" style={{ color: 'var(--text-muted)' }}>
                      {d.contributes ? (
                        'Contributing'
                      ) : (
                        <>
                          Retired
                          {superseder && (
                            <>
                              {' by '}
                              <Link href={`/p/${slug}/t/${superseder.sha256}`} className="mono focusable rounded hover:underline">
                                {superseder.filename}
                              </Link>
                            </>
                          )}
                        </>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <form action={setDayContributes}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="sha" value={sha} />
                        <input type="hidden" name="day" value={d.day} />
                        <input type="hidden" name="contributes" value={d.contributes ? '0' : '1'} />
                        <Button type="submit" variant="ghost">
                          {d.contributes ? 'Retire' : 'Restore'}
                        </Button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {report && (
        <Card title="Parse report">
          <div className="grid gap-4 text-[12.5px] sm:grid-cols-4">
            <Field
              label="Declared"
              value={`${report.declaredRangeText ?? EMPTY}${
                report.declaredMessageCount !== null ? `, ${report.declaredMessageCount.toLocaleString()} messages` : ''
              }`}
            />
            <Field label="Parsed" value={`${report.parsedEventCount.toLocaleString()} events`} />
            <Field
              label="Cycles"
              value={`${report.cycles} (${report.openCycles} open, ${report.lowConfidenceCycles} low confidence)`}
            />
            <Field
              label="Roles"
              value={Object.entries(report.rolesObserved).map(([r, c]) => `${r} → ${c}`).join(', ')}
            />
          </div>
          {report.warnings.length > 0 && (
            <ul className="mt-4 space-y-1 text-[12.5px]" style={{ color: 'var(--warn)' }}>
              {report.warnings.map((w, i) => (
                <li key={i}>
                  <span className="mono" style={{ color: 'var(--text-faint)' }}>{w.code}</span> {w.message}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card
        title="Cycle boundaries"
        subtitle="Force a classification the resolver got wrong. Overrides survive re-parsing."
      >
        <div className="max-h-[420px] overflow-y-auto">
          <table className="text-[13px]">
            <thead className="sticky top-0" style={{ background: 'var(--surface)' }}>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2 text-left font-medium">Time</th>
                <th className="pb-2 text-left font-medium">Opening</th>
                <th className="pb-2 text-left font-medium">Resolved</th>
                <th className="pb-2 text-right font-medium">Override</th>
              </tr>
            </thead>
            <tbody>
              {orchestratorMessages.map((e) => {
                const r = boundaryOf.get(e.seq);
                return (
                  <tr key={e.seq} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="num py-2 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {e.tsUtc.toISOString().slice(11, 19)}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="line-clamp-1">{e.body.slice(0, 110)}</span>
                    </td>
                    <td className="py-2">
                      {r ? (
                        <Pill tone={r.confidence < 0.7 ? 'warn' : 'default'}>
                          {r.role} &middot; {r.tag} &middot; {(r.confidence * 100).toFixed(0)}%
                        </Pill>
                      ) : (
                        <span style={{ color: 'var(--text-faint)' }}>{EMPTY}</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <BoundaryOverride
                        slug={slug}
                        sha={sha}
                        seq={e.seq}
                        value={record.boundaryOverrides[e.seq] ?? 'auto'}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          Changing an override takes effect on the next re-parse.
        </p>
      </Card>

      <Card title="Events" subtitle={`${fmtInt(filtered.length)} matching · rebuilt from the stored transcript`}>
        <form className="mb-4 flex flex-wrap gap-2 text-[12.5px]">
          <select name="role" defaultValue={sp.role ?? ''}>
            <option value="">All roles</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select name="kind" defaultValue={sp.kind ?? ''}>
            <option value="">All kinds</option>
            <option value="message">message</option>
            <option value="think">think</option>
          </select>
          <select name="day" defaultValue={sp.day ?? ''}>
            <option value="">All days</option>
            {record.days.map((d) => (
              <option key={d.day} value={d.day}>
                {d.day}
              </option>
            ))}
          </select>
          <input type="search" name="q" placeholder="Contains&hellip;" defaultValue={sp.q ?? ''} />
          <Button type="submit">Filter</Button>
        </form>

        <ul className="space-y-3">
          {events.map((e) => (
            <li key={e.seq} className="rounded-md p-3" style={{ background: 'var(--surface-2)' }}>
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                <span className="num">{e.tsUtc.toISOString().replace('T', ' ').slice(0, 19)}</span>
                <span>&middot;</span>
                <span>{e.role}</span>
                <Pill>{e.kind}</Pill>
                {e.detectedLanguage && e.detectedLanguage !== project.workingLanguage && (
                  <Pill tone="warn">{e.detectedLanguage}</Pill>
                )}
                {e.actionCount > 0 && <Pill>{e.actionCount} action{e.actionCount === 1 ? '' : 's'}</Pill>}
                <span className="num ml-auto">{fmtInt(e.bodyChars)} chars</span>
              </div>
              <pre className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed" style={{ fontFamily: 'inherit' }}>
                {e.body.length > 1200 ? `${e.body.slice(0, 1200)}…` : e.body}
              </pre>
            </li>
          ))}
        </ul>

        {filtered.length > PAGE && (
          <div className="mt-4 flex items-center justify-between text-[12.5px]">
            <span style={{ color: 'var(--text-muted)' }}>
              {page * PAGE + 1}&ndash;{Math.min((page + 1) * PAGE, filtered.length)} of {fmtInt(filtered.length)}
            </span>
            <div className="flex gap-2">
              {page > 0 && <Button href={qs({ page: String(page - 1) })}>Previous</Button>}
              {(page + 1) * PAGE < filtered.length && <Button href={qs({ page: String(page + 1) })}>Next</Button>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-faint)' }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}
