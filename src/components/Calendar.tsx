import Link from 'next/link';
import { addMonths, dayRange, mondayIndex, monthBounds } from '@/lib/time';
import type { CalendarDay } from '@/lib/queries';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Shading ramp by cycle count. Colour is never the only signal — the count is printed. */
function shade(cycles: number, maxCycles: number): string {
  if (cycles === 0) return 'transparent';
  const t = maxCycles <= 1 ? 1 : Math.min(1, cycles / maxCycles);
  const pct = 10 + Math.round(t * 30);
  return `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;
}

export function MonthGrid({
  month,
  coverage,
  basePath,
  projectSlug,
}: {
  month: string; // YYYY-MM
  coverage: Map<string, CalendarDay>;
  basePath: string;
  projectSlug?: string;
}) {
  const { from, to } = monthBounds(`${month}-01`);
  const days = dayRange(from, to);
  const lead = mondayIndex(from);
  const maxCycles = Math.max(1, ...[...coverage.values()].map((c) => c.totalCycles));

  const cells: Array<string | null> = [...Array(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold tracking-tight">{monthLabel(month)}</h3>
        <div className="flex items-center gap-1">
          <Link
            href={`${basePath}?month=${addMonths(month, -1)}`}
            className="focusable rounded px-2 py-1 text-[13px] hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Previous month"
          >
            &lsaquo;
          </Link>
          <Link
            href={`${basePath}?month=${addMonths(month, 1)}`}
            className="focusable rounded px-2 py-1 text-[13px] hover:bg-[var(--surface-2)]"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Next month"
          >
            &rsaquo;
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="pb-1 text-center text-[11px] font-medium"
            style={{ color: 'var(--text-faint)' }}
          >
            {w}
          </div>
        ))}

        {cells.map((day, i) => {
          if (!day) return <div key={`pad-${i}`} />;
          const cov = coverage.get(day);
          const covered = Boolean(cov);
          const cycles = cov?.totalCycles ?? 0;
          const dayNum = Number(day.slice(8));

          const label = covered
            ? `${day}, ${cycles} cycle${cycles === 1 ? '' : 's'} across ${cov!.projects.length} project${cov!.projects.length === 1 ? '' : 's'}`
            : `${day}, no transcript uploaded`;

          const href = projectSlug
            ? `/p/${projectSlug}/d/${day}`
            : cov && cov.projects.length === 1
              ? `/p/${cov.projects[0].slug}/d/${day}`
              : null;

          const inner = (
            <>
              <div className="flex items-start justify-between">
                <span
                  className="num text-[12px] font-medium"
                  style={{ color: covered ? 'var(--text)' : 'var(--text-faint)' }}
                >
                  {dayNum}
                </span>
                {covered && cycles > 0 && (
                  <span className="num text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
                    {cycles}
                  </span>
                )}
              </div>
              {covered && (
                <div className="mt-auto flex flex-wrap gap-1 pt-1">
                  {cov!.projects.slice(0, 4).map((p) => (
                    <span
                      key={p.slug}
                      title={`${p.name} — ${p.cycles} cycle${p.cycles === 1 ? '' : 's'}`}
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: p.colour }}
                    />
                  ))}
                  {cov!.projects.length > 4 && (
                    <span className="text-[9px]" style={{ color: 'var(--text-faint)' }}>
                      +{cov!.projects.length - 4}
                    </span>
                  )}
                </div>
              )}
              {covered && cycles === 0 && (
                <span
                  className="mt-auto text-[9.5px] leading-tight"
                  style={{ color: 'var(--text-faint)' }}
                  title="A transcript covers this day but no cycles were resolved"
                >
                  no cycles
                </span>
              )}
            </>
          );

          const style = {
            background: covered ? shade(cycles, maxCycles) : 'transparent',
            borderColor: covered ? 'var(--border-strong)' : 'var(--border)',
            borderStyle: covered ? 'solid' : 'dashed',
          } as const;

          const cls = 'focusable flex h-[62px] flex-col rounded-md border p-1.5 text-left';

          return href ? (
            <Link key={day} href={href} className={`${cls} transition-shadow hover:shadow-sm`} style={style} aria-label={label} title={label}>
              {inner}
            </Link>
          ) : (
            <div key={day} className={cls} style={style} aria-label={label} title={label}>
              {inner}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border border-dashed" style={{ borderColor: 'var(--border)' }} />
          No upload
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border" style={{ borderColor: 'var(--border-strong)' }} />
          Uploaded, no cycles
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border" style={{ borderColor: 'var(--border-strong)', background: shade(maxCycles, maxCycles) }} />
          Shading by cycle count
        </span>
      </div>
    </div>
  );
}

/** Twelve-month context strip above the grid. */
export function YearStrip({
  month,
  coverage,
  basePath,
}: {
  month: string;
  coverage: Map<string, CalendarDay>;
  basePath: string;
}) {
  const months = Array.from({ length: 12 }, (_, i) => addMonths(month, i - 11));
  const totals = months.map((m) => {
    let cycles = 0;
    let days = 0;
    for (const [day, c] of coverage) {
      if (day.startsWith(m)) {
        cycles += c.totalCycles;
        days += 1;
      }
    }
    return { month: m, cycles, days };
  });
  const maxC = Math.max(1, ...totals.map((t) => t.cycles));

  const total = totals.reduce((a, t) => a + t.cycles, 0);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight">Cycles per month</h3>
        <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          Last 12 months &middot; {total.toLocaleString()} cycles &middot; tallest bar ={' '}
          {maxC.toLocaleString()}. Select a month to open it.
        </p>
      </div>

      <div className="flex gap-1">
        {totals.map((t) => {
          const current = t.month === month;
          const label = `${monthLabel(t.month)}: ${t.cycles} cycle${t.cycles === 1 ? '' : 's'} across ${t.days} day${t.days === 1 ? '' : 's'}`;
          return (
            <Link
              key={t.month}
              href={`${basePath}?month=${t.month}`}
              className="focusable group flex flex-1 flex-col items-center gap-1 rounded p-1"
              title={label}
              aria-label={label}
              aria-current={current ? 'true' : undefined}
            >
              {/* A fixed track so empty months still read as months, with the
                  filled portion proportional to that month's cycle count. */}
              <span
                className="flex w-full items-end rounded-sm"
                style={{
                  height: 34,
                  background: 'var(--surface-2)',
                  border: current ? '1px solid var(--accent)' : '1px solid transparent',
                }}
              >
                <span
                  className="w-full rounded-sm transition-all"
                  style={{
                    height: t.cycles ? `${Math.max(12, (t.cycles / maxC) * 100)}%` : 0,
                    background: 'var(--accent)',
                    opacity: current ? 1 : 0.5,
                  }}
                />
              </span>
              {/* Month and year, because a bare "01" beside "12" reads as a
                  count rather than as January of the following year. */}
              <span
                className="num whitespace-nowrap text-[9.5px] leading-tight"
                style={{
                  color: current ? 'var(--text)' : 'var(--text-faint)',
                  fontWeight: current ? 600 : 400,
                }}
              >
                {MONTH_NAMES[Number(t.month.slice(5)) - 1].slice(0, 3)} {t.month.slice(2, 4)}
              </span>
              <span
                className="num text-[9.5px] leading-none"
                style={{ color: t.cycles ? 'var(--accent)' : 'transparent' }}
              >
                {t.cycles || 0}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
