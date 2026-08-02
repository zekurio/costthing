import { strict as assert } from 'node:assert'
import type { CostPoint, Donation } from '../shared/types.ts'
import { buildCoverage, buildTimeline } from './summary.ts'

function cost(overrides: Partial<CostPoint> = {}): CostPoint {
  return {
    id: 1,
    name: 'Server',
    category: 'Hosting',
    costCents: 1200,
    cadence: 'monthly',
    startsOn: '2026-01-01',
    endsOn: null,
    amortizationMonths: null,
    intervalCount: null,
    intervalUnit: null,
    ...overrides,
  }
}

function donation(overrides: Partial<Donation> = {}): Donation {
  return {
    id: 1,
    name: 'Alex',
    amountCents: 500,
    cadence: 'one_time',
    receivedOn: '2026-07-01',
    endsOn: null,
    status: 'confirmed',
    submittedBy: null,
    userId: null,
    ...overrides,
  }
}

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

Deno.test('pending donations do not alter financial history or coverage', () => {
  const now = new Date('2026-07-20T12:00:00Z')
  const costs = [cost({ startsOn: '2026-01-01' })]
  const confirmed = donation({ receivedOn: '2026-06-01' })
  const pending = donation({
    id: 2,
    receivedOn: '2025-01-01',
    status: 'pending',
    submittedBy: 'Sam',
  })

  const withoutPending = buildTimeline(costs, [confirmed], now)
  const withPending = buildTimeline(costs, [pending, confirmed], now)
  assert.deepEqual(withPending, withoutPending)
  assert.deepEqual(
    buildCoverage(withPending, [pending, confirmed], now),
    buildCoverage(withoutPending, [confirmed], now),
  )
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
