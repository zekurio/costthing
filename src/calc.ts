import type { CostPoint, Donation } from '../shared/types.ts'

function utcMonth(date: Date): string {
  return date.toISOString().slice(0, 7)
}

function monthOffset(startMonth: string, month: string): number {
  const startYear = Number(startMonth.slice(0, 4))
  const startMonthIndex = Number(startMonth.slice(5, 7)) - 1
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7)) - 1
  return (year - startYear) * 12 + monthIndex - startMonthIndex
}

function intervalMonths(p: CostPoint): number {
  const count = p.intervalCount ?? 0
  if (count <= 0) return 0
  switch (p.intervalUnit) {
    case 'days':
      return (count * 12) / 365.25
    case 'weeks':
      return (count * 7 * 12) / 365.25
    case 'months':
      return count
    case 'years':
      return count * 12
    default:
      return 0
  }
}

function amortizationDuration(p: CostPoint): number | null {
  if (p.cadence !== 'one_time' || !p.amortizationMonths || p.amortizationMonths <= 0) return null
  return p.amortizationMonths
}

/**
 * Effective cost for the calendar month containing `now`, in cents.
 *
 * The day within the month is intentionally ignored so timeline sampling on
 * the first and last day produces the same value. Not rounded; round at display time.
 */
export function monthlyCents(p: CostPoint, now: Date = new Date()): number {
  const month = utcMonth(now)
  const startMonth = p.startsOn.slice(0, 7)
  const endMonth = p.endsOn?.slice(0, 7) ?? null
  if (month < startMonth || (endMonth && month > endMonth)) return 0

  switch (p.cadence) {
    case 'monthly':
      return p.costCents
    case 'yearly':
      return p.costCents / 12
    case 'custom': {
      const months = intervalMonths(p)
      return months > 0 ? p.costCents / months : 0
    }
    case 'one_time': {
      const duration = amortizationDuration(p)
      if (duration === null) return month === startMonth ? p.costCents : 0
      return monthOffset(startMonth, month) < duration ? p.costCents / duration : 0
    }
  }
}

/**
 * Number of amortization calendar-month buckets reached, including the current bucket.
 * This is 1 throughout the start month, clamps to the duration after the final month,
 * and is 0 before the start month. Returns null when the point is not amortized.
 */
export function amortizationElapsed(p: CostPoint, now: Date = new Date()): number | null {
  const duration = amortizationDuration(p)
  if (duration === null) return null
  const month = utcMonth(now)
  const startMonth = p.startsOn.slice(0, 7)
  if (month < startMonth) return 0
  return Math.min(monthOffset(startMonth, month) + 1, duration)
}

/** Donation amount occurring in a calendar month (YYYY-MM). */
export function donationCentsForMonth(donation: Donation, month: string): number {
  if (donation.status === 'pending') return 0
  const startMonth = donation.receivedOn.slice(0, 7)
  const endMonth = donation.endsOn?.slice(0, 7) ?? null
  if (month < startMonth || (endMonth && month > endMonth)) return 0

  if (donation.cadence === 'one_time') {
    return month === startMonth ? donation.amountCents : 0
  }
  if (donation.cadence === 'monthly') return donation.amountCents

  return month.slice(5, 7) === startMonth.slice(5, 7) ? donation.amountCents : 0
}
