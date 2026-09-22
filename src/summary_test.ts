import { strict as assert } from 'node:assert'
import type { CostPoint, IncomeEntry } from '../shared/types.ts'
import { buildCoverage, buildIncomeTotals, buildTimeline } from './summary.ts'

function cost(overrides: Partial<CostPoint> = {}): CostPoint {
  return {
    id: 1,
    name: 'Server',
    category: 'Hosting',
    costCents: 1200,
    priceChanges: [],
    cadence: 'monthly',
    startsOn: '2026-01-01',
    endsOn: null,
    amortizationMonths: null,
    intervalCount: null,
    intervalUnit: null,
    ...overrides,
  }
}

function income(overrides: Partial<IncomeEntry> = {}): IncomeEntry {
  return {
    id: 1,
    month: '2026-06',
    amountCents: 500,
    note: null,
    ...overrides,
  }
}

Deno.test('income totals include every booked month and preserve whole cents', () => {
  assert.deepEqual(buildIncomeTotals([]), {})
  assert.deepEqual(
    buildIncomeTotals([
      income({ id: 1, month: '2026-06', amountCents: 501 }),
      income({ id: 2, month: '2026-06', amountCents: 250 }),
      income({ id: 3, month: '2040-12', amountCents: 999 }),
    ]),
    { '2026-06': 751, '2040-12': 999 },
  )
})

Deno.test('timeline follows price changes', () => {
  const timeline = buildTimeline(
    [
      cost({
        startsOn: '2026-01-01',
        priceChanges: [{ startsOn: '2026-04-01', costCents: 2400 }],
      }),
    ],
    [],
    new Date('2026-07-20T12:00:00Z'),
  )

  assert.equal(timeline.find((entry) => entry.month === '2026-03')?.totalCents, 1200)
  assert.equal(timeline.find((entry) => entry.month === '2026-04')?.totalCents, 2400)
  assert.equal(timeline.at(-1)?.totalCents, 2400)
})

Deno.test('timeline includes current month before future-only entries', () => {
  const timeline = buildTimeline(
    [cost({ startsOn: '2026-10-15' })],
    [],
    new Date('2026-07-20T12:00:00Z'),
  )

  assert.equal(timeline[0]?.month, '2026-07')
  assert.equal(timeline[0]?.totalCents, 0)
  assert.equal(timeline.find((entry) => entry.month === '2026-10')?.totalCents, 1200)
})

Deno.test('timeline carries booked income per month', () => {
  const timeline = buildTimeline(
    [cost({ startsOn: '2026-01-01' })],
    [income(), income({ id: 2, month: '2026-07', amountCents: 250 })],
    new Date('2026-07-20T12:00:00Z'),
  )

  assert.equal(timeline.find((entry) => entry.month === '2026-05')?.incomeCents, 0)
  assert.equal(timeline.find((entry) => entry.month === '2026-06')?.incomeCents, 500)
  assert.equal(timeline.find((entry) => entry.month === '2026-07')?.incomeCents, 250)
})

Deno.test('coverage totals run since the first income month through the current month', () => {
  const now = new Date('2026-07-20T12:00:00Z')
  const costs = [cost({ startsOn: '2026-01-01' })]
  const entries = [
    income(),
    income({ id: 2, month: '2026-07', amountCents: 250 }),
    // booked ahead — money not received "until now"
    income({ id: 3, month: '2026-08', amountCents: 9_999 }),
  ]
  const coverage = buildCoverage(buildTimeline(costs, entries, now), entries, now)

  assert.equal(coverage.month, '2026-07')
  assert.equal(coverage.costCents, 1200)
  assert.equal(coverage.incomeCents, 250)
  assert.equal(coverage.balanceCents, -950)
  // cost-only months 2026-01..2026-05 stay out of the pot
  assert.equal(coverage.totalIncomeCents, 750)
  assert.equal(coverage.totalCostCents, 2400)
  assert.equal(coverage.totalBalanceCents, -1650)
})

Deno.test('coverage without income stays at zero', () => {
  const now = new Date('2026-07-20T12:00:00Z')
  const coverage = buildCoverage(buildTimeline([cost()], [], now), [], now)
  assert.equal(coverage.totalIncomeCents, 0)
  assert.equal(coverage.totalCostCents, 0)
  assert.equal(coverage.totalBalanceCents, 0)
})

Deno.test('calendar amortization occupies exactly its configured month buckets', () => {
  const timeline = buildTimeline(
    [
      cost({
        costCents: 1200,
        cadence: 'one_time',
        startsOn: '2026-01-31',
        amortizationMonths: 12,
      }),
    ],
    [],
    new Date('2026-07-20T12:00:00Z'),
  )
  const charged = timeline.filter((entry) => entry.totalCents > 0)

  assert.equal(charged.length, 12)
  assert.equal(charged[0]?.month, '2026-01')
  assert.equal(charged.at(-1)?.month, '2026-12')
  assert.equal(charged.reduce((sum, entry) => sum + entry.totalCents, 0), 1200)
})
