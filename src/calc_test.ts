import { strict as assert } from 'node:assert'
import type { CostPoint, Donation, IntervalUnit } from '../shared/types.ts'
import {
  amortizationElapsed,
  annualizedCents,
  donationCentsForMonth,
  monthlyCents,
} from './calc.ts'

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

function monthBoundary(startOn: string, offset: number, last: boolean): Date {
  const year = Number(startOn.slice(0, 4))
  const monthIndex = Number(startOn.slice(5, 7)) - 1
  return last
    ? new Date(Date.UTC(year, monthIndex + offset + 1, 0))
    : new Date(Date.UTC(year, monthIndex + offset, 1))
}

function cost(overrides: Partial<CostPoint> = {}): CostPoint {
  return {
    id: 1,
    name: 'Test',
    category: 'Infra',
    costCents: 12_000,
    priceChanges: [],
    cadence: 'monthly',
    startsOn: '2026-07-24',
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
    name: 'Test',
    amountCents: 750,
    cadence: 'one_time',
    receivedOn: '2026-07-24',
    endsOn: null,
    status: 'confirmed',
    submittedBy: null,
    userId: null,
    ...overrides,
  }
}

Deno.test('price changes apply from their calendar month until the next change', () => {
  const point = cost({
    startsOn: '2026-01-15',
    priceChanges: [
      { startsOn: '2026-06-20', costCents: 9_000 },
      { startsOn: '2027-01-01', costCents: 15_000 },
    ],
  })

  assert.equal(monthlyCents(point, utcDate('2026-01-15')), 12_000)
  assert.equal(monthlyCents(point, utcDate('2026-05-31')), 12_000)
  // a mid-month change counts for its whole calendar month
  assert.equal(monthlyCents(point, utcDate('2026-06-01')), 9_000)
  assert.equal(monthlyCents(point, utcDate('2026-06-19')), 9_000)
  assert.equal(monthlyCents(point, utcDate('2026-06-20')), 9_000)
  assert.equal(monthlyCents(point, utcDate('2026-12-31')), 9_000)
  assert.equal(monthlyCents(point, utcDate('2027-01-01')), 15_000)
  assert.equal(annualizedCents(point, utcDate('2026-06-15')), 108_000)
})

Deno.test('yearly and custom costs follow price changes mid-cycle', () => {
  const yearly = cost({
    cadence: 'yearly',
    startsOn: '2026-01-01',
    priceChanges: [{ startsOn: '2026-07-01', costCents: 24_000 }],
  })
  assert.equal(monthlyCents(yearly, utcDate('2026-06-01')), 1_000)
  assert.equal(monthlyCents(yearly, utcDate('2026-07-01')), 2_000)
  assert.equal(annualizedCents(yearly, utcDate('2026-08-01')), 24_000)

  const custom = cost({
    cadence: 'custom',
    intervalCount: 3,
    intervalUnit: 'months',
    startsOn: '2026-01-01',
    priceChanges: [{ startsOn: '2026-07-01', costCents: 6_000 }],
  })
  assert.equal(monthlyCents(custom, utcDate('2026-06-01')), 4_000)
  assert.equal(monthlyCents(custom, utcDate('2026-07-01')), 2_000)
})

Deno.test('price changes after the end month never count', () => {
  const point = cost({
    startsOn: '2026-01-01',
    endsOn: '2026-06-30',
    priceChanges: [{ startsOn: '2026-09-01', costCents: 5_000 }],
  })
  assert.equal(monthlyCents(point, utcDate('2026-06-30')), 12_000)
  assert.equal(monthlyCents(point, utcDate('2026-09-01')), 0)
})

Deno.test('recurring costs use whole start and end calendar months', () => {
  const cases: Array<{ point: CostPoint; expected: number }> = [
    {
      point: cost({ cadence: 'monthly', endsOn: '2026-09-02' }),
      expected: 12_000,
    },
    {
      point: cost({ cadence: 'yearly', endsOn: '2026-09-02' }),
      expected: 1_000,
    },
    {
      point: cost({
        cadence: 'custom',
        endsOn: '2026-09-02',
        intervalCount: 3,
        intervalUnit: 'months',
      }),
      expected: 4_000,
    },
  ]
  const samples: Array<[string, boolean]> = [
    ['2026-06-30', false],
    ['2026-07-01', true],
    ['2026-07-31', true],
    ['2026-09-01', true],
    ['2026-09-30', true],
    ['2026-10-01', false],
  ]

  for (const { point, expected } of cases) {
    for (const [date, active] of samples) {
      assert.equal(
        monthlyCents(point, utcDate(date)),
        active ? expected : 0,
        `${point.cadence} on ${date}`,
      )
    }
  }
})

