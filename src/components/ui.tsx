import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Stat } from '@/lib/metrics/stats';

/** Empty sets render as an em dash, never as 0 (SPEC.md §4). */
export const EMPTY = '—';

export function fmt(value: number | null | undefined, dp = 1, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  // A value that rounds to zero is zero. Without this, r = -0.0039 prints as
  // "-0.00", which reads as a negative finding rather than as no finding.
  const rounded = Math.round(value * 10 ** dp) / 10 ** dp;
  const safe = rounded === 0 ? 0 : rounded;
  const s = safe.toLocaleString('en-GB', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return unit ? `${s}${unit === '%' || unit === 's' ? '' : ' '}${unit}` : s;
}

/** Correlations carry an explicit sign, because the sign is the finding. */
export function fmtR(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  const rounded = Math.round(value * 10 ** dp) / 10 ** dp;
  if (rounded === 0) return (0).toFixed(dp);
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(dp)}`;
}

export function fmtStat(s: Stat | undefined, dp = 1, unit = ''): string {
  if (!s) return EMPTY;
  return fmt(s.value, dp, unit);
}

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return value.toLocaleString('en-GB');
}

export function fmtMinutes(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EMPTY;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function Card({
  title,
  subtitle,
  children,
  id,
  right,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  id?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`card p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
            {subtitle && (
              <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                {subtitle}
              </p>
            )}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Figure({
  value,
  label,
  note,
  tone = 'default',
  size = 'md',
}: {
  value: ReactNode;
  label: string;
  note?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  size?: 'md' | 'lg';
}) {
  const colour =
    tone === 'good'
      ? 'var(--good)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'bad'
          ? 'var(--bad)'
          : 'var(--text)';
  return (
    <div>
      <div
        className={`num font-semibold tracking-tight ${size === 'lg' ? 'text-[38px]' : 'text-[26px]'}`}
        style={{ color: colour, lineHeight: 1.1 }}
      >
        {value}
      </div>
      <div className="mt-1 text-[12.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
      {note && (
        <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
          {note}
        </div>
      )}
    </div>
  );
}

export function Pill({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'accent';
}) {
  const map = {
    default: { bg: 'var(--surface-2)', fg: 'var(--text-muted)' },
    good: { bg: 'color-mix(in srgb, var(--good) 14%, transparent)', fg: 'var(--good)' },
    warn: { bg: 'color-mix(in srgb, var(--warn) 16%, transparent)', fg: 'var(--warn)' },
    bad: { bg: 'color-mix(in srgb, var(--bad) 14%, transparent)', fg: 'var(--bad)' },
    accent: { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
  }[tone];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium"
      style={{ background: map.bg, color: map.fg }}
    >
      {children}
    </span>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      className="rounded-lg border border-dashed p-8 text-center"
      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}
    >
      <p className="text-[13.5px]">{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Button({
  children,
  href,
  type = 'button',
  variant = 'default',
  onClick,
  disabled,
  formAction,
}: {
  children: ReactNode;
  href?: string;
  type?: 'button' | 'submit';
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  onClick?: () => void;
  disabled?: boolean;
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const styles = {
    default: { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' },
    primary: { background: 'var(--accent)', color: '#fff', border: '1px solid transparent' },
    danger: { background: 'transparent', color: 'var(--bad)', border: '1px solid var(--bad)' },
    ghost: { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' },
  }[variant];

  const cls =
    'focusable inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-opacity disabled:opacity-50';

  if (href) {
    return (
      <Link href={href} className={cls} style={styles}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} className={cls} style={styles} onClick={onClick} disabled={disabled} formAction={formAction}>
      {children}
    </button>
  );
}

export function MetricRow({
  label,
  values,
  note,
}: {
  label: string;
  values: ReactNode[];
  note?: string;
}) {
  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <th
        scope="row"
        className="py-2 pr-4 text-left text-[13px] font-normal align-top"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
        {note && (
          <span className="block text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
            {note}
          </span>
        )}
      </th>
      {values.map((v, i) => (
        <td key={i} className="num py-2 pl-4 text-right text-[14px] font-medium tabular-nums">
          {v}
        </td>
      ))}
    </tr>
  );
}

/** A short explanation of how a figure was computed, for the footnote slot. */
export function Method({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
      {children}
    </p>
  );
}

export function SeriesDot({ colour }: { colour: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: colour }}
    />
  );
}
