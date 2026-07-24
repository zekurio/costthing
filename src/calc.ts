import type { CostPoint, Donation } from '../shared/types.ts'

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  d.setUTCMonth(d.getUTCMonth() + months)
  return d
}

function sameUtcMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
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

function amortizationWindow(p: CostPoint): { start: Date; end: Date } | null {
  if (p.cadence !== 'one_time' || !p.amortizationMonths || p.amortizationMonths <= 0) return null
  const start = parseDate(p.startsOn)
  return { start, end: addMonths(start, p.amortizationMonths) }
}

/** A point counts through the month containing endsOn, then stops. */
function afterEnd(p: CostPoint, now: Date): boolean {
  if (!p.endsOn) return false
  const end = parseDate(p.endsOn)
  return (
    now.getUTCFullYear() > end.getUTCFullYear() ||
    (now.getUTCFullYear() === end.getUTCFullYear() && now.getUTCMonth() > end.getUTCMonth())
  )
}

/** Effective cost per month, in cents, as of `now`. Not rounded; round at display time. */
export function monthlyCents(p: CostPoint, now: Date = new Date()): number {
  if (afterEnd(p, now)) return 0
  switch (p.cadence) {
    case 'monthly':
    case 'yearly':
    case 'custom': {
      // recurring costs only count from the month they start
      const start = parseDate(p.startsOn)
      if (
        now.getUTCFullYear() < start.getUTCFullYear() ||
        (now.getUTCFullYear() === start.getUTCFullYear() &&
          now.getUTCMonth() < start.getUTCMonth())
      ) {
        return 0
      }
      if (p.cadence === 'monthly') return p.costCents
      if (p.cadence === 'yearly') return p.costCents / 12
      const months = intervalMonths(p)
      return months > 0 ? p.costCents / months : 0
    }
    case 'one_time': {
      const window = amortizationWindow(p)
      if (window) {
        return now >= window.start && now < window.end
          ? p.costCents / (p.amortizationMonths ?? 1)
          : 0
      }
      // un-amortized one-time cost: hits the month it started, nothing after
      return sameUtcMonth(now, parseDate(p.startsOn)) ? p.costCents : 0
    }
  }
}

/** Months of the amortization window that have already passed, or null if not amortized. */
export function amortizationElapsed(p: CostPoint, now: Date = new Date()): number | null {
  const window = amortizationWindow(p)
  if (!window) return null
  if (now < window.start) return 0
  const total = p.amortizationMonths ?? 0
  if (now >= window.end) return total
  let elapsed = (now.getUTCFullYear() - window.start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - window.start.getUTCMonth())
  if (now.getUTCDate() >= window.start.getUTCDate()) elapsed += 1
  return Math.min(Math.max(elapsed, 0), total)
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
