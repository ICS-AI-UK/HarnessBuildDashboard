'use client';

import { useState } from 'react';
import { ModelsByDay } from './charts';
import { Card, Method, fmt, fmtInt } from './ui';
import type { RangeMetrics } from '@/lib/metrics/aggregate';

/**
 * Which model was used each day (SPEC.md §5.13).
 *
 * Messages and credits are shown as separate measures because they disagree:
 * a model can account for a third of the messages and none of the cost.
 */
export function ModelsPanel({ metrics, scope }: { metrics: RangeMetrics; scope: string }) {
  const [measure, setMeasure] = useState<'messages' | 'credits'>('messages');

  const usage = metrics.modelUsage ?? {};
  const entries = Object.entries(usage).sort((a, b) => b[1].messages - a[1].messages);

  if (entries.length === 0) {
    return (
      <Card id="models" title="Models used" subtitle={scope}>
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          None of the transcripts in this period name a model. Exports that do carry the model in
          square brackets at the end of each message header, and list them in a{' '}
          <code className="mono">## Models used</code> block.
        </p>
      </Card>
    );
  }

  const models = entries.map(([m]) => m);
  const totalMessages = entries.reduce((a, [, v]) => a + v.messages, 0);
  const totalCredits = entries.reduce((a, [, v]) => a + v.credits, 0);

  return (
    <Card
      id="models"
      title="Models used"
      subtitle={`${scope} · ${models.length} model${models.length === 1 ? '' : 's'} across ${metrics.modelsByDay.length} day${metrics.modelsByDay.length === 1 ? '' : 's'}`}
      right={
        <div className="flex gap-1">
          {(['messages', 'credits'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMeasure(m)}
              aria-pressed={measure === m}
              className="focusable rounded-md px-2.5 py-1 text-[12px] capitalize"
              style={{
                border: '1px solid var(--border)',
                background: measure === m ? 'var(--accent-soft)' : 'transparent',
                color: measure === m ? 'var(--accent)' : 'var(--text-muted)',
                fontWeight: measure === m ? 600 : 400,
              }}
            >
              {m}
            </button>
          ))}
        </div>
      }
    >
      <ModelsByDay data={metrics.modelsByDay} models={models} measure={measure} />

      <div className="mt-5 overflow-x-auto">
        <table className="text-[13px]">
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              <th className="pb-2 text-left font-medium">Model</th>
              <th className="pb-2 text-right font-medium">Messages</th>
              <th className="pb-2 text-right font-medium">Share</th>
              <th className="pb-2 text-right font-medium">Credits</th>
              <th className="pb-2 text-right font-medium">Share of spend</th>
              <th className="pb-2 text-right font-medium">Per message</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([model, v], i) => (
              <tr key={model} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="py-1.5 font-medium">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: `var(--series-${(i % 6) + 1})` }}
                    />
                    <span className="mono">{model}</span>
                  </span>
                </td>
                <td className="num py-1.5 text-right">{fmtInt(v.messages)}</td>
                <td className="num py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                  {totalMessages ? `${Math.round((v.messages / totalMessages) * 100)}%` : '—'}
                </td>
                <td className="num py-1.5 text-right">{fmt(v.credits, 0)}</td>
                <td className="num py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                  {totalCredits ? `${Math.round((v.credits / totalCredits) * 100)}%` : '—'}
                </td>
                <td className="num py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>
                  {v.messages ? fmt(v.credits / v.messages, 2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Method>
        Counted from the model named on each message header. Message counts include the operator&rsquo;s
        own turns, which are free, so a model can hold a share of the messages without a share of the
        spend &mdash; switch the measure above to see which.
      </Method>
    </Card>
  );
}
