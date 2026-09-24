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
  /** Mean spend on a worked day, over the recent window the rate is taken from. */
  ratePerActiveDay: number | null;
  /** Mean spend on a worked day over the whole period, for comparison. */
  lifetimeRatePerActiveDay: number | null;
  /** How many worked days the rate was taken from. */
  rateWindowDays: number;
  /** Ratio of the recent rate to the lifetime one; >1 means spend is climbing. */
  rateTrend: number | null;
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

/** Working days the burn rate is taken from. Recent enough to track a rising
 *  curve, long enough not to swing on one heavy day. */
export const DEFAULT_RATE_WINDOW_DAYS = 7;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function computeBurndown(input: BurndownInput): Burndown {
  const today = input.today ?? todayKey();
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;

  // Refuse unusable input rather than letting it reach the date arithmetic.
  // A caller guarding on `!== null` lets a missing field through as undefined,
  // and this is the function that would then throw deep inside a date split.
  if (!DAY_RE.test(String(input.asOf)) || !Number.isFinite(input.balance)) {
    return {
      balance: Number.isFinite(input.balance) ? input.balance : 0,
      asOf: DAY_RE.test(String(input.asOf)) ? input.asOf : today,
      spentSinceAsOf: 0,
      remainingNow: Number.isFinite(input.balance) ? input.balance : 0,
      activeDaysObserved: 0,
      calendarDaysObserved: 0,
      ratePerActiveDay: null,
      lifetimeRatePerActiveDay: null,
      rateWindowDays: 0,
      rateTrend: null,
      activeDayDensity: null,
      ratePerCalendarDay: null,
      daysRemaining: null,
      activeDaysRemaining: null,
      exhaustionDate: null,
      series: [],
      status: 'no-data',
    };
  }

  // Only days from the stated date onwards reduce the stated balance.
  const since = input.days
    .filter((d) => d.day >= input.asOf && d.day <= today)
    .sort((a, b) => a.day.localeCompare(b.day));

  const withCredits = since.filter((d) => d.credits !== null);
  const spentSinceAsOf = withCredits.reduce((a, d) => a + (d.credits as number), 0);
  const remainingNow = input.balance - spentSinceAsOf;

  const calendarDaysObserved = since.length ? dayRange(input.asOf, today).length : 0;
  const activeDaysObserved = withCredits.length;

  /**
   * The rate comes from the most recent working days, not from all of them.
   *
   * Spend per message climbs steeply as a conversation accumulates context — on
   * real data, 33x between the first and last day of one build. Averaging a
   * rising curve projects at a rate the team has already left behind, and
   * overstates the runway exactly when the balance matters most.
   */
  const windowSize = input.rateWindowActiveDays ?? DEFAULT_RATE_WINDOW_DAYS;
  const rateDays = windowSize > 0 ? withCredits.slice(-windowSize) : withCredits;
  const rateSpend = rateDays.reduce((a, d) => a + (d.credits as number), 0);

  const ratePerActiveDay = rateDays.length > 0 ? rateSpend / rateDays.length : null;

  // Density over the same window, so the two halves of the calendar rate agree
  // about which period they describe.
  const rateWindowCalendarDays = rateDays.length
    ? dayRange(rateDays[0].day, today).length
    : calendarDaysObserved;
  const activeDayDensity =
    rateWindowCalendarDays > 0 ? rateDays.length / rateWindowCalendarDays : null;

  // The flat average over everything, kept so the panel can show when the
  // recent rate has diverged from the period as a whole.
  const lifetimeRatePerActiveDay =
    activeDaysObserved > 0 ? spentSinceAsOf / activeDaysObserved : null;
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
    lifetimeRatePerActiveDay,
    rateWindowDays: rateDays.length,
    rateTrend:
      ratePerActiveDay !== null && lifetimeRatePerActiveDay !== null && lifetimeRatePerActiveDay > 0
        ? ratePerActiveDay / lifetimeRatePerActiveDay
        : null,
    activeDayDensity,
    ratePerCalendarDay,
    daysRemaining,
    activeDaysRemaining,
    exhaustionDate,
    series,
    status,
  };
}
