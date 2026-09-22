import { Type } from '@sinclair/typebox'
import { basename, dirname } from 'node:path'
import {
  type CostFile,
  CostFileSchema,
  type CostInput,
  type CostPoint,
  type IncomeEntry,
  type IncomeInput,
  type PriceChange,
} from '../shared/types.ts'
import { decode, TypeBoxValidationError } from './validation.ts'

const MAX_AMORTIZATION_MONTHS = 1200
const MAX_INTERVAL_COUNT = 100_000
const MAX_COST_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 12)

// Legacy files omit newer collections, so TypeBox checks the migration envelope
// before the normalizer fills defaults and enforces semantic invariants.
// donations/knownUsers are schema v1 leftovers, accepted only to be migrated.
const StoredFileEnvelopeSchema = Type.Object({
  schemaVersion: Type.Unknown(),
  currency: Type.String(),
  exportedAt: Type.Optional(Type.Unknown()),
  costPoints: Type.Array(Type.Unknown()),
  income: Type.Optional(Type.Array(Type.Unknown())),
  donations: Type.Optional(Type.Array(Type.Unknown())),
  knownUsers: Type.Optional(Type.Array(Type.Unknown())),
  categoryIcons: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: true })

/** Shape of a schema v1 donation, parsed only by the one-time income migration. */
interface LegacyDonation {
  name: string
  amountCents: number
  cadence: 'one_time' | 'monthly' | 'yearly'
  receivedOn: string
  endsOn: string | null
  status: 'confirmed' | 'pending'
}

export class StoreValidationError extends Error {
  override name = 'StoreValidationError'
}

/**
 * The on-disk format is exactly the export format, so a previous export can be
 * dropped in as the data file without any conversion.
 */
export class Store {
  #file: string
  #data: CostFile
  #committedData: CostFile
  #costIdHighWater: number
  #incomeIdHighWater: number
  #writeQueue: Promise<void> = Promise.resolve()

  private constructor(
    file: string,
    data: CostFile,
    costIdHighWater: number,
    incomeIdHighWater: number,
  ) {
    this.#file = file
    this.#data = data
    this.#committedData = clone(data)
    this.#costIdHighWater = costIdHighWater
    this.#incomeIdHighWater = incomeIdHighWater
  }

  static async load(file: string): Promise<Store> {
    const raw = await readOptionalTextFile(file)
    let data: CostFile
    let needsMigration = false
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      needsMigration = record(parsed, 'root').schemaVersion === 1
      data = normalizeCostFile(parsed, false)
    } else {
      console.log(`[store] no data file at ${file}, starting empty`)
      data = {
        schemaVersion: 2,
        currency: 'EUR',
        exportedAt: new Date().toISOString(),
        costPoints: [],
        income: [],
        categoryIcons: {},
      }
    }

