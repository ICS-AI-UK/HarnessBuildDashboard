import { NextResponse } from 'next/server';
import { getProject } from '@/lib/repo';
import { getDayMetrics, getProjectSpan } from '@/lib/queries';
import { todayKey } from '@/lib/time';

/** Cycle table as JSON, or CSV when the client asks for it (SPEC.md §6.6). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const project = slug ? await getProject(slug) : null;
  if (!project) return NextResponse.json({ error: 'Pass a known slug.' }, { status: 400 });

  const span = await getProjectSpan(project.slug);
  const from = url.searchParams.get('from') ?? span?.from ?? todayKey(project.timezone);
  const to = url.searchParams.get('to') ?? span?.to ?? todayKey(project.timezone);

  const days = await getDayMetrics(project.slug, from, to);
  const rows = days.flatMap((d) => d.cycleSummaries.map((c) => ({ day: d.day, ...c })));

  const wantsCsv =
    url.searchParams.get('format') === 'csv' ||
    (request.headers.get('accept') ?? '').includes('text/csv');

  if (!wantsCsv) return NextResponse.json({ project: project.slug, from, to, cycles: rows });

  const header = ['day', 'tag', 'type', 'duration_min', 'reasoning_steps', 'dispatch_chars', 'halted'];
  const csv = rows.map((c) =>
    [c.day, c.tag, c.type, c.durationMin ?? '', c.steps, c.dispatchChars, c.halted]
      .map((v) => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(','),
  );

  return new NextResponse([header.join(','), ...csv].join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${project.slug}-cycles-${from}-to-${to}.csv"`,
    },
  });
}
