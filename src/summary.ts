import type { CostPoint, Coverage, Donation, TimelineEntry } from '../shared/types.ts'
import { donationCentsForMonth, monthlyCents } from './calc.ts'

function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function donatedInMonth(donations: Donation[], month: string): number {
  return donations.reduce((sum, donation) => sum + donationCentsForMonth(donation, month), 0)
}

/** Cost and confirmed-donation history through twelve months after the current month. */
export function buildTimeline(
  points: CostPoint[],
  donations: Donation[],
  now: Date,
): TimelineEntry[] {
  const confirmed = donations.filter((donation) => donation.status === 'confirmed')
  if (points.length === 0 && confirmed.length === 0) return []

  // Always include the current month, even when every configured entry starts in the future.
  const currentMonth = monthOf(now)
  const earliest = [
    currentMonth,
    ...points.map((point) => point.startsOn.slice(0, 7)),
    ...confirmed.map((donation) => donation.receivedOn.slice(0, 7)),
  ].sort()[0]!
  const [startYear, startMonth] = earliest.split('-').map(Number)
  const cursor = new Date(Date.UTC(startYear ?? 1970, (startMonth ?? 1) - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 12, 1))

  const entries: TimelineEntry[] = []
  while (cursor <= end) {
    const year = cursor.getUTCFullYear()
    const monthIndex = cursor.getUTCMonth()
    const sample = new Date(Date.UTC(year, monthIndex, 1))
    const categories: Record<string, number> = {}
    let totalCents = 0
    for (const point of points) {
      const value = monthlyCents(point, sample)
      if (value <= 0) continue
      categories[point.category] = (categories[point.category] ?? 0) + value
      totalCents += value
    }
    const month = monthOf(cursor)
    entries.push({
      month,
      totalCents,
      donatedCents: donatedInMonth(confirmed, month),
      categories,
    })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return entries
}

/** Donations versus cost for the current month and since the first confirmed donation. */
export function buildCoverage(
  timeline: TimelineEntry[],
  donations: Donation[],
  now: Date,
): Coverage {
  const month = monthOf(now)
  const current = timeline.find((entry) => entry.month === month)
  const costCents = current?.totalCents ?? 0
  const donatedCents = current?.donatedCents ?? 0
  const confirmed = donations.filter((donation) => donation.status === 'confirmed')

  let cumulativeBalanceCents = 0
  if (confirmed.length > 0) {
    const firstMonth = confirmed.map((donation) => donation.receivedOn.slice(0, 7)).sort()[0]!
    for (const entry of timeline) {
      if (entry.month < firstMonth || entry.month > month) continue
      cumulativeBalanceCents += entry.donatedCents - entry.totalCents
    }
  }

  return {
    month,
    costCents,
    donatedCents,
    balanceCents: donatedCents - costCents,
    cumulativeBalanceCents,
  }
}