Deno.test('yearly costs distribute cents while preserving their annual face value', () => {
  const point = cost({ cadence: 'yearly', costCents: 4_999 })
  const months = Array.from(
    { length: 12 },
    (_, offset) => monthlyCents(point, monthBoundary(point.startsOn, offset, false)),
  )

  assert.ok(months.every(Number.isInteger))
  assert.equal(months.reduce((sum, value) => sum + value, 0), 4_999)
  assert.equal(annualizedCents(point, utcDate('2026-07-01')), 4_999)
})

Deno.test('custom costs convert every supported interval to months', () => {
  const cases: Array<{ unit: IntervalUnit; count: number; intervalMonths: number }> = [
    { unit: 'days', count: 30, intervalMonths: (30 * 12) / 365.25 },
    { unit: 'weeks', count: 2, intervalMonths: (2 * 7 * 12) / 365.25 },
    { unit: 'months', count: 3, intervalMonths: 3 },
    { unit: 'years', count: 2, intervalMonths: 24 },
  ]

  for (const { unit, count, intervalMonths } of cases) {
    const point = cost({ cadence: 'custom', intervalCount: count, intervalUnit: unit })
    assert.equal(
      monthlyCents(point, utcDate('2026-07-01')),
      Math.round(12_000 / intervalMonths),
      unit,
    )
  }

  assert.equal(
    monthlyCents(
      cost({ cadence: 'custom', intervalCount: 0, intervalUnit: 'months' }),
      utcDate('2026-07-01'),
    ),
    0,
  )
  assert.equal(
    monthlyCents(
      cost({ cadence: 'custom', intervalCount: 3, intervalUnit: null }),
      utcDate('2026-07-01'),
    ),
    0,
  )
})

Deno.test('unamortized one-time costs count only in their start calendar month', () => {
  const point = cost({ cadence: 'one_time', costCents: 4_321 })
  assert.equal(monthlyCents(point, utcDate('2026-06-30')), 0)
  assert.equal(monthlyCents(point, utcDate('2026-07-01')), 4_321)
  assert.equal(monthlyCents(point, utcDate('2026-07-24')), 4_321)
  assert.equal(monthlyCents(point, utcDate('2026-07-31')), 4_321)
  assert.equal(monthlyCents(point, utcDate('2026-08-01')), 0)
})

Deno.test('mid-month amortization has no thirteenth timeline bucket', () => {
  const point = cost({
    cadence: 'one_time',
    startsOn: '2026-07-24',
    amortizationMonths: 12,
  })
  assert.equal(monthlyCents(point, utcDate('2026-06-30')), 0)
  assert.equal(monthlyCents(point, utcDate('2026-07-01')), 1_000)
  assert.equal(monthlyCents(point, utcDate('2026-07-31')), 1_000)
  assert.equal(monthlyCents(point, utcDate('2027-06-01')), 1_000)
  assert.equal(monthlyCents(point, utcDate('2027-06-30')), 1_000)
  assert.equal(monthlyCents(point, utcDate('2027-07-01')), 0)
  assert.equal(monthlyCents(point, utcDate('2027-07-23')), 0)
  assert.equal(monthlyCents(point, utcDate('2027-07-31')), 0)
})

Deno.test('January 31 and leap-day amortization use calendar months without overflow', () => {
  const oneMonth = cost({
    cadence: 'one_time',
    costCents: 900,
    startsOn: '2024-01-31',
    amortizationMonths: 1,
  })
  assert.equal(monthlyCents(oneMonth, utcDate('2024-01-01')), 900)
  assert.equal(monthlyCents(oneMonth, utcDate('2024-01-31')), 900)
  assert.equal(monthlyCents(oneMonth, utcDate('2024-02-01')), 0)
  assert.equal(monthlyCents(oneMonth, utcDate('2024-02-29')), 0)

  const leapDay = cost({
    cadence: 'one_time',
    costCents: 13_000,
    startsOn: '2024-02-29',
    amortizationMonths: 13,
  })
  assert.equal(monthlyCents(leapDay, utcDate('2024-02-01')), 1_000)
  assert.equal(monthlyCents(leapDay, utcDate('2025-02-28')), 1_000)
  assert.equal(monthlyCents(leapDay, utcDate('2025-03-01')), 0)
})

Deno.test('amortization distributes remainder cents without losing money', () => {
  const point = cost({
    cadence: 'one_time',
    costCents: 100,
    startsOn: '2026-01-31',
    amortizationMonths: 3,
  })
  const values = ['2026-01-01', '2026-02-01', '2026-03-01'].map((date) =>
    monthlyCents(point, utcDate(date))
  )
  assert.deepEqual(values, [34, 33, 33])
  assert.equal(values.reduce((sum, value) => sum + value, 0), 100)
})

