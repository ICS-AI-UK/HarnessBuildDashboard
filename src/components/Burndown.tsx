import { BurndownChart } from './charts';
import { Card, EMPTY, Figure, Method, Pill, fmt } from './ui';
import type { Burndown } from '@/lib/metrics/burndown';
import { formatDayLong } from '@/lib/time';

function runwayTone(days: number | null): 'good' | 'warn' | 'bad' | 'default' {
  if (days === null) return 'default';
  if (days < 14) return 'bad';
  if (days < 45) return 'warn';
  return 'good';
}

export function BurndownPanel({
  burndown,
  scope,
  settingsHref,
  colour = 'var(--series-5)',
}: {
  burndown: Burndown | null;
  scope: string;
  settingsHref: string;
  colour?: string;
}) {
  if (!burndown) {
    return (
      <Card id="burndown" title="Credit burndown" subtitle={scope}>
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          No balance has been stated, so there is nothing to burn down from. Set the credits
          remaining and the date they were true on in{' '}
          <a href={settingsHref} className="focusable rounded underline" style={{ color: 'var(--accent)' }}>
            settings
          </a>
          , and the projection appears here.
        </p>
      </Card>
    );
  }

  const b = burndown;
  const pctLeft = b.balance > 0 ? Math.max(0, (b.remainingNow / b.balance) * 100) : 0;

  return (
    <Card
      id="burndown"
      title="Credit burndown"
      subtitle={`${scope} · ${fmt(b.balance, 0)} credits stated as of ${formatDayLong(b.asOf)}`}
      right={
        b.status === 'exhausted' ? (
          <Pill tone="bad">Balance exhausted</Pill>
        ) : b.daysRemaining !== null ? (
          <Pill tone={runwayTone(b.daysRemaining)}>
            {Math.floor(b.daysRemaining)} days left
          </Pill>
        ) : null
      }
    >
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          value={fmt(b.remainingNow, 0)}
          label="Credits remaining"
          size="lg"
          note={`${Math.round(pctLeft)}% of the stated balance`}
          tone={b.remainingNow <= 0 ? 'bad' : 'default'}
        />
        <Figure value={fmt(b.spentSinceAsOf, 0)} label="Spent since then" />
        <Figure
          value={b.ratePerCalendarDay === null ? EMPTY : fmt(b.ratePerCalendarDay, 0)}
          label="Burn per calendar day"
          note={
            b.ratePerActiveDay === null
              ? undefined
              : `${fmt(b.ratePerActiveDay, 0)} on a working day, last ${b.rateWindowDays}`
          }
          tone={b.rateTrend !== null && b.rateTrend > 1.5 ? 'warn' : 'default'}
        />
        <Figure
          value={b.exhaustionDate ? formatDayLong(b.exhaustionDate) : EMPTY}
          label="Projected to run out"
          note={
            b.activeDaysRemaining === null
              ? undefined
              : `about ${Math.floor(b.activeDaysRemaining)} more working days`
          }
          tone={runwayTone(b.daysRemaining) === 'bad' ? 'bad' : 'default'}
        />
      </div>

      <div className="mt-6">
        <BurndownChart series={b.series} colour={colour} />
      </div>

      {b.status === 'no-data' && (
        <p className="mt-4 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          No credit-bearing days have been uploaded on or after {formatDayLong(b.asOf)}, so nothing
          has been drawn down yet and no rate can be estimated.
        </p>
      )}
      {b.status === 'exhausted' && (
        <p className="mt-4 text-[13px]" style={{ color: 'var(--bad)' }}>
          Recorded spend since {formatDayLong(b.asOf)} already exceeds the stated balance by{' '}
          {fmt(Math.abs(b.remainingNow), 0)} credits. Either the balance is out of date or more was
          spent than the figure allowed for.
        </p>
      )}

      {b.rateTrend !== null && Math.abs(b.rateTrend - 1) > 0.25 && (
        <p
          className="mt-4 rounded-md p-2.5 text-[13px]"
          style={{
            background: b.rateTrend > 1 ? 'color-mix(in srgb, var(--warn) 12%, transparent)' : 'var(--surface-2)',
            color: b.rateTrend > 1 ? 'var(--warn)' : 'var(--text-muted)',
          }}
        >
          Spend is {b.rateTrend > 1 ? 'rising' : 'falling'}: the last {b.rateWindowDays} working
          day{b.rateWindowDays === 1 ? '' : 's'} averaged {fmt(b.ratePerActiveDay, 0)} credits
          against {fmt(b.lifetimeRatePerActiveDay, 0)} over the whole period &mdash;{' '}
          {fmt(b.rateTrend, 1)}&times;. The projection uses the recent figure, so it follows the
          trend rather than the average.
          {b.rateTrend > 1 && ' A long-running conversation costs more per message as its context grows, so a rising curve is expected rather than alarming.'}
        </p>
      )}

      <Method>
        The rate is taken from the last {b.rateWindowDays} working day
        {b.rateWindowDays === 1 ? '' : 's'}, not from the whole period, because spend per message
        climbs as a conversation accumulates context and a flat average would project at a rate
        already left behind. Runway is quoted in calendar days, because that is what a date on a
        budget means. It assumes the working cadence actually observed:{' '}
        {b.activeDayDensity === null ? (
          'not yet measurable'
        ) : (
          <>
            {b.activeDaysObserved} credit-bearing day{b.activeDaysObserved === 1 ? '' : 's'} out of{' '}
            {b.calendarDaysObserved} since the balance date, so {Math.round(b.activeDayDensity * 100)}% of
            days are worked
          </>
        )}
        . Work more days than that and the balance runs out sooner. The solid line is recorded
        spend; the dashed line is the projection, which is an extrapolation and not a measurement.
      </Method>
    </Card>
  );
}
