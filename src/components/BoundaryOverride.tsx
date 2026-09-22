'use client';

import { useTransition } from 'react';
import { setBoundaryOverride } from '@/app/actions';

/** Force a cycle boundary the resolver got wrong (SPEC.md §7.5). */
export function BoundaryOverride({
  slug,
  sha,
  seq,
  value,
}: {
  slug: string;
  sha: string;
  seq: number;
  value: string;
}) {
  const [pending, start] = useTransition();

  return (
    <select
      className="text-[12px]"
      value={value}
      disabled={pending}
      onChange={(e) => {
        const form = new FormData();
        form.set('slug', slug);
        form.set('sha', sha);
        form.set('seq', String(seq));
        form.set('value', e.target.value);
        start(() => {
          void setBoundaryOverride(form);
        });
      }}
      aria-label="Cycle boundary override"
    >
      <option value="auto">Auto</option>
      <option value="dispatch">Dispatch</option>
      <option value="closeout">Close-out</option>
      <option value="neither">Neither</option>
    </select>
  );
}
