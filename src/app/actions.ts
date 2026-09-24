'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  clearProjectData as clearData,
  deleteProject as removeProject,
  deleteTranscript as removeTranscript,
  getProject,
  getTranscript,
  listTranscripts,
  rebuildDays,
  rebuildProject,
  saveProject,
  saveTranscript,
  type Project,
} from '@/lib/repo';
import { PALETTE, listProjects, slugify } from '@/lib/queries';
import { isValidTimezone } from '@/lib/time';
import type { RoleClass } from '@/lib/parser/types';

/** A blank field clears the balance; anything unparsable is treated as blank. */
function parseBalance(raw: FormDataEntryValue | null): number | null {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseDay(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Account-wide credit balance, for the estate burndown on the portfolio. */
export async function updatePortfolioBalance(formData: FormData) {
  const { savePortfolioSettings } = await import('@/lib/repo');
  await savePortfolioSettings({
    creditBalance: parseBalance(formData.get('creditBalance')),
    creditBalanceAsOf: parseDay(formData.get('creditBalanceAsOf')),
    updatedAt: null,
  });
  revalidatePath('/portfolio');
  redirect('/portfolio?balanceSaved=1');
}

export async function createProject(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;

  const existing = await listProjects(true);
  let slug = slugify(name);
  let n = 1;
  while (existing.some((p) => p.slug === slug)) slug = `${slugify(name)}-${++n}`;

  const now = new Date().toISOString();
  const project: Project = {
    slug,
    name,
    description: String(formData.get('description') ?? '').trim() || null,
    colour: PALETTE[existing.length % PALETTE.length],
    workingLanguage: String(formData.get('workingLanguage') ?? 'en'),
    timezone: String(formData.get('timezone') ?? 'UTC'),
    answerThreshold: 600,
    minCyclesForAverage: 5,
    roleMap: {},
    creditBalance: null,
    creditBalanceAsOf: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveProject(project);

  revalidatePath('/');
  redirect(`/p/${project.slug}`);
}

export async function updateProject(formData: FormData) {
  const slug = String(formData.get('slug'));
  const existing = await getProject(slug);
  if (!existing) return;

  const timezone = String(formData.get('timezone') ?? existing.timezone);
  const answerThreshold = Number(formData.get('answerThreshold') ?? existing.answerThreshold);
  const minCycles = Number(formData.get('minCyclesForAverage') ?? existing.minCyclesForAverage);

  let roleMap = existing.roleMap;
  try {
    const raw = String(formData.get('roleMap') ?? '');
    if (raw.trim()) roleMap = JSON.parse(raw) as Record<string, RoleClass>;
  } catch {
    redirect(`/p/${slug}/settings?error=role-map`);
  }

  const updated: Project = {
    ...existing,
    name: String(formData.get('name') ?? existing.name).trim() || existing.name,
    description: String(formData.get('description') ?? '').trim() || null,
    colour: String(formData.get('colour') ?? existing.colour),
    workingLanguage: String(formData.get('workingLanguage') ?? existing.workingLanguage),
    timezone: isValidTimezone(timezone) ? timezone : existing.timezone,
    answerThreshold: Number.isFinite(answerThreshold) ? answerThreshold : existing.answerThreshold,
    minCyclesForAverage: Number.isFinite(minCycles) ? minCycles : existing.minCyclesForAverage,
    roleMap,
    creditBalance: parseBalance(formData.get('creditBalance')),
    creditBalanceAsOf: parseDay(formData.get('creditBalanceAsOf')),
    updatedAt: new Date().toISOString(),
  };
  await saveProject(updated);

  // The timezone decides where day boundaries fall and the language decides what
  // counts as drift, so a change to either moves historical figures. Anything
  // that only affects parsing needs the transcripts re-read, which the
  // re-parse action on the transcript screen does.
  const rebuildNeeded =
    updated.timezone !== existing.timezone || updated.workingLanguage !== existing.workingLanguage;
  if (rebuildNeeded) await rebuildProject(updated);

  revalidatePath('/');
  revalidatePath(`/p/${slug}`);
  redirect(`/p/${slug}/settings?saved=1${rebuildNeeded ? '&rebuilt=1' : ''}`);
}

export async function setArchived(formData: FormData) {
  const slug = String(formData.get('slug'));
  const project = await getProject(slug);
  if (!project) return;
  await saveProject({
    ...project,
    archivedAt: String(formData.get('archive')) === '1' ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  });
  revalidatePath('/');
  revalidatePath('/portfolio');
  redirect(`/p/${slug}/settings`);
}

/**
 * Remove every uploaded transcript and every figure derived from it, keeping
 * the project and its settings. Irreversible: the raw transcripts go too, so
 * the evidence views have nothing left to rebuild from.
 */
export async function clearProjectData(formData: FormData) {
  const slug = String(formData.get('slug'));
  const confirm = String(formData.get('confirm') ?? '').trim();
  const project = await getProject(slug);
  if (!project) redirect('/');
  if (confirm !== project.name) {
    redirect(`/p/${slug}/settings?error=name-mismatch`);
  }

  const { transcripts, days } = await clearData(slug);

  revalidatePath('/');
  revalidatePath(`/p/${slug}`);
  revalidatePath('/calendar');
  revalidatePath('/portfolio');
  redirect(`/p/${slug}/settings?cleared=${transcripts}&days=${days}`);
}

export async function deleteProject(formData: FormData) {
  const slug = String(formData.get('slug'));
  const confirm = String(formData.get('confirm') ?? '').trim();
  const project = await getProject(slug);
  if (!project || confirm !== project.name) {
    redirect(`/p/${slug}/settings?error=name-mismatch`);
  }
  await removeProject(slug);
  revalidatePath('/');
  redirect('/');
}

export async function deleteTranscript(formData: FormData) {
  const slug = String(formData.get('slug'));
  const sha = String(formData.get('sha'));
  const project = await getProject(slug);
  if (!project) return;

  const touched = await removeTranscript(slug, sha);
  await rebuildDays(project, touched);

  revalidatePath(`/p/${slug}`);
  redirect(`/p/${slug}?deleted=${touched.length}`);
}

/** Revisit one day's overlap decision (SPEC.md §7.5). */
export async function setDayContributes(formData: FormData) {
  const slug = String(formData.get('slug'));
  const sha = String(formData.get('sha'));
  const day = String(formData.get('day'));
  const contributes = String(formData.get('contributes')) === '1';

  const project = await getProject(slug);
  const record = await getTranscript(slug, sha);
  if (!project || !record) return;

  const entry = record.days.find((d) => d.day === day);
  if (!entry) return;
  entry.contributes = contributes;
  entry.supersededBySha = null;
  entry.resolvedBy = 'user';
  await saveTranscript(slug, record);

  // Restoring a contribution to a day another transcript superseded would count
  // the shared events twice, so the other one steps aside.
  if (contributes) {
    for (const other of await listTranscripts(slug)) {
      if (other.sha256 === sha) continue;
      const od = other.days.find((d) => d.day === day && d.supersededBySha === sha);
      if (od) {
        od.contributes = false;
        await saveTranscript(slug, other);
      }
    }
  }

  await rebuildDays(project, [day]);
  revalidatePath(`/p/${slug}/t/${sha}`);
  revalidatePath(`/p/${slug}`);
}

/** Force a cycle boundary by hand; overrides survive re-parsing (SPEC.md §7.5). */
export async function setBoundaryOverride(formData: FormData) {
  const slug = String(formData.get('slug'));
  const sha = String(formData.get('sha'));
  const seq = Number(formData.get('seq'));
  const value = String(formData.get('value'));

  const record = await getTranscript(slug, sha);
  if (!record || !Number.isInteger(seq)) return;

  if (value === 'auto') delete record.boundaryOverrides[seq];
  else record.boundaryOverrides[seq] = value as 'dispatch' | 'closeout' | 'neither';

  await saveTranscript(slug, record);
  revalidatePath(`/p/${slug}/t/${sha}`);
}

/**
 * Re-read a stored transcript with the project's current settings and rewrite
 * its day slices. Needed after a setting that changes parsing, such as the
 * answer threshold or the role map.
 */
export async function reparseTranscript(formData: FormData) {
  const slug = String(formData.get('slug'));
  const sha = String(formData.get('sha'));
  const project = await getProject(slug);
  if (!project) return;

  const { reparseAndStore } = await import('@/lib/reparse');
  const days = await reparseAndStore(project, sha);
  await rebuildDays(project, days);

  revalidatePath(`/p/${slug}/t/${sha}`);
  revalidatePath(`/p/${slug}`);
  redirect(`/p/${slug}/t/${sha}?reparsed=${days.length}`);
}
