import type { CostPoint, Coverage, IncomeEntry, TimelineEntry } from '../shared/types.ts'
import { incomeCentsForMonth, monthlyCents } from './calc.ts'

function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Cost and booked-income history through twelve months after the current month. */
export function buildTimeline(
  points: CostPoint[],
  income: IncomeEntry[],
  now: Date,
): TimelineEntry[] {
  if (points.length === 0 && income.length === 0) return []

  // Always include the current month, even when every configured entry starts in the future.
  const currentMonth = monthOf(now)
  const earliest = [
    currentMonth,
    ...points.map((point) => point.startsOn.slice(0, 7)),
    ...income.map((entry) => entry.month),
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
      incomeCents: incomeCentsForMonth(income, month),
      categories,
    })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return entries
}

/**
 * The pot: booked income versus accumulated cost through the current month.
 * Cost-only history before the first income month is left out so it does not
 * drown the balance in deficit — the totals answer "since people started paying".
 */
export function buildCoverage(
  timeline: TimelineEntry[],
  income: IncomeEntry[],
  now: Date,
): Coverage {
  const month = monthOf(now)
  const current = timeline.find((entry) => entry.month === month)
  const costCents = current?.totalCents ?? 0
  const incomeCents = current?.incomeCents ?? 0

  let totalIncomeCents = 0
  let totalCostCents = 0
  if (income.length > 0) {
    const firstMonth = income.map((entry) => entry.month).sort()[0]!
    for (const entry of timeline) {
      if (entry.month < firstMonth || entry.month > month) continue
      totalIncomeCents += entry.incomeCents
      totalCostCents += entry.totalCents
    }
  }

  return {
    month,
    costCents,
    incomeCents,
    balanceCents: incomeCents - costCents,
    totalIncomeCents,
    totalCostCents,
    totalBalanceCents: totalIncomeCents - totalCostCents,
  }
}
