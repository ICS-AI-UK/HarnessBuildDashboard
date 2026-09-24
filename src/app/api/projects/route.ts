import { NextResponse } from 'next/server';
import { saveProject, type Project } from '@/lib/repo';
import { PALETTE, listProjects, slugify } from '@/lib/queries';
import { isValidTimezone } from '@/lib/time';

export async function GET() {
  return NextResponse.json({ projects: await listProjects(true) });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const name = String(body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 });

  const timezone = String(body.timezone ?? 'UTC');
  if (!isValidTimezone(timezone)) {
    return NextResponse.json({ error: `Unknown timezone "${timezone}".` }, { status: 400 });
  }

  const existing = await listProjects(true);
  let slug = slugify(name);
  let n = 1;
  while (existing.some((p) => p.slug === slug)) slug = `${slugify(name)}-${++n}`;

  const now = new Date().toISOString();
  const project: Project = {
    slug,
    name,
    description: body.description ? String(body.description) : null,
    colour: String(body.colour ?? PALETTE[existing.length % PALETTE.length]),
    workingLanguage: String(body.workingLanguage ?? 'en'),
    timezone,
    answerThreshold: Number(body.answerThreshold ?? 600),
    minCyclesForAverage: Number(body.minCyclesForAverage ?? 5),
    roleMap: {},
    creditBalance: body.creditBalance === undefined ? null : Number(body.creditBalance),
    creditBalanceAsOf: body.creditBalanceAsOf ? String(body.creditBalanceAsOf) : null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveProject(project);

  return NextResponse.json({ project }, { status: 201 });
}
