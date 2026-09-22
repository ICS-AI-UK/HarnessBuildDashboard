import { NextResponse } from 'next/server';
import { getProject } from '@/lib/repo';
import { getProjectSpan, getRange } from '@/lib/queries';
import { buildInsights } from '@/lib/insights';
import { todayKey } from '@/lib/time';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const project = slug ? await getProject(slug) : null;
  if (!project) return NextResponse.json({ error: 'Pass a known slug.' }, { status: 400 });

  const span = await getProjectSpan(project.slug);
  const from = url.searchParams.get('from') ?? span?.from ?? todayKey(project.timezone);
  const to = url.searchParams.get('to') ?? span?.to ?? todayKey(project.timezone);

  const metrics = await getRange(project.slug, from, to);

  return NextResponse.json({
    project: { slug: project.slug, name: project.name, timezone: project.timezone },
    from,
    to,
    metrics,
    insights: buildInsights(metrics, { portfolioInterruptionRate: null, slug: project.slug }),
  });
}
