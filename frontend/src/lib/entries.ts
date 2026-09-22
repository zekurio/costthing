import type {
  CostSaveInput,
  IncomeEntry,
  IncomeInput,
  SummaryPoint,
} from '../../../shared/types.ts'

/** Explicit response → request adapters keep computed/server-owned fields off the wire. */
export function costInput(point: SummaryPoint): CostSaveInput {
  return {
    name: point.name,
    category: point.category,
    costCents: point.costCents,
    priceChanges: point.priceChanges.map((change) => ({ ...change })),
    cadence: point.cadence,
    startsOn: point.startsOn,
    endsOn: point.endsOn,
    amortizationMonths: point.amortizationMonths,
    intervalCount: point.intervalCount,
    intervalUnit: point.intervalUnit,
  }
}

export function incomeInput(income: IncomeEntry): IncomeInput {
  return {
    month: income.month,
    amountCents: income.amountCents,
    note: income.note,
  }
}
