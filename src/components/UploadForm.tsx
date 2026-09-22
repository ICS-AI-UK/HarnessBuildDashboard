'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import type { ParseReport } from '@/lib/ingest';
import { actionsFor, type DayAction, type OverlapClass } from '@/lib/overlap';
import { Button, Pill } from './ui';

type ProjectOption = { name: string; slug: string; colour: string };

type Analysis = { filename: string; report: ParseReport; error?: string };

/**
 * Characters per staged chunk. The platform caps a function request body at
 * 6 MB; 1.5M characters is at most ~6 MB of UTF-8 in the worst case and ~1.5 MB
 * for transcript text, leaving ample headroom.
 */
const CHUNK_CHARS = 1_500_000;

const ACTION_LABELS: Record<DayAction, string> = {
  import: 'Import',
  skip: 'Skip',
  supersede: 'Supersede existing',
  pool: 'Pool with existing',
};

const CLASS_TONE: Record<OverlapClass, 'good' | 'warn' | 'bad' | 'accent' | 'default'> = {
  new: 'good',
  identical: 'default',
  superset: 'accent',
  subset: 'default',
  disjoint: 'accent',
  partial: 'warn',
};

export function UploadForm({
  projects,
  initialProjectSlug,
}: {
  projects: ProjectOption[];
  initialProjectSlug?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadIds = useRef<Map<string, string>>(new Map());
  const [projectSlug, setProjectSlug] = useState(initialProjectSlug ?? projects[0]?.slug ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<Analysis[] | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, DayAction>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ file: string; pct: number } | null>(null);

  const reset = () => {
    setAnalysis(null);
    setResolutions({});
    setMessage(null);
    uploadIds.current.clear();
  };

  const pick = (list: FileList | null) => {
    if (!list) return;
    setFiles([...list]);
    reset();
  };

  /**
   * Upload in sub-cap chunks. The deployment target limits a single request
   * body to 6 MB, and a multi-day export can be far larger, so the file is
   * staged in pieces and then analysed or committed by key.
   */
  const stage = useCallback(
    async (file: File, uploadId: string, onProgress: (pct: number) => void) => {
      const text = await file.text();
      const total = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
      for (let i = 0; i < total; i++) {
        const part = text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
        const res = await fetch(`/api/uploads/${uploadId}?index=${i}`, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: part,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Upload failed.');
        onProgress(Math.round(((i + 1) / total) * 100));
      }
    },
    [],
  );

  const post = useCallback(
    async (dryRun: boolean) => {
      if (!projectSlug || files.length === 0) return;
      setBusy(true);
      setMessage(null);
      setProgress(null);

      try {
        const rows: Analysis[] = [];
        const adjustments: string[] = [];
        for (const file of files) {
          const uploadId = uploadIds.current.get(file.name) ?? crypto.randomUUID().replace(/-/g, '');
          // Stage once, then reuse the staged chunks for the commit.
          if (!uploadIds.current.has(file.name)) {
            setProgress({ file: file.name, pct: 0 });
            await stage(file, uploadId, (pct) => setProgress({ file: file.name, pct }));
            uploadIds.current.set(file.name, uploadId);
          }
          setProgress(null);

          const res = await fetch(`/api/uploads/${uploadId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              projectSlug,
              filename: file.name,
              dryRun,
              dayResolutions: dryRun ? undefined : resolutions,
            }),
          });
          const data = await res.json();
          if (data.error) {
            rows.push({ filename: file.name, report: null as never, error: data.error });
            continue;
          }
          if (dryRun) rows.push({ filename: file.name, report: data.report });
          // A preview is taken against the project as it stood then; committing
          // an earlier file in the same batch can invalidate a later one's
          // answer. The server refuses the unsafe ones — say so rather than
          // letting the import look like it did what the preview showed.
          else if (Array.isArray(data.adjusted) && data.adjusted.length) {
            adjustments.push(
              ...data.adjusted.map(
                (a: { day: string; requested: string; applied: string }) =>
                  `${file.name}: ${a.day} was already held, so it was ${a.applied === 'skip' ? 'skipped' : a.applied} rather than ${a.requested}ed.`,
              ),
            );
          }
        }

        if (dryRun) {
          setAnalysis(rows);
          const defaults: Record<string, DayAction> = {};
          for (const r of rows) {
            if (!r.report) continue;
            for (const d of r.report.days) defaults[d.day] = d.defaultAction;
          }
          setResolutions(defaults);
          const failed = rows.filter((r) => r.error);
          if (failed.length) setMessage(failed.map((f) => `${f.filename}: ${f.error}`).join(' · '));
        } else {
          const failed = rows.filter((r) => r.error);
          if (failed.length) {
            setMessage(failed.map((f) => `${f.filename}: ${f.error}`).join(' · '));
            return;
          }
          uploadIds.current.clear();
          if (adjustments.length) {
            // Keep the user here to read what changed, rather than bouncing to a
            // dashboard whose numbers differ from the preview they approved.
            setAnalysis(null);
            setMessage(adjustments.join(' '));
            setFiles([]);
            router.refresh();
            return;
          }
          router.push(`/p/${projectSlug}`);
          router.refresh();
        }
      } catch (err) {
        setMessage((err as Error).message);
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [files, projectSlug, resolutions, router, stage],
  );

  const allDays = (analysis ?? []).flatMap((a) => a.report?.days ?? []);
  const touchesExisting = allDays.some((d) => d.overlapClass !== 'new');
  const needsDecision = allDays.some((d) => d.overlapClass === 'partial');

  const bulkSet = (cls: OverlapClass, action: DayAction) => {
    setResolutions((prev) => {
      const next = { ...prev };
      for (const d of allDays) if (d.overlapClass === cls) next[d.day] = action;
      return next;
    });
  };

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              Project
            </span>
            <select
              value={projectSlug}
              onChange={(e) => {
                setProjectSlug(e.target.value);
                reset();
              }}
              className="w-full"
            >
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files);
          }}
          className="mt-4 rounded-lg border border-dashed p-8 text-center transition-colors"
          style={{
            borderColor: dragging ? 'var(--accent)' : 'var(--border-strong)',
            background: dragging ? 'var(--accent-soft)' : 'transparent',
          }}
        >
          <p className="text-[13.5px]" style={{ color: 'var(--text-muted)' }}>
            Drop transcript files here, or
          </p>
          <div className="mt-2">
            <Button onClick={() => inputRef.current?.click()}>Choose files</Button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            multiple
            hidden
            onChange={(e) => pick(e.target.files)}
          />
          <p className="mt-3 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            A file may contain any number of days. Days are read from the timestamps, not the
            filename. Large files are uploaded in pieces, so there is no size limit.
          </p>
        </div>

        {progress && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-[12px]" style={{ color: 'var(--text-muted)' }}>
              <span className="mono truncate">{progress.file}</span>
              <span className="num">{progress.pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progress.pct}%`, background: 'var(--accent)' }}
              />
            </div>
          </div>
        )}

        {files.length > 0 && (
          <ul className="mt-4 space-y-1 text-[13px]">
            {files.map((f) => (
              <li key={f.name} className="flex items-center justify-between gap-3">
                <span className="mono truncate">{f.name}</span>
                <span className="num shrink-0" style={{ color: 'var(--text-faint)' }}>
                  {(f.size / 1024).toFixed(0)} KB
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => post(true)} disabled={busy || files.length === 0}>
            {busy && !analysis ? 'Parsing…' : 'Preview'}
          </Button>
          {analysis && (
            <Button variant="primary" onClick={() => post(false)} disabled={busy}>
              {busy ? 'Importing…' : 'Commit import'}
            </Button>
          )}
          {analysis && needsDecision && (
            <span className="text-[12.5px]" style={{ color: 'var(--warn)' }}>
              Some days overlap in both directions and will be skipped unless you choose otherwise.
            </span>
          )}
          {message && (
            <span className="text-[13px]" style={{ color: 'var(--bad)' }}>
              {message}
            </span>
          )}
        </div>
      </div>

      {analysis?.map((a) => (
        <ReportCard
          key={a.filename}
          analysis={a}
          resolutions={resolutions}
          onChange={(day, action) => setResolutions((p) => ({ ...p, [day]: action }))}
          onBulk={bulkSet}
          touchesExisting={touchesExisting}
        />
      ))}
    </div>
  );
}

function ReportCard({
  analysis,
  resolutions,
  onChange,
  onBulk,
  touchesExisting,
}: {
  analysis: Analysis;
  resolutions: Record<string, DayAction>;
  onChange: (day: string, action: DayAction) => void;
  onBulk: (cls: OverlapClass, action: DayAction) => void;
  touchesExisting: boolean;
}) {
  const r = analysis.report;
  if (!r) {
    return (
      <div className="card p-5">
        <p className="text-[13px]" style={{ color: 'var(--bad)' }}>
          {analysis.filename}: {analysis.error}
        </p>
      </div>
    );
  }

  const classes = [...new Set(r.days.map((d) => d.overlapClass))];

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="mono text-[14px] font-semibold">{r.filename}</h2>
        <div className="flex flex-wrap gap-1.5">
          <Pill>{r.parsedEventCount.toLocaleString()} events</Pill>
          <Pill>{r.days.length} day{r.days.length === 1 ? '' : 's'}</Pill>
          <Pill>{r.cycles} cycles</Pill>
          {r.openCycles > 0 && <Pill tone="warn">{r.openCycles} open</Pill>}
          {r.lowConfidenceCycles > 0 && <Pill tone="warn">{r.lowConfidenceCycles} low confidence</Pill>}
        </div>
      </div>

      {r.duplicateOfSha && (
        <p className="mt-3 rounded-md p-2.5 text-[13px]" style={{ background: 'color-mix(in srgb, var(--bad) 12%, transparent)', color: 'var(--bad)' }}>
          This exact file is already in the project. Importing it again will be rejected.
        </p>
      )}

      <div className="mt-4 grid gap-3 text-[12.5px] sm:grid-cols-3">
        <div>
          <span style={{ color: 'var(--text-faint)' }}>Declared</span>
          <div>
            {r.declaredRangeText ?? '—'}
            {r.declaredMessageCount !== null && `, ${r.declaredMessageCount.toLocaleString()} messages`}
          </div>
        </div>
        <div>
          <span style={{ color: 'var(--text-faint)' }}>Parsed</span>
          <div>{r.parsedEventCount.toLocaleString()} events (authoritative)</div>
        </div>
        <div>
          <span style={{ color: 'var(--text-faint)' }}>Roles observed</span>
          <div>
            {Object.entries(r.rolesObserved)
              .map(([role, cls]) => `${role} → ${cls}`)
              .join(', ')}
          </div>
        </div>
      </div>

      {touchesExisting && classes.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12.5px]">
          <span style={{ color: 'var(--text-muted)' }}>Apply to all:</span>
          {classes
            .filter((c) => c !== 'new')
            .map((c) => (
              <span key={c} className="flex items-center gap-1">
                <Pill tone={CLASS_TONE[c]}>{c}</Pill>
                <select
                  className="text-[12px]"
                  onChange={(e) => onBulk(c, e.target.value as DayAction)}
                  defaultValue=""
                >
                  <option value="" disabled>
                    set&hellip;
                  </option>
                  {actionsFor(c).map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABELS[a]}
                    </option>
                  ))}
                </select>
              </span>
            ))}
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="text-[13px]">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              <th className="pb-2 text-left font-medium">Day</th>
              <th className="pb-2 text-right font-medium">Events</th>
              <th className="pb-2 text-right font-medium">Cycles</th>
              <th className="pb-2 text-left font-medium">Overlap</th>
              <th className="pb-2 text-left font-medium">What happens</th>
              <th className="pb-2 text-left font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {r.days.map((d) => (
              <tr key={d.day} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="num py-2 font-medium">{d.day}</td>
                <td className="num py-2 text-right">{d.eventCount.toLocaleString()}</td>
                <td className="num py-2 text-right">{d.cycleCount}</td>
                <td className="py-2">
                  <Pill tone={CLASS_TONE[d.overlapClass]}>{d.overlapClass}</Pill>
                </td>
                <td className="py-2" style={{ color: 'var(--text-muted)' }}>
                  {d.recommendation}
                </td>
                <td className="py-2">
                  <select
                    value={resolutions[d.day] ?? d.defaultAction}
                    onChange={(e) => onChange(d.day, e.target.value as DayAction)}
                    className="text-[12.5px]"
                  >
                    {actionsFor(d.overlapClass).map((a) => (
                      <option key={a} value={a}>
                        {ACTION_LABELS[a]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r.warnings.length > 0 && (
        <ul className="mt-4 space-y-1 text-[12.5px]" style={{ color: 'var(--warn)' }}>
          {r.warnings.map((w, i) => (
            <li key={i}>
              <span className="mono" style={{ color: 'var(--text-faint)' }}>
                {w.code}
              </span>{' '}
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
