'use client';

import { useState } from 'react';
import { Button } from './ui';

/**
 * A destructive action behind a typed confirmation.
 *
 * The button stays disabled until the project's name is typed exactly, so
 * "clear everything" cannot be reached by a stray click. The consequences are
 * spelled out in full before the field, not after it.
 */
export function DangerAction({
  action,
  slug,
  projectName,
  buttonLabel,
  consequences,
  extraFields,
}: {
  action: (formData: FormData) => void | Promise<void>;
  slug: string;
  projectName: string;
  buttonLabel: string;
  consequences: string[];
  extraFields?: React.ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed === projectName;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {extraFields}

      <ul className="space-y-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        {consequences.map((c) => (
          <li key={c} className="flex gap-2">
            <span aria-hidden style={{ color: 'var(--bad)' }}>
              &bull;
            </span>
            <span>{c}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
            Type <strong style={{ color: 'var(--text)' }}>{projectName}</strong> to confirm
          </span>
          <input
            type="text"
            name="confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-72"
            aria-describedby={`${slug}-confirm-hint`}
          />
        </label>
        <Button type="submit" variant="danger" disabled={!matches}>
          {buttonLabel}
        </Button>
      </div>
      <p id={`${slug}-confirm-hint`} className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
        {matches ? 'The name matches. This cannot be undone.' : 'The button unlocks once the name matches exactly.'}
      </p>
    </form>
  );
}