Deno.test('amortization always occupies exactly N calendar-month buckets', () => {
  const startDates = [
    '2023-01-31',
    '2024-01-31',
    '2024-02-29',
    '2026-07-24',
    '2026-12-31',
  ]
  const durations = [1, 2, 7, 12, 13, 25]

  for (const startsOn of startDates) {
    for (const duration of durations) {
      const point = cost({
        cadence: 'one_time',
        costCents: 123_457,
        startsOn,
        amortizationMonths: duration,
      })
      let activeBuckets = 0
      let totalCents = 0

      for (let offset = -2; offset <= duration + 2; offset += 1) {
        const base = Math.floor(point.costCents / duration)
        const expected = offset >= 0 && offset < duration
          ? base + (offset < point.costCents % duration ? 1 : 0)
          : 0
        const first = monthlyCents(point, monthBoundary(startsOn, offset, false))
        const last = monthlyCents(point, monthBoundary(startsOn, offset, true))
        const context = `${startsOn}, ${duration} months, offset ${offset}`
        assert.equal(first, expected, `first day: ${context}`)
        assert.equal(last, expected, `last day: ${context}`)
        if (first > 0) {
          activeBuckets += 1
          totalCents += first
        }
      }

      assert.equal(activeBuckets, duration, `${startsOn}, ${duration} months`)
      assert.equal(totalCents, point.costCents)
    }
  }
})

Deno.test('amortization elapsed counts the current calendar bucket', () => {
  const point = cost({
    cadence: 'one_time',
    startsOn: '2024-01-31',
    amortizationMonths: 3,
  })
  const samples: Array<[string, number]> = [
    ['2023-12-31', 0],
    ['2024-01-01', 1],
    ['2024-01-30', 1],
    ['2024-01-31', 1],
    ['2024-02-01', 2],
    ['2024-02-29', 2],
    ['2024-03-01', 3],
    ['2024-03-31', 3],
    ['2024-04-01', 3],
  ]

  for (const [date, expected] of samples) {
    assert.equal(amortizationElapsed(point, utcDate(date)), expected, date)
  }
  assert.equal(amortizationElapsed(cost({ cadence: 'one_time' }), utcDate('2026-07-24')), null)
  assert.equal(
    amortizationElapsed(
      cost({ cadence: 'monthly', amortizationMonths: 3 }),
      utcDate('2026-07-24'),
    ),
    null,
  )
})

Deno.test('leap-day recurring costs include their complete start and end month', () => {
  const point = cost({
    startsOn: '2024-02-29',
    endsOn: '2024-02-29',
  })
  assert.equal(monthlyCents(point, utcDate('2024-01-31')), 0)
  assert.equal(monthlyCents(point, utcDate('2024-02-01')), 12_000)
  assert.equal(monthlyCents(point, utcDate('2024-02-29')), 12_000)
  assert.equal(monthlyCents(point, utcDate('2024-03-01')), 0)
})

Deno.test('one-off donations only count in their receipt month', () => {
  const value = donation()
  assert.equal(donationCentsForMonth(value, '2026-06'), 0)
  assert.equal(donationCentsForMonth(value, '2026-07'), 750)
  assert.equal(donationCentsForMonth(value, '2026-08'), 0)
})

Deno.test('monthly donations repeat through their end month', () => {
  const value = donation({ cadence: 'monthly', endsOn: '2026-09-02' })
  assert.equal(donationCentsForMonth(value, '2026-06'), 0)
  assert.equal(donationCentsForMonth(value, '2026-07'), 750)
  assert.equal(donationCentsForMonth(value, '2026-09'), 750)
  assert.equal(donationCentsForMonth(value, '2026-10'), 0)
})

Deno.test('yearly leap-day donations recur in February through their end month', () => {
  const value = donation({
    cadence: 'yearly',
    receivedOn: '2024-02-29',
    endsOn: '2026-02-01',
  })
  assert.equal(donationCentsForMonth(value, '2024-01'), 0)
  assert.equal(donationCentsForMonth(value, '2024-02'), 750)
  assert.equal(donationCentsForMonth(value, '2024-03'), 0)
  assert.equal(donationCentsForMonth(value, '2025-02'), 750)
  assert.equal(donationCentsForMonth(value, '2026-02'), 750)
  assert.equal(donationCentsForMonth(value, '2027-02'), 0)
})

Deno.test('pending donations never count for any cadence', () => {
  const cases: Array<{ value: Donation; month: string }> = [
    { value: donation({ status: 'pending', submittedBy: 'alex' }), month: '2026-07' },
    {
      value: donation({ cadence: 'monthly', status: 'pending', submittedBy: 'alex' }),
      month: '2026-08',
    },
    {
      value: donation({ cadence: 'yearly', status: 'pending', submittedBy: 'alex' }),
      month: '2027-07',
    },
  ]

  for (const { value, month } of cases) {
    assert.equal(donationCentsForMonth(value, month), 0)
    assert.equal(donationCentsForMonth({ ...value, status: 'confirmed' }, month), 750)
  }
})
