import { NextResponse } from 'next/server';
import { getProject } from '@/lib/repo';
import { getCalendar } from '@/lib/queries';
import { monthBounds, todayKey } from '@/lib/time';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const project = slug ? await getProject(slug) : null;
  if (slug && !project) return NextResponse.json({ error: 'Unknown project.' }, { status: 404 });

  const bounds = monthBounds(todayKey());
  const from = url.searchParams.get('from') ?? bounds.from;
  const to = url.searchParams.get('to') ?? bounds.to;

  const coverage = await getCalendar(from, to, project ?? undefined);
  return NextResponse.json({ from, to, days: [...coverage.values()] });
}
