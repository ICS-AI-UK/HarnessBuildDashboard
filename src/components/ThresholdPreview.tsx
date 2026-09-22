'use client';

import { useMemo, useState } from 'react';

/**
 * The answer threshold with this project's actual operator-turn lengths plotted
 * behind it, so it can be set by eye rather than by guess (SPEC.md §5.6).
 */
export function ThresholdPreview({ initial, turns }: { initial: number; turns: number[] }) {
  const [value, setValue] = useState(initial);

  const { bins, maxCount, hi, answers, dispatches } = useMemo(() => {
    if (turns.length === 0) {
      return { bins: [] as number[], maxCount: 0, hi: 4000, answers: 0, dispatches: 0 };
    }
    // Log-ish scale: answers are tiny, dispatches are thousands of characters.
    const top = Math.max(...turns, value * 2, 1000);
    const count = 40;
    const width = top / count;
    const b = new Array(count).fill(0);
    for (const t of turns) b[Math.min(count - 1, Math.floor(t / width))]++;
    return {
      bins: b,
      maxCount: Math.max(...b),
      hi: top,
      answers: turns.filter((t) => t < value).length,
      dispatches: turns.filter((t) => t >= value).length,
    };
  }, [turns, value]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="number"
          name="answerThreshold"
          value={value}
          min={0}
          step={50}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-32"
        />
        <input
          type="range"
          min={0}
          max={Math.max(3000, hi)}
          step={50}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          className="flex-1 min-w-[180px]"
          aria-label="Answer threshold"
        />
        <span className="num text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          {answers} answer{answers === 1 ? '' : 's'} · {dispatches} dispatch
          {dispatches === 1 ? '' : 'es'}
        </span>
      </div>

      {bins.length > 0 && (
        <div className="relative mt-3 flex h-16 items-end gap-[2px]" aria-hidden>
          {bins.map((c, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-[2px]"
              style={{
                height: `${maxCount ? (c / maxCount) * 100 : 0}%`,
                minHeight: c > 0 ? 2 : 0,
                background:
                  (i + 0.5) * (hi / bins.length) < value ? 'var(--warn)' : 'var(--series-1)',
                opacity: c > 0 ? 0.85 : 0.15,
              }}
              title={`${Math.round(i * (hi / bins.length))}–${Math.round((i + 1) * (hi / bins.length))} chars: ${c}`}
            />
          ))}
        </div>
      )}
      {turns.length === 0 && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--text-faint)' }}>
          No operator turns yet — upload a transcript and the distribution appears here.
        </p>
      )}
    </div>
  );
}
