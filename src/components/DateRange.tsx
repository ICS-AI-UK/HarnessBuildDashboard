'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from './ui';

function shift(to: string, days: number): string {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days + 1);
  return d.toISOString().slice(0, 10);
}

function long(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function DateRange({
  basePath,
  from,
  to,
  span,
}: {
  basePath: string;
  from: string;
  to: string;
  span: { from: string; to: string };
}) {
  const router = useRouter();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  const go = (nf: string, nt: string) => router.push(`${basePath}?from=${nf}&to=${nt}`);

  const presets = [
    { label: 'All', from: span.from, to: span.to },
    { label: 'Last day', from: span.to, to: span.to },
    { label: 'Last 7 days', from: shift(span.to, 7), to: span.to },
    { label: 'Last 30 days', from: shift(span.to, 30), to: span.to },
  ];
  const active = presets.find((p) => p.from === from && p.to === to)?.label ?? null;

  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => {
            const isActive = active === p.label;
            return (
              <button
                key={p.label}
                onClick={() => go(p.from, p.to)}
                aria-pressed={isActive}
                className="focusable rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors"
                style={{
                  border: '1px solid var(--border)',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              From
            </span>
            <input type="date" value={f} min={span.from} max={span.to} onChange={(e) => setF(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              To
            </span>
            <input type="date" value={t} min={span.from} max={span.to} onChange={(e) => setT(e.target.value)} />
          </label>
          <Button onClick={() => go(f, t)}>Apply</Button>
        </div>
      </div>

      {/* Say in words what is on screen, so no figure below is ambiguous about
          the period it covers. */}
      <p className="mt-3 border-t pt-2.5 text-[12.5px]" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
        Showing{' '}
        <strong style={{ color: 'var(--text)' }}>
          {from === to ? long(from) : `${long(from)} to ${long(to)}`}
        </strong>
        {active && <> ({active.toLowerCase()})</>}.
        {(from !== span.from || to !== span.to) && (
          <>
            {' '}
            This project holds {long(span.from)} to {long(span.to)} &mdash;{' '}
            <button
              onClick={() => go(span.from, span.to)}
              className="focusable rounded underline"
              style={{ color: 'var(--accent)' }}
            >
              show all
            </button>
            .
          </>
        )}
      </p>
    </div>
  );
}
