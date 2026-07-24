import { strict as assert } from 'node:assert'
import type { Donation } from '../shared/types.ts'
import { donationCentsForMonth } from './calc.ts'

function donation(overrides: Partial<Donation>): Donation {
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

Deno.test('one-off donations only count in their receipt month', () => {
  const value = donation({})
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

Deno.test('yearly donations repeat in the starting calendar month', () => {
  const value = donation({ cadence: 'yearly' })
  assert.equal(donationCentsForMonth(value, '2027-06'), 0)
  assert.equal(donationCentsForMonth(value, '2027-07'), 750)
  assert.equal(donationCentsForMonth(value, '2028-07'), 750)
})

Deno.test('pending donations never count until confirmed', () => {
  const value = donation({ status: 'pending', submittedBy: 'alex' })
  assert.equal(donationCentsForMonth(value, '2026-07'), 0)
  assert.equal(donationCentsForMonth({ ...value, status: 'confirmed' }, '2026-07'), 750)
})
