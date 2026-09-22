'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const AXIS = { fontSize: 11, fill: 'var(--text-faint)' };

function TooltipBox({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div
      className="rounded-md border px-2.5 py-2 text-[12px] shadow-lg"
      style={{ background: 'var(--surface)', borderColor: 'var(--border-strong)', color: 'var(--text)' }}
    >
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3">
          <span style={{ color: 'var(--text-muted)' }}>{k}</span>
          <span className="num ml-auto font-medium">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Cycle-time distribution with median and p90 rules (SPEC.md §5.3). */
export function DurationHistogram({
  durations,
  median,
  p90,
  colour = 'var(--series-1)',
}: {
  durations: number[];
  median: number | null;
  p90: number | null;
  colour?: string;
}) {
  if (durations.length === 0) return null;
  const hi = Math.max(...durations);
  const binCount = Math.min(16, Math.max(6, Math.ceil(Math.sqrt(durations.length) * 2)));
  const width = Math.max(hi / binCount, 0.5);
  const bins = Array.from({ length: binCount }, (_, i) => ({
    x: i * width,
    label: `${(i * width).toFixed(0)}–${((i + 1) * width).toFixed(0)}`,
    count: 0,
  }));
  for (const d of durations) {
    const i = Math.min(binCount - 1, Math.floor(d / width));
    bins[i].count++;
  }

  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer>
        <BarChart data={bins} margin={{ top: 8, right: 8, bottom: 4, left: -20 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval={0} angle={-30} textAnchor="end" height={46} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox
                  rows={[
                    ['Minutes', String(payload[0].payload.label)],
                    ['Cycles', String(payload[0].value)],
                  ]}
                />
              ) : null
            }
          />
          {median !== null && (
            <ReferenceLine
              x={bins[Math.min(binCount - 1, Math.floor(median / width))]?.label}
              stroke="var(--good)"
              strokeDasharray="4 3"
              label={{ value: 'median', position: 'top', fontSize: 10, fill: 'var(--good)' }}
            />
          )}
          {p90 !== null && (
            <ReferenceLine
              x={bins[Math.min(binCount - 1, Math.floor(p90 / width))]?.label}
              stroke="var(--warn)"
              strokeDasharray="4 3"
              label={{ value: 'p90', position: 'top', fontSize: 10, fill: 'var(--warn)' }}
            />
          )}
          <Bar dataKey="count" fill={colour} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Correlation scatter: x against cycle duration (SPEC.md §5.4). */
export function CorrelationScatter({
  points,
  xLabel,
  colour = 'var(--series-1)',
}: {
  points: Array<{ x: number; y: number; tag: string }>;
  xLabel: string;
  colour?: string;
}) {
  if (points.length === 0) return null;
  return (
    <div style={{ width: '100%', height: 200 }}>
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: -18 }}>
          <CartesianGrid stroke="var(--grid)" />
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
            label={{ value: xLabel, position: 'insideBottom', offset: -12, fontSize: 11, fill: 'var(--text-faint)' }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="minutes"
            tick={AXIS}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ strokeDasharray: '3 3', stroke: 'var(--border-strong)' }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox
                  rows={[
                    ['Cycle', String(payload[0].payload.tag)],
                    [xLabel, payload[0].payload.x.toLocaleString()],
                    ['Minutes', payload[0].payload.y.toFixed(1)],
                  ]}
                />
              ) : null
            }
          />
          <Scatter data={points} fill={colour} fillOpacity={0.75} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Where the elapsed day goes — a single stacked bar (SPEC.md §5.5). */
export function ElapsedBar({
  inCycleS,
  operatorWaitS,
  otherS,
}: {
  inCycleS: number;
  operatorWaitS: number;
  otherS: number;
}) {
  const total = inCycleS + operatorWaitS + otherS;
  if (total <= 0) return null;
  const bands = [
    { label: 'In cycle', value: inCycleS, colour: 'var(--series-1)' },
    { label: 'Operator wait', value: operatorWaitS, colour: 'var(--series-3)' },
    { label: 'Before first / after last', value: otherS, colour: 'var(--surface-2)' },
  ];
  return (
    <div>
      <div
        className="flex h-9 w-full overflow-hidden rounded-md"
        style={{ border: '1px solid var(--border)' }}
        role="img"
        aria-label={bands
          .map((b) => `${b.label}: ${Math.round(b.value / 60)} minutes`)
          .join('; ')}
      >
        {bands.map((b) =>
          b.value <= 0 ? null : (
            <div
              key={b.label}
              title={`${b.label}: ${Math.round(b.value / 60)} min`}
              style={{ width: `${(b.value / total) * 100}%`, background: b.colour }}
            />
          ),
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px]">
        {bands.map((b) => (
          <li key={b.label} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: b.colour, border: '1px solid var(--border-strong)' }}
            />
            <span style={{ color: 'var(--text-muted)' }}>{b.label}</span>
            <span className="num font-medium">
              {Math.round(b.value / 60)} min ({Math.round((b.value / total) * 100)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Per-day trend for a range scope. */
export function DayTrend({
  data,
  dataKey,
  label,
  colour = 'var(--series-1)',
  kind = 'bar',
}: {
  data: Array<{ day: string; value: number | null }>;
  dataKey?: string;
  label: string;
  colour?: string;
  kind?: 'bar' | 'line';
}) {
  const rows = data.map((d) => ({ day: d.day.slice(5), value: d.value }));
  const Chart = kind === 'bar' ? BarChart : LineChart;
  return (
    <div style={{ width: '100%', height: 150 }}>
      <ResponsiveContainer>
        <Chart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: -24 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={16} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload, label: l }) =>
              active && payload?.length && payload[0].value !== null ? (
                <TooltipBox rows={[['Day', String(l)], [label, Number(payload[0].value).toLocaleString()]]} />
              ) : null
            }
          />
          {kind === 'bar' ? (
            <Bar dataKey="value" fill={colour} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          ) : (
            <Line dataKey="value" stroke={colour} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal comparison of one metric across projects, with the average ruled. */
export function PortfolioBars({
  values,
  average,
  dp,
  unit,
}: {
  values: Array<{ name: string; value: number | null; colour: string; outlier: boolean }>;
  average: number | null;
  dp: number;
  unit: string;
}) {
  const rows = values.filter((v) => v.value !== null) as Array<{
    name: string;
    value: number;
    colour: string;
    outlier: boolean;
  }>;
  if (rows.length === 0) return null;
  return (
    <div style={{ width: '100%', height: Math.max(90, rows.length * 34 + 20) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--grid)" horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
          <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={130} />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox
                  rows={[
                    ['Project', String(payload[0].payload.name)],
                    ['Value', `${Number(payload[0].value).toFixed(dp)}${unit ? ` ${unit}` : ''}`],
                  ]}
                />
              ) : null
            }
          />
          {average !== null && (
            <ReferenceLine
              x={average}
              stroke="var(--text-muted)"
              strokeDasharray="4 3"
              label={{ value: 'avg', position: 'right', fontSize: 10, fill: 'var(--text-muted)' }}
            />
          )}
          <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={18} isAnimationActive={false}>
            {rows.map((r, i) => (
              <Cell key={i} fill={r.colour} fillOpacity={r.outlier ? 1 : 0.65} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Sparkline({ data, colour }: { data: Array<{ day: string; cycles: number }>; colour: string }) {
  if (data.length < 2) return null;
  return (
    <div style={{ width: '100%', height: 34 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
          <Line dataKey="cycles" stroke={colour} strokeWidth={1.75} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
