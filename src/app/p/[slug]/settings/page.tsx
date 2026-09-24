import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, Card, Method, Pill } from '@/components/ui';
import { ThresholdPreview } from '@/components/ThresholdPreview';
import { DangerAction } from '@/components/DangerAction';
import { getDay, getProject, listDays, listTranscripts } from '@/lib/repo';
import { clearProjectData, deleteProject, setArchived, updateProject } from '@/app/actions';

export const dynamic = 'force-dynamic';

const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
];

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ saved?: string; error?: string; rebuilt?: string; cleared?: string; days?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const project = await getProject(slug);
  if (!project) notFound();

  // The project's actual operator-turn lengths, so the threshold can be set by eye.
  const days = await listDays(slug);
  const [docs, transcripts] = await Promise.all([
    Promise.all(days.map((d) => getDay(slug, d))),
    listTranscripts(slug),
  ]);
  const held = { transcripts: transcripts.length, days: days.length };
  const turnLengths = docs
    .flatMap((d) => d?.contributions.flatMap((c) => c.slice.turns.map((t) => t.chars)) ?? [])
    .sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/p/${slug}`} className="focusable rounded text-[12.5px] hover:underline" style={{ color: 'var(--text-muted)' }}>
          &larr; {project.name}
        </Link>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">Settings</h1>
      </div>

      <div className="flex flex-wrap gap-2">
        {sp.saved && <Pill tone="good">Saved</Pill>}
        {sp.rebuilt && <Pill tone="accent">Day figures rebuilt</Pill>}
        {sp.error === 'name-mismatch' && <Pill tone="bad">The typed name did not match.</Pill>}
        {sp.cleared !== undefined && (
          <Pill tone="good">
            Cleared {sp.cleared} transcript(s) and {sp.days ?? 0} day(s)
          </Pill>
        )}
        {sp.error === 'role-map' && <Pill tone="bad">The role map was not valid JSON.</Pill>}
      </div>

      <form action={updateProject} className="space-y-6">
        <input type="hidden" name="slug" value={project.slug} />

        <Card title="Project">
          <div className="grid gap-4 sm:grid-cols-2">
            <Label text="Name">
              <input type="text" name="name" defaultValue={project.name} className="w-full" />
            </Label>
            <Label text="Chart colour">
              <input type="text" name="colour" defaultValue={project.colour} className="mono w-full" />
            </Label>
            <Label text="Description" wide>
              <input type="text" name="description" defaultValue={project.description ?? ''} className="w-full" />
            </Label>
          </div>
        </Card>

        <Card title="Derivation" subtitle="Timezone and working language rebuild every day this project holds.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Label text="Timezone">
              <select name="timezone" defaultValue={project.timezone} className="w-full">
                {TIMEZONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                Decides where day boundaries fall.
              </span>
            </Label>
            <Label text="Working language">
              <select name="workingLanguage" defaultValue={project.workingLanguage} className="w-full">
                <option value="en">English</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="es">Spanish</option>
                <option value="nl">Dutch</option>
                <option value="it">Italian</option>
              </select>
              <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                Anything else counts as drift.
              </span>
            </Label>
            <Label text="Minimum cycles for the portfolio average">
              <input type="number" name="minCyclesForAverage" defaultValue={project.minCyclesForAverage} min={0} className="w-full" />
            </Label>
          </div>

          <div className="mt-6">
            <Label text="Operator answer threshold (characters)">
              <ThresholdPreview initial={project.answerThreshold} turns={turnLengths} />
            </Label>
            <Method>
              An operator turn shorter than this is an answer (an interruption); anything longer is a
              pasted dispatch. The distribution above is this project&rsquo;s actual turn lengths.
              Changing it affects new imports; re-parse a transcript to apply it to one already held.
            </Method>
          </div>

          <div className="mt-6">
            <Label text="Role map (JSON)">
              <textarea name="roleMap" defaultValue={JSON.stringify(project.roleMap)} rows={4} className="mono w-full text-[12.5px]" />
              <span className="mt-1 block text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                Lower-cased role name to role class, e.g.{' '}
                <code className="mono">{'{"team leader":"orchestrator","engineer":"worker","user":"operator"}'}</code>.
                Unlisted roles fall back to the built-in defaults.
              </span>
            </Label>
          </div>
        </Card>

        <Card
          title="Credit balance"
          subtitle="Used for the burndown. Optional — leave blank to turn the projection off."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Label text="Credits remaining">
              <input
                type="number"
                name="creditBalance"
                step="0.01"
                min={0}
                defaultValue={project.creditBalance ?? ''}
                placeholder="e.g. 250000"
                className="w-full"
              />
            </Label>
            <Label text="True as of">
              <input
                type="date"
                name="creditBalanceAsOf"
                defaultValue={project.creditBalanceAsOf ?? ''}
                className="w-full"
              />
            </Label>
          </div>
          <Method>
            Spend recorded on or after that date is subtracted from the balance, and the remainder is
            projected forward at the rate actually observed. Update the balance whenever you top up
            or check the real figure &mdash; the projection is only as good as the date it starts from.
            An account-wide balance covering every project is set on the portfolio page.
          </Method>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            Save
          </Button>
          <Button href={`/p/${slug}`} variant="ghost">
            Cancel
          </Button>
        </div>
      </form>

      <Card title="Archive" subtitle="Archived projects are hidden from the lists and excluded from cross-project averages.">
        <form action={setArchived}>
          <input type="hidden" name="slug" value={project.slug} />
          <input type="hidden" name="archive" value={project.archivedAt ? '0' : '1'} />
          <Button type="submit">{project.archivedAt ? 'Unarchive' : 'Archive'}</Button>
        </form>
      </Card>

      <Card
        title="Clear chat history data"
        subtitle="Empties the project so you can start again, keeping the project and its settings."
      >
        <p className="mb-4 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {held.transcripts === 0 ? (
            'This project holds no transcripts yet.'
          ) : (
            <>
              This project currently holds{' '}
              <strong style={{ color: 'var(--text)' }}>
                {held.transcripts} transcript{held.transcripts === 1 ? '' : 's'}
              </strong>{' '}
              across{' '}
              <strong style={{ color: 'var(--text)' }}>
                {held.days} day{held.days === 1 ? '' : 's'}
              </strong>
              .
            </>
          )}
        </p>
        <DangerAction
          action={clearProjectData}
          slug={project.slug}
          projectName={project.name}
          buttonLabel="Clear all data"
          consequences={[
            'Every uploaded transcript is deleted, including the raw files kept for evidence.',
            'Every cycle, drift, interruption and day figure derived from them is deleted.',
            'The calendar for this project is emptied, and it drops out of the portfolio averages.',
            'The project, its name, timezone, working language and thresholds are kept.',
            'This cannot be undone — re-upload the transcripts to rebuild the figures.',
          ]}
        />
      </Card>

      <Card title="Delete project" subtitle="Removes the project itself as well as all of its data.">
        <DangerAction
          action={deleteProject}
          slug={project.slug}
          projectName={project.name}
          buttonLabel="Delete project"
          consequences={[
            'Everything under "Clear chat history data" above, and the project record itself.',
            'The project disappears from the project list, the calendar and the portfolio.',
            'This cannot be undone.',
          ]}
        />
      </Card>
    </div>
  );
}

function Label({ text, children, wide }: { text: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
        {text}
      </span>
      {children}
    </label>
  );
}