    // A deletion's previous state is normally still in the one-step backup.
    // It is a useful best-effort high-water seed without persisting counters.
    const backupRaw = await readOptionalTextFile(`${file}.bak`)
    let backup: CostFile | null = null
    if (backupRaw !== null) {
      try {
        backup = normalizeCostFile(JSON.parse(backupRaw), false)
      } catch {
        // A damaged optional backup must not prevent a valid primary file from starting.
        console.warn(`[store] ignoring invalid backup at ${file}.bak`)
      }
    }
    const store = new Store(
      file,
      data,
      Math.max(maxId(data.costPoints), maxId(backup?.costPoints ?? [])),
      Math.max(maxId(data.income), maxId(backup?.income ?? [])),
    )
    if (raw === null) {
      await store.#mutate(async () => {
        await store.#persist()
      })
    } else if (needsMigration) {
      // Commit the time-dependent donation expansion now. Leaving schema v1 on
      // disk would add another month of income if the process restarted later.
      await store.#mutate(async () => {
        await store.#persist()
      })
    }
    return store
  }

  get currency(): string {
    return this.#committedData.currency
  }

  get categoryIcons(): Record<string, string> {
    return { ...this.#committedData.categoryIcons }
  }

  list(): CostPoint[] {
    return clone(this.#committedData.costPoints).sort((a, b) => b.id - a.id)
  }

  async add(input: CostInput, icon?: string | null): Promise<CostPoint> {
    const next = normalizeCostInput(input, 'cost')
    const nextIcon = optionalString(icon, 'icon')
    return await this.#mutate(async () => {
      const id = this.#allocateCostId()
      this.#data.costPoints.push({ ...next, id })
      this.#applyIcon(next.category, nextIcon)
      await this.#persist()
      return clone(this.#data.costPoints.find((point) => point.id === id)!)
    })
  }

  async update(id: number, input: CostInput, icon?: string | null): Promise<CostPoint | null> {
    const validId = integer(id, 'id', 1)
    const next = normalizeCostInput(input, 'cost')
    const nextIcon = optionalString(icon, 'icon')
    return await this.#mutate(async () => {
      const index = this.#data.costPoints.findIndex((point) => point.id === validId)
      if (index === -1) return null
      this.#data.costPoints[index] = { ...next, id: validId }
      this.#applyIcon(next.category, nextIcon)
      await this.#persist()
      return clone(this.#data.costPoints.find((point) => point.id === validId)!)
    })
  }

  /** undefined = leave untouched, null = clear */
  #applyIcon(category: string, icon: string | null | undefined): void {
    if (icon === undefined) return
    if (icon === null) delete this.#data.categoryIcons[category]
    else this.#data.categoryIcons[category] = icon
  }

  async remove(id: number): Promise<boolean> {
    const validId = integer(id, 'id', 1)
    return await this.#mutate(async () => {
      const before = this.#data.costPoints.length
      this.#data.costPoints = this.#data.costPoints.filter((point) => point.id !== validId)
      if (this.#data.costPoints.length === before) return false
      await this.#persist()
      return true
    })
  }

  listIncome(): IncomeEntry[] {
    return clone(this.#committedData.income).sort(
      (a, b) => b.month.localeCompare(a.month) || b.id - a.id,
    )
  }

  async addIncome(input: IncomeInput): Promise<IncomeEntry> {
    const next = normalizeIncomeInput(input, 'income')
    return await this.#mutate(async () => {
      const id = this.#allocateIncomeId()
      this.#data.income.push({ ...next, id })
      await this.#persist()
      return clone(this.#data.income.find((entry) => entry.id === id)!)
    })
  }

  async updateIncome(id: number, input: IncomeInput): Promise<IncomeEntry | null> {
    const validId = integer(id, 'id', 1)
    const next = normalizeIncomeInput(input, 'income')
    return await this.#mutate(async () => {
      const index = this.#data.income.findIndex((entry) => entry.id === validId)
      if (index === -1) return null
      this.#data.income[index] = { ...next, id: validId }
      await this.#persist()
      return clone(this.#data.income.find((entry) => entry.id === validId)!)
    })
  }

  async removeIncome(id: number): Promise<boolean> {
    const validId = integer(id, 'id', 1)
    return await this.#mutate(async () => {
      const before = this.#data.income.length
      this.#data.income = this.#data.income.filter((entry) => entry.id !== validId)
      if (this.#data.income.length === before) return false
      await this.#persist()
      return true
    })
  }

  export(): CostFile {
    return clone({ ...this.#committedData, exportedAt: new Date().toISOString() })
  }

  async replaceFromImport(value: unknown): Promise<CostFile> {
    const next = normalizeCostFile(value)
    return await this.#mutate(async () => {
      this.#data = next
      this.#costIdHighWater = Math.max(this.#costIdHighWater, maxId(next.costPoints))
      this.#incomeIdHighWater = Math.max(this.#incomeIdHighWater, maxId(next.income))
      await this.#persist()
      return clone({ ...this.#data, exportedAt: new Date().toISOString() })
    })
  }

  #allocateCostId(): number {
    const highWater = Math.max(this.#costIdHighWater, maxId(this.#data.costPoints))
    if (highWater === Number.MAX_SAFE_INTEGER) {
      throw new StoreValidationError('cost point id space exhausted')
    }
    this.#costIdHighWater = highWater + 1
    return this.#costIdHighWater
  }

  #allocateIncomeId(): number {
    const highWater = Math.max(this.#incomeIdHighWater, maxId(this.#data.income))
    if (highWater === Number.MAX_SAFE_INTEGER) {
      throw new StoreValidationError('income id space exhausted')
    }
    this.#incomeIdHighWater = highWater + 1
    return this.#incomeIdHighWater
  }

  #mutate<T>(mutation: () => Promise<T>): Promise<T> {
    const queued = this.#writeQueue.then(async () => {
      const previousData = clone(this.#data)
      const previousCostId = this.#costIdHighWater
      const previousIncomeId = this.#incomeIdHighWater
      try {
        const result = await mutation()
        this.#committedData = clone(this.#data)
        return result
      } catch (err) {
        this.#data = previousData
        this.#costIdHighWater = previousCostId
        this.#incomeIdHighWater = previousIncomeId
        throw err
      }
    })
    this.#writeQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  async #persist(): Promise<void> {
    const live = new Set(this.#data.costPoints.map((point) => point.category))
    for (const category of Object.keys(this.#data.categoryIcons)) {
      if (!live.has(category)) delete this.#data.categoryIcons[category]
    }

    // Re-normalizing the complete snapshot ensures every successful write can
    // be loaded again, including writes assembled by internal reconciliation.
    this.#data = normalizeCostFile({
      ...this.#data,
      exportedAt: new Date().toISOString(),
    }, false)

    const directory = dirname(this.#file)
    await Deno.mkdir(directory, { recursive: true })
    try {
      await Deno.copyFile(this.#file, `${this.#file}.bak`)
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err
    }

    const temporary = await Deno.makeTempFile({
      dir: directory,
      prefix: `.${basename(this.#file)}.`,
      suffix: '.tmp',
    })
    try {
      await Deno.writeTextFile(temporary, JSON.stringify(this.#data, null, 2) + '\n')
      await Deno.rename(temporary, this.#file)
    } catch (err) {
      try {
        await Deno.remove(temporary)
      } catch (cleanupError) {
        if (!(cleanupError instanceof Deno.errors.NotFound)) {
          console.warn(`[store] could not remove temporary file ${temporary}`)
        }
      }
      throw err
    }
  }
}

function normalizeCostFile(value: unknown, strict = true): CostFile {
  try {
    decode(StoredFileEnvelopeSchema, value)
  } catch (error) {
    if (!(error instanceof TypeBoxValidationError)) throw error
    throw new StoreValidationError(`invalid cost file: ${error.message}`, { cause: error })
  }
  const root = record(value, 'root')
  if (root.schemaVersion !== 1 && root.schemaVersion !== 2) {
    throw new StoreValidationError('unsupported schemaVersion (expected 1 or 2)')
  }
  const schemaVersion = root.schemaVersion
  if (strict) {
    knownKeys(
      root,
      'root',
      schemaVersion === 1
        ? [
          'schemaVersion',
          'currency',
          'exportedAt',
          'costPoints',
          'donations',
          'knownUsers',
          'categoryIcons',
        ]
        : [
          'schemaVersion',
          'currency',
          'exportedAt',
          'costPoints',
          'income',
          'categoryIcons',
        ],
    )
  }
  if (schemaVersion === 2) {
    if (root.income === undefined) {
      throw new StoreValidationError('income is required for schemaVersion 2')
    }
    if (root.donations !== undefined || root.knownUsers !== undefined) {
      throw new StoreValidationError(
        'donations and knownUsers are not supported for schemaVersion 2',
      )
    }
  }

  const currency = strict
    ? currencyCode(root.currency, 'currency')
    : string(root.currency, 'currency')
  const rawPoints = array(root.costPoints, 'costPoints')

  const categoryIcons: Record<string, string> = Object.create(null)
  if (root.categoryIcons !== undefined) {
    const raw = record(root.categoryIcons, 'categoryIcons')
    for (const [category, icon] of Object.entries(raw)) {
      categoryIcons[category] = string(icon, `categoryIcons[${JSON.stringify(category)}]`)
    }
  }

  const costPoints = rawPoints.map((value, index): CostPoint => {
    const path = `costPoints[${index}]`
    const point = record(value, path)
    if (strict) {
      knownKeys(point, path, [
        'id',
        'name',
        'category',
        'costCents',
        'priceChanges',
        'cadence',
        'startsOn',
        'endsOn',
        'amortizationMonths',
        'intervalCount',
        'intervalUnit',
        'icon',
      ])
    }
    const input = normalizeCostInput(point, path, strict)
    // legacy migration: per-point icons become the category icon (first one wins)
    const legacyIcon = nullableString(point.icon, `costPoints[${index}].icon`)
    if (legacyIcon && categoryIcons[input.category] === undefined) {
      categoryIcons[input.category] = legacyIcon
    }
    return {
      ...input,
      id: integer(point.id, `costPoints[${index}].id`, 1),
    }
  })

  const income = schemaVersion === 1
    ? migrateLegacyDonations(root.donations, 'donations', strict)
    : array(root.income, 'income').map((value, index): IncomeEntry => {
      const path = `income[${index}]`
      const entry = record(value, path)
      if (strict) knownKeys(entry, path, ['id', 'month', 'amountCents', 'note'])
      return {
        ...normalizeIncomeInput(entry, path, strict),
        id: integer(entry.id, `income[${index}].id`, 1),
      }
    })
  if (schemaVersion === 1 && strict) {
    validateLegacyKnownUsers(root.knownUsers, 'knownUsers')
  }

  uniqueIds(income, 'income')
  uniqueIds(costPoints, 'costPoints')

  const normalized = {
    schemaVersion: 2 as const,
    currency,
    exportedAt: root.exportedAt === undefined
      ? new Date().toISOString()
      : strict
      ? timestamp(root.exportedAt, 'exportedAt')
      : typeof root.exportedAt === 'string'
      ? root.exportedAt
      : new Date().toISOString(),
    costPoints,
    income,
    categoryIcons,
  }
  try {
    return decode(CostFileSchema, normalized)
  } catch (error) {
    if (!(error instanceof TypeBoxValidationError)) throw error
    throw new StoreValidationError(`invalid normalized cost file: ${error.message}`, {
      cause: error,
    })
  }
}

function normalizeCostInput(value: unknown, path: string, strict = true): CostInput {
  const point = record(value, path)
  const name = string(point.name, `${path}.name`)
  const category = string(point.category, `${path}.category`)
  const costCents = integer(
    point.costCents,
    `${path}.costCents`,
    0,
    strict ? MAX_COST_CENTS : Number.MAX_SAFE_INTEGER,
  )
  const cadence = string(point.cadence, `${path}.cadence`)
  if (
    cadence !== 'one_time' && cadence !== 'monthly' && cadence !== 'yearly' && cadence !== 'custom'
  ) {
    throw new StoreValidationError(`${path}.cadence is invalid`)
  }

  const startsOn = date(point.startsOn, `${path}.startsOn`)
  const endsOn = nullableDate(point.endsOn, `${path}.endsOn`)
  if (strict && startsOn < '1970-01-01') {
    throw new StoreValidationError(`${path}.startsOn must not be before 1970`)
  }
  if (strict && endsOn !== null && endsOn < startsOn) {
    throw new StoreValidationError(`${path}.endsOn must be on or after ${path}.startsOn`)
  }

  const amortizationMonths = nullableInteger(
    point.amortizationMonths,
    `${path}.amortizationMonths`,
    MAX_AMORTIZATION_MONTHS,
  )
  const intervalCount = nullableInteger(
    point.intervalCount,
    `${path}.intervalCount`,
    MAX_INTERVAL_COUNT,
  )
  const unit = intervalUnit(point.intervalUnit, `${path}.intervalUnit`)

  if (strict && cadence === 'custom') {
    if (intervalCount === null || unit === null) {
      throw new StoreValidationError(
        `${path}.intervalCount and ${path}.intervalUnit are required for custom cadence`,
      )
    }
  } else if (strict && (intervalCount !== null || unit !== null)) {
    throw new StoreValidationError(
      `${path}.intervalCount and ${path}.intervalUnit are only valid for custom cadence`,
    )
  }
  if (strict && cadence !== 'one_time' && amortizationMonths !== null) {
    throw new StoreValidationError(`${path}.amortizationMonths is only valid for one_time cadence`)
  }

  const priceChanges = normalizePriceChanges(point.priceChanges, `${path}.priceChanges`, strict)

  if (strict && cadence === 'one_time' && priceChanges.length > 0) {
    throw new StoreValidationError(`${path}.priceChanges is not valid for one_time cadence`)
  }
  if (
    strict && priceChanges.length > 0 &&
    priceChanges[0]!.startsOn.slice(0, 7) <= startsOn.slice(0, 7)
  ) {
    throw new StoreValidationError(
      `${path}.priceChanges must start in a later month than ${path}.startsOn`,
    )
  }

  return {
    name,
    category,
    costCents,
    priceChanges,
    cadence,
    startsOn,
    endsOn,
    amortizationMonths,
    intervalCount,
    intervalUnit: unit,
  }
}

/**
 * Stored sorted with unique calendar months so calc can scan changes in
 * order; input order is normalized away instead of rejected, but two changes
 * in the same month are ambiguous and always an error.
 */
function normalizePriceChanges(value: unknown, path: string, strict: boolean): PriceChange[] {
  if (value === undefined || value === null) return []
  const changes = array(value, path).map((entry, index): PriceChange => {
    const changePath = `${path}[${index}]`
    const change = record(entry, changePath)
    if (strict) knownKeys(change, changePath, ['startsOn', 'costCents'])
    return {
      startsOn: date(change.startsOn, `${changePath}.startsOn`),
      costCents: integer(
        change.costCents,
        `${changePath}.costCents`,
        0,
        strict ? MAX_COST_CENTS : Number.MAX_SAFE_INTEGER,
      ),
    }
  })
  changes.sort((a, b) => a.startsOn.localeCompare(b.startsOn))
  for (let index = 1; index < changes.length; index++) {
    if (changes[index]!.startsOn.slice(0, 7) === changes[index - 1]!.startsOn.slice(0, 7)) {
      throw new StoreValidationError(`${path} must not repeat a calendar month`)
    }
  }
  return changes
}

function normalizeIncomeInput(value: unknown, path: string, strict = true): IncomeInput {
  const entry = record(value, path)
  const incomeMonth = month(entry.month, `${path}.month`)
  if (strict && incomeMonth < '1970-01') {
    throw new StoreValidationError(`${path}.month must not be before 1970`)
  }
  return {
    month: incomeMonth,
    amountCents: integer(entry.amountCents, `${path}.amountCents`, 1),
    note: nullableString(entry.note, `${path}.note`),
  }
}

/**
 * Schema v1 donations become income entries: one entry per calendar month the
 * donation counted, capped at the current month — money received until now,
 * never forecasts. Pending donations were never counted and are dropped; the
 * donor name survives as the entry note.
 */
function migrateLegacyDonations(value: unknown, path: string, strict: boolean): IncomeEntry[] {
  if (value === undefined || value === null) return []
  const entries: IncomeEntry[] = []
  const donationIds = new Set<number>()
  const currentMonth = new Date().toISOString().slice(0, 7)
  for (const [index, raw] of array(value, path).entries()) {
    const donationPath = `${path}[${index}]`
    const donationRecord = record(raw, donationPath)
    if (strict) {
      knownKeys(donationRecord, donationPath, [
        'id',
        'name',
        'amountCents',
        'cadence',
        'receivedOn',
        'endsOn',
        'status',
        'submittedBy',
        'userId',
      ])
      const id = integer(donationRecord.id, `${donationPath}.id`, 1)
      if (donationIds.has(id)) {
        throw new StoreValidationError(`${path} contains duplicate id ${id}`)
      }
      donationIds.add(id)
    }
    // Disk loading stays lenient because files from early releases omitted
    // fields and carried fields that no longer affect the converted income.
    const donation = normalizeLegacyDonation(donationRecord, donationPath)
    if (strict) {
      if (donation.receivedOn < '1970-01-01') {
        throw new StoreValidationError(`${donationPath}.receivedOn must not be before 1970`)
      }
      if (donation.endsOn !== null && donation.endsOn < donation.receivedOn) {
        throw new StoreValidationError(`${donationPath}.endsOn must be on or after receivedOn`)
      }
      if (donation.cadence === 'one_time' && donation.endsOn !== null) {
        throw new StoreValidationError(`${donationPath}.endsOn must be null for one_time cadence`)
      }
      nullableString(donationRecord.submittedBy, `${donationPath}.submittedBy`)
      nullableString(donationRecord.userId, `${donationPath}.userId`)
    }
    if (donation.status === 'pending') continue
    const endMonth = donation.endsOn?.slice(0, 7) ?? currentMonth
    const lastMonth = endMonth < currentMonth ? endMonth : currentMonth
    for (let entryMonth = donation.receivedOn.slice(0, 7); entryMonth <= lastMonth;) {
      if (legacyDonationCentsForMonth(donation, entryMonth) > 0) {
        entries.push({
          id: entries.length + 1,
          month: entryMonth,
          amountCents: donation.amountCents,
          note: donation.name,
        })
      }
      entryMonth = nextMonth(entryMonth)
    }
  }
  return entries
}

function validateLegacyKnownUsers(value: unknown, path: string): void {
  if (value === undefined || value === null) return
  const ids = new Set<string>()
  for (const [index, raw] of array(value, path).entries()) {
    const userPath = `${path}[${index}]`
    const user = record(raw, userPath)
    knownKeys(user, userPath, ['id', 'name', 'lastSeenAt', 'archived'])
    const id = string(user.id, `${userPath}.id`)
    string(user.name, `${userPath}.name`)
    if (user.lastSeenAt !== undefined) timestamp(user.lastSeenAt, `${userPath}.lastSeenAt`)
    if (user.archived !== undefined && typeof user.archived !== 'boolean') {
      throw new StoreValidationError(`${userPath}.archived must be a boolean`)
    }
    if (ids.has(id)) throw new StoreValidationError(`${path} contains duplicate id ${id}`)
    ids.add(id)
  }
}

function normalizeLegacyDonation(value: unknown, path: string): LegacyDonation {
  const donation = record(value, path)
  const cadence = donation.cadence === undefined
    ? 'one_time'
    : string(donation.cadence, `${path}.cadence`)
  if (cadence !== 'one_time' && cadence !== 'monthly' && cadence !== 'yearly') {
    throw new StoreValidationError(`${path}.cadence is invalid`)
  }
  const status = donation.status === undefined
    ? 'confirmed'
    : string(donation.status, `${path}.status`)
  if (status !== 'confirmed' && status !== 'pending') {
    throw new StoreValidationError(`${path}.status is invalid`)
  }
  return {
    name: string(donation.name, `${path}.name`),
    amountCents: integer(donation.amountCents, `${path}.amountCents`, 1),
    cadence,
    receivedOn: date(donation.receivedOn, `${path}.receivedOn`),
    endsOn: nullableDate(donation.endsOn, `${path}.endsOn`),
    status,
  }
}

/** The amount a legacy donation counted for in a month, mirroring the retired cadence rules. */
function legacyDonationCentsForMonth(donation: LegacyDonation, month: string): number {
  const startMonth = donation.receivedOn.slice(0, 7)
  const endMonth = donation.endsOn?.slice(0, 7) ?? null
  if (month < startMonth || (endMonth && month > endMonth)) return 0
  if (donation.cadence === 'one_time') return month === startMonth ? donation.amountCents : 0
  if (donation.cadence === 'monthly') return donation.amountCents
  return month.slice(5, 7) === startMonth.slice(5, 7) ? donation.amountCents : 0
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, '0')}`
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreValidationError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function knownKeys(value: Record<string, unknown>, path: string, allowed: string[]): void {
  const expected = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new StoreValidationError(`${path}.${key} is not supported`)
  }
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new StoreValidationError(`${path} must be an array`)
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoreValidationError(`${path} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, path: string): string | null | undefined {
  if (value === undefined) return undefined
  return nullableString(value, path)
}

function nullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  return string(value, path)
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new StoreValidationError(
      `${path} must be a safe integer between ${minimum} and ${maximum}`,
    )
  }
  return value as number
}

