/**
 * Credit burndown (SPEC.md §5.12).
 *
 * Takes a stated balance as of a date, subtracts what was actually spent since,
 * and projects forward at the observed rate.
 *
 * The projection deliberately separates two rates, because conflating them is
 * the easy way to be wrong by a factor of two:
 *
 *   per active day    — what a working day costs
 *   per calendar day  — that rate scaled by how often days are worked
 *
 * A team spending 7,500 credits on each of nine days in a fortnight is burning
 * ~4,800 a calendar day, not 7,500. Runway is quoted in calendar days, since
 * that is what a date on a budget means, and the working cadence it assumes is
 * stated alongside.
 */

import { dayRange, nextDay, todayKey } from '../time';
import type { DayMetrics } from './compute';

export type BurndownPoint = {
  day: string;
  remaining: number;
  kind: 'actual' | 'projected';
};

export type Burndown = {
  balance: number;
  asOf: string;
  /** Credits recorded on or after `asOf`. */
  spentSinceAsOf: number;
  remainingNow: number;
  /** Days between `asOf` and today that carry credit data. */
  activeDaysObserved: number;
  calendarDaysObserved: number;
  /** Mean spend on a day that was actually worked. */
  ratePerActiveDay: number | null;
  /** Share of calendar days that were worked, over the whole observed period. */
  activeDayDensity: number | null;
  /** ratePerActiveDay x activeDayDensity — what a calendar day costs on average. */
  ratePerCalendarDay: number | null;
  /** Calendar days of runway left, null when the rate is unknown. */
  daysRemaining: number | null;
  /** Working days of runway left. */
  activeDaysRemaining: number | null;
  exhaustionDate: string | null;
  series: BurndownPoint[];
  status: 'ok' | 'exhausted' | 'no-rate' | 'no-data';
};

export type BurndownInput = {
  balance: number;
  asOf: string;
  /** Per-day metrics covering at least asOf..today. */
  days: DayMetrics[];
  /** Overrides "now" for testing. */
  today?: string;
  /** How many calendar days ahead to project at most. */
  horizonDays?: number;
  /** Only use the last N active days for the rate; 0 uses all of them. */
  rateWindowActiveDays?: number;
};

export const DEFAULT_HORIZON_DAYS = 180;

export function computeBurndown(input: BurndownInput): Burndown {
  const today = input.today ?? todayKey();
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;

  // Only days from the stated date onwards reduce the stated balance.
  const since = input.days
    .filter((d) => d.day >= input.asOf && d.day <= today)
    .sort((a, b) => a.day.localeCompare(b.day));

  const withCredits = since.filter((d) => d.credits !== null);
  const spentSinceAsOf = withCredits.reduce((a, d) => a + (d.credits as number), 0);
  const remainingNow = input.balance - spentSinceAsOf;

  const calendarDaysObserved = since.length ? dayRange(input.asOf, today).length : 0;
  const activeDaysObserved = withCredits.length;

  const ratePerActiveDay = activeDaysObserved > 0 ? spentSinceAsOf / activeDaysObserved : null;
  const activeDayDensity =
    calendarDaysObserved > 0 ? activeDaysObserved / calendarDaysObserved : null;
  const ratePerCalendarDay =
    ratePerActiveDay !== null && activeDayDensity !== null && activeDayDensity > 0
      ? ratePerActiveDay * activeDayDensity
      : null;

  // Actual burndown: the balance stepping down by each day's recorded spend.
  const series: BurndownPoint[] = [];
  let running = input.balance;
  if (since.length > 0) {
    series.push({ day: input.asOf, remaining: input.balance, kind: 'actual' });
    for (const d of since) {
      if (d.credits === null) continue;
      running -= d.credits;
      series.push({ day: d.day, remaining: running, kind: 'actual' });
    }
  }

  let status: Burndown['status'] = 'ok';
  if (activeDaysObserved === 0) status = 'no-data';
  else if (remainingNow <= 0) status = 'exhausted';
  else if (ratePerCalendarDay === null || ratePerCalendarDay <= 0) status = 'no-rate';

  let daysRemaining: number | null = null;
  let activeDaysRemaining: number | null = null;
  let exhaustionDate: string | null = null;

  if (status === 'ok' && ratePerCalendarDay !== null && ratePerActiveDay !== null) {
    daysRemaining = remainingNow / ratePerCalendarDay;
    activeDaysRemaining = remainingNow / ratePerActiveDay;

    // Project forward one calendar day at a time so the line lands on a real
    // date rather than a fractional one.
    let day = series.length ? series[series.length - 1].day : input.asOf;
    let left = remainingNow;
    for (let i = 0; i < Math.min(horizon, Math.ceil(daysRemaining) + 1); i++) {
      day = nextDay(day);
      left -= ratePerCalendarDay;
      if (left <= 0) {
        series.push({ day, remaining: 0, kind: 'projected' });
        exhaustionDate = day;
        break;
      }
      series.push({ day, remaining: left, kind: 'projected' });
    }
  }

  return {
    balance: input.balance,
    asOf: input.asOf,
    spentSinceAsOf,
    remainingNow,
    activeDaysObserved,
    calendarDaysObserved,
    ratePerActiveDay,
    activeDayDensity,
    ratePerCalendarDay,
    daysRemaining,
    activeDaysRemaining,
    exhaustionDate,
    series,
    status,
  };
}
