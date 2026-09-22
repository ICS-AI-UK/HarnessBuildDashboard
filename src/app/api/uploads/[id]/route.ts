/**
 * Chunked upload (SPEC.md §6.2).
 *
 * Netlify caps a function request body at 6 MB, so a transcript is sent in
 * sub-cap chunks to a staging area, then analysed or committed by key. The same
 * path runs locally, so there is one code path rather than two.
 *
 *   PUT    /api/uploads/:id?index=N   stage one chunk
 *   POST   /api/uploads/:id           analyse (dryRun) or commit
 *   DELETE /api/uploads/:id           discard staged chunks
 */

import { NextResponse } from 'next/server';
import { getStore, keys } from '@/lib/store';
import { analyse, commit } from '@/lib/ingest';
import { getProject } from '@/lib/repo';
import type { DayAction } from '@/lib/overlap';

/** Comfortably inside the platform cap, with room for request overhead. */
const CHUNK_LIMIT_BYTES = 3 * 1024 * 1024;

const MAX_CHUNKS = 400; // a guard against a runaway client

function badId(id: string): boolean {
  return !/^[A-Za-z0-9_-]{8,64}$/.test(id);
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (badId(id)) return NextResponse.json({ error: 'Bad upload id.' }, { status: 400 });

  const index = Number(new URL(request.url).searchParams.get('index') ?? NaN);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
    return NextResponse.json({ error: 'Bad chunk index.' }, { status: 400 });
  }

  const body = await request.text();
  if (Buffer.byteLength(body, 'utf8') > CHUNK_LIMIT_BYTES * 1.2) {
    return NextResponse.json({ error: 'Chunk too large.' }, { status: 413 });
  }

  const store = await getStore();
  await store.setText(keys.chunk(id, index), body);
  return NextResponse.json({ ok: true, index });
}

async function assemble(id: string): Promise<string | null> {
  const store = await getStore();
  const ks = (await store.list(keys.uploadPrefix(id))).sort();
  if (ks.length === 0) return null;
  const parts = await Promise.all(ks.map((k) => store.getText(k)));
  if (parts.some((p) => p === null)) return null;
  return parts.join('');
}

async function discard(id: string): Promise<void> {
  const store = await getStore();
  const ks = await store.list(keys.uploadPrefix(id));
  await Promise.all(ks.map((k) => store.delete(k)));
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (badId(id)) return NextResponse.json({ error: 'Bad upload id.' }, { status: 400 });

  let body: {
    projectSlug?: string;
    filename?: string;
    dryRun?: boolean;
    dayResolutions?: Record<string, DayAction>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const project = body.projectSlug ? await getProject(body.projectSlug) : null;
  if (!project) return NextResponse.json({ error: 'Unknown project.' }, { status: 404 });

  const text = await assemble(id);
  if (text === null) {
    return NextResponse.json({ error: 'No staged chunks for this upload.' }, { status: 404 });
  }

  const filename = body.filename ?? 'transcript.md';

  try {
    if (body.dryRun) {
      const { report } = await analyse(project, filename, text);
      return NextResponse.json({ dryRun: true, report });
    }
    const result = await commit(project, filename, text, body.dayResolutions ?? {});
    await discard(id);
    return NextResponse.json(result);
  } catch (err) {
    const e = err as Error & { status?: number; duplicateOfSha?: string };
    return NextResponse.json(
      { error: e.message, duplicateOfSha: e.duplicateOfSha },
      { status: e.status ?? 500 },
    );
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (badId(id)) return NextResponse.json({ error: 'Bad upload id.' }, { status: 400 });
  await discard(id);
  return NextResponse.json({ ok: true });
}