function nullableInteger(value: unknown, path: string, maximum: number): number | null {
  if (value === undefined || value === null) return null
  return integer(value, path, 1, maximum)
}

function date(value: unknown, path: string): string {
  const iso = string(value, path)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new StoreValidationError(`${path} must be YYYY-MM-DD`)
  const [year, month, day] = iso.split('-').map(Number)
  const parsed = new Date(Date.UTC(year!, month! - 1, day!))
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new StoreValidationError(`${path} is not a valid date`)
  }
  return iso
}

function nullableDate(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  return date(value, path)
}

function month(value: unknown, path: string): string {
  const iso = string(value, path)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(iso)) {
    throw new StoreValidationError(`${path} must be YYYY-MM`)
  }
  return iso
}

function timestamp(value: unknown, path: string): string {
  const iso = string(value, path)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || !Number.isFinite(Date.parse(iso))) {
    throw new StoreValidationError(`${path} must be a valid ISO timestamp`)
  }
  date(iso.slice(0, 10), path)
  return iso
}

function intervalUnit(value: unknown, path: string): CostPoint['intervalUnit'] {
  if (value === undefined || value === null) return null
  if (value !== 'days' && value !== 'weeks' && value !== 'months' && value !== 'years') {
    throw new StoreValidationError(`${path} is invalid`)
  }
  return value
}

function currencyCode(value: unknown, path: string): string {
  const code = string(value, path)
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new StoreValidationError(`${path} must be a three-letter currency code`)
  }
  try {
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: code })
  } catch {
    throw new StoreValidationError(`${path} is not supported by Intl.NumberFormat`)
  }
  return code
}

function uniqueIds(values: Array<{ id: number }>, path: string): void {
  const ids = new Set<number>()
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new StoreValidationError(`${path} contains duplicate id ${value.id}`)
    }
    ids.add(value.id)
  }
}

function maxId(values: Array<{ id: number }>): number {
  return values.reduce((maximum, value) => Math.max(maximum, value.id), 0)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

async function readOptionalTextFile(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null
    throw err
  }
}
