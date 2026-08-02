import { basename, dirname } from 'node:path'
import type {
  CostFile,
  CostInput,
  CostPoint,
  Donation,
  DonationInput,
  KnownUser,
} from '../shared/types.ts'

const MAX_AMORTIZATION_MONTHS = 1200
const MAX_INTERVAL_COUNT = 100_000

/**
 * The on-disk format is exactly the export format, so a previous export can be
 * dropped in as the data file without any conversion.
 */
export class Store {
  #file: string
  #data: CostFile
  #costIdHighWater: number
  #donationIdHighWater: number
  #writeQueue: Promise<void> = Promise.resolve()

  private constructor(
    file: string,
    data: CostFile,
    costIdHighWater: number,
    donationIdHighWater: number,
  ) {
    this.#file = file
    this.#data = data
    this.#costIdHighWater = costIdHighWater
    this.#donationIdHighWater = donationIdHighWater
  }

  static async load(file: string): Promise<Store> {
    const raw = await readOptionalTextFile(file)
    let data: CostFile
    if (raw !== null) {
      data = normalizeCostFile(JSON.parse(raw))
    } else {
      console.log(`[store] no data file at ${file}, starting empty`)
      data = {
        schemaVersion: 1,
        currency: 'EUR',
        exportedAt: new Date().toISOString(),
        costPoints: [],
        donations: [],
        knownUsers: [],
        categoryIcons: {},
      }
    }

    // A deletion's previous state is normally still in the one-step backup.
    // It is a useful best-effort high-water seed without changing schema v1.
    const backupRaw = await readOptionalTextFile(`${file}.bak`)
    const backup = backupRaw === null ? null : normalizeCostFile(JSON.parse(backupRaw))
    const store = new Store(
      file,
      data,
      Math.max(maxId(data.costPoints), maxId(backup?.costPoints ?? [])),
      Math.max(maxId(data.donations), maxId(backup?.donations ?? [])),
    )
    if (raw === null) {
      await store.#mutate(async () => {
        await store.#persist()
      })
    }
    return store
  }

  get currency(): string {
    return this.#data.currency
  }

  get categoryIcons(): Record<string, string> {
    return { ...this.#data.categoryIcons }
  }

  list(): CostPoint[] {
    return clone(this.#data.costPoints).sort((a, b) => b.id - a.id)
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

  listKnownUsers(): KnownUser[] {
    return clone(this.#data.knownUsers).sort((a, b) =>
      Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name)
    )
  }

  /**
   * Reconciles the archive with the users currently on the Jellyfin server:
   * present users are upserted (name refreshed, un-archived), users that
   * disappeared are kept but marked archived — never deleted, so donations
   * stay attributable and returning donors map to the same id.
   */
  async syncKnownUsers(current: Array<{ id: string; name: string }>): Promise<KnownUser[]> {
    const users = normalizeUserSightings(current, 'users')
    return await this.#mutate(async () => {
      const now = new Date().toISOString()
      const seen = new Set(users.map((user) => user.id))

      for (const user of users) this.#touchKnownUser(user, now)
      for (const known of this.#data.knownUsers) {
        if (!seen.has(known.id)) known.archived = true
      }

      await this.#persist()
      return this.listKnownUsers()
    })
  }

  /** exact-name lookup among known users — active accounts win over archived, ambiguity yields null */
  #userByName(name: string, excludedIds: Set<string>): KnownUser | null {
    const needle = name.trim().toLowerCase()
    if (!needle) return null
    const matches = this.#data.knownUsers.filter((user) =>
      !excludedIds.has(user.id) && user.name.trim().toLowerCase() === needle
    )
    const active = matches.filter((user) => !user.archived)
    if (active.length === 1) return active[0]!
    if (active.length === 0 && matches.length === 1) return matches[0]!
    return null
  }

  /**
   * One donor name, one identity. Only confirmed donations may establish or
   * inherit an identity; a self-submission must not relink history while it is
   * pending. Names claimed by different confirmed users remain ambiguous.
   */
  #reconcileDonationLinks(): boolean {
    const claimed = new Map<string, string | null>()
    const pendingNames = new Set<string>()
    const pendingUserIds = new Set<string>()
    for (const donation of this.#data.donations) {
      const key = donation.name.trim().toLowerCase()
      if (donation.status === 'pending') {
        pendingNames.add(key)
        if (donation.userId) pendingUserIds.add(donation.userId)
        continue
      }
      if (!donation.userId) continue
      claimed.set(
        key,
        claimed.has(key) && claimed.get(key) !== donation.userId ? null : donation.userId,
      )
    }

    let changed = false
    for (const donation of this.#data.donations) {
      if (donation.status !== 'confirmed' || donation.userId) continue
      const key = donation.name.trim().toLowerCase()
      if (claimed.has(key)) {
        const inherited = claimed.get(key)
        if (inherited) {
          donation.userId = inherited
          changed = true
        }
        continue
      }
      if (pendingNames.has(key)) continue
      const user = this.#userByName(donation.name, pendingUserIds)
      if (user) {
        donation.userId = user.id
        changed = true
      }
    }
    return changed
  }

  /** Records a single user sighting (e.g. the submitter of a donation). */
  async touchKnownUser(user: { id: string; name: string }): Promise<void> {
    const validUser = normalizeUserSighting(user, 'user')
    await this.#mutate(async () => {
      this.#touchKnownUser(validUser, new Date().toISOString())
      await this.#persist()
    })
  }

  #touchKnownUser(user: { id: string; name: string }, now: string): void {
    const known = this.#data.knownUsers.find((candidate) => candidate.id === user.id)
    if (!known) {
      this.#data.knownUsers.push({
        id: user.id,
        name: user.name,
        lastSeenAt: now,
        archived: false,
      })
      return
    }
    known.name = user.name
    known.archived = false
    known.lastSeenAt = now
  }

  listDonations(): Donation[] {
    return clone(this.#data.donations).sort(
      (a, b) => b.receivedOn.localeCompare(a.receivedOn) || b.id - a.id,
    )
  }

  async addDonation(input: DonationInput): Promise<Donation> {
    const next = normalizeDonationInput(input, 'donation')
    return await this.#mutate(async () => {
      const id = this.#insertDonation(next, 'confirmed', null)
      await this.#persist()
      return clone(this.#data.donations.find((donation) => donation.id === id)!)
    })
  }

  /** user-submitted donation: stays pending (not counted) until an admin confirms it */
  async submitDonation(
    input: DonationInput,
    submitter: { id: string; name: string },
  ): Promise<Donation> {
    const next = normalizeDonationInput(input, 'donation')
    const validSubmitter = normalizeUserSighting(submitter, 'submitter')
    return await this.#mutate(async () => {
      this.#touchKnownUser(validSubmitter, new Date().toISOString())
      const id = this.#insertDonation(
        { ...next, userId: validSubmitter.id },
        'pending',
        validSubmitter.name,
      )
      await this.#persist()
      return clone(this.#data.donations.find((donation) => donation.id === id)!)
    })
  }

  #insertDonation(
    input: DonationInput,
    status: Donation['status'],
    submittedBy: string | null,
  ): number {
    const id = this.#allocateDonationId()
    this.#data.donations.push({ ...input, id, status, submittedBy })
    return id
  }

  async confirmDonation(id: number): Promise<Donation | null> {
    const validId = integer(id, 'id', 1)
    return await this.#mutate(async () => {
      const donation = this.#data.donations.find((candidate) => candidate.id === validId)
      if (!donation) return null
      if (donation.status !== 'confirmed') {
        donation.status = 'confirmed'
        await this.#persist()
      }
      return clone(this.#data.donations.find((candidate) => candidate.id === validId)!)
    })
  }

  async updateDonation(id: number, input: DonationInput): Promise<Donation | null> {
    const validId = integer(id, 'id', 1)
    const next = normalizeDonationInput(input, 'donation')
    return await this.#mutate(async () => {
      const index = this.#data.donations.findIndex((donation) => donation.id === validId)
      if (index === -1) return null
      const existing = this.#data.donations[index]!
      this.#data.donations[index] = {
        ...next,
        id: validId,
        status: existing.status,
        submittedBy: existing.submittedBy,
      }
      await this.#persist()
      return clone(this.#data.donations.find((donation) => donation.id === validId)!)
    })
  }

  async removeDonation(id: number): Promise<boolean> {
    const validId = integer(id, 'id', 1)
    return await this.#mutate(async () => {
      const before = this.#data.donations.length
      this.#data.donations = this.#data.donations.filter((donation) => donation.id !== validId)
      if (this.#data.donations.length === before) return false
      await this.#persist()
      return true
    })
  }

  export(): CostFile {
    return clone({ ...this.#data, exportedAt: new Date().toISOString() })
  }

  async replaceFromImport(value: unknown): Promise<CostFile> {
    const next = normalizeCostFile(value)
    return await this.#mutate(async () => {
      this.#data = next
      this.#costIdHighWater = Math.max(this.#costIdHighWater, maxId(next.costPoints))
      this.#donationIdHighWater = Math.max(
        this.#donationIdHighWater,
        maxId(next.donations),
      )
      await this.#persist()
      return this.export()
    })
  }

  #allocateCostId(): number {
    const highWater = Math.max(this.#costIdHighWater, maxId(this.#data.costPoints))
    if (highWater === Number.MAX_SAFE_INTEGER) throw new Error('cost point id space exhausted')
    this.#costIdHighWater = highWater + 1
    return this.#costIdHighWater
  }

  #allocateDonationId(): number {
    const highWater = Math.max(this.#donationIdHighWater, maxId(this.#data.donations))
    if (highWater === Number.MAX_SAFE_INTEGER) throw new Error('donation id space exhausted')
    this.#donationIdHighWater = highWater + 1
    return this.#donationIdHighWater
  }

  #mutate<T>(mutation: () => Promise<T>): Promise<T> {
    const queued = this.#writeQueue.then(async () => {
      const previousData = clone(this.#data)
      const previousCostId = this.#costIdHighWater
      const previousDonationId = this.#donationIdHighWater
      try {
        return await mutation()
      } catch (err) {
        this.#data = previousData
        this.#costIdHighWater = previousCostId
        this.#donationIdHighWater = previousDonationId
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
    this.#reconcileDonationLinks()
    const live = new Set(this.#data.costPoints.map((point) => point.category))
    for (const category of Object.keys(this.#data.categoryIcons)) {
      if (!live.has(category)) delete this.#data.categoryIcons[category]
    }

    // Re-normalizing the complete snapshot ensures every successful write can
    // be loaded again, including writes assembled by internal reconciliation.
    this.#data = normalizeCostFile({
      ...this.#data,
      exportedAt: new Date().toISOString(),
    })

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

function normalizeCostFile(value: unknown): CostFile {
  const root = record(value, 'root')
  if (root.schemaVersion !== 1) throw new Error('unsupported schemaVersion (expected 1)')

  const currency = currencyCode(root.currency, 'currency')
  const rawPoints = array(root.costPoints, 'costPoints')
  const rawDonations = root.donations === undefined ? [] : array(root.donations, 'donations')
  const rawKnownUsers = root.knownUsers === undefined ? [] : array(root.knownUsers, 'knownUsers')

  const categoryIcons: Record<string, string> = Object.create(null)
  if (root.categoryIcons !== undefined) {
    const raw = record(root.categoryIcons, 'categoryIcons')
    for (const [category, icon] of Object.entries(raw)) {
      categoryIcons[category] = string(icon, `categoryIcons[${JSON.stringify(category)}]`)
    }
  }

  const costPoints = rawPoints.map((value, index): CostPoint => {
    const point = record(value, `costPoints[${index}]`)
    const input = normalizeCostInput(point, `costPoints[${index}]`)
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

  const donations = rawDonations.map((value, index): Donation => {
    const donation = record(value, `donations[${index}]`)
    const input = normalizeDonationInput(donation, `donations[${index}]`)
    const status = donation.status === undefined
      ? 'confirmed'
      : string(donation.status, `donations[${index}].status`)
    if (status !== 'confirmed' && status !== 'pending') {
      throw new Error(`donations[${index}].status is invalid`)
    }
    return {
      ...input,
      id: integer(donation.id, `donations[${index}].id`, 1),
      status,
      submittedBy: nullableString(
        donation.submittedBy,
        `donations[${index}].submittedBy`,
      ),
    }
  })

  const knownUsers = rawKnownUsers.map((value, index): KnownUser => {
    const user = record(value, `knownUsers[${index}]`)
    return {
      id: string(user.id, `knownUsers[${index}].id`),
      name: string(user.name, `knownUsers[${index}].name`),
      lastSeenAt: user.lastSeenAt === undefined
        ? new Date().toISOString()
        : timestamp(user.lastSeenAt, `knownUsers[${index}].lastSeenAt`),
      archived: optionalBoolean(user.archived, `knownUsers[${index}].archived`, false),
    }
  })
  uniqueStrings(knownUsers, 'knownUsers')
  uniqueIds(costPoints, 'costPoints')
  uniqueIds(donations, 'donations')

  return {
    schemaVersion: 1,
    currency,
    exportedAt: root.exportedAt === undefined
      ? new Date().toISOString()
      : timestamp(root.exportedAt, 'exportedAt'),
    costPoints,
    donations,
    knownUsers,
    categoryIcons,
  }
}

function normalizeCostInput(value: unknown, path: string): CostInput {
  const point = record(value, path)
  const name = string(point.name, `${path}.name`)
  const category = string(point.category, `${path}.category`)
  const costCents = integer(point.costCents, `${path}.costCents`, 0)
  const cadence = string(point.cadence, `${path}.cadence`)
  if (
    cadence !== 'one_time' && cadence !== 'monthly' && cadence !== 'yearly' && cadence !== 'custom'
  ) {
    throw new Error(`${path}.cadence is invalid`)
  }

  const startsOn = date(point.startsOn, `${path}.startsOn`)
  const endsOn = nullableDate(point.endsOn, `${path}.endsOn`)
  if (endsOn !== null && endsOn < startsOn) {
    throw new Error(`${path}.endsOn must be on or after ${path}.startsOn`)
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

  if (cadence === 'custom') {
    if (intervalCount === null || unit === null) {
      throw new Error(
        `${path}.intervalCount and ${path}.intervalUnit are required for custom cadence`,
      )
    }
  } else if (intervalCount !== null || unit !== null) {
    throw new Error(
      `${path}.intervalCount and ${path}.intervalUnit are only valid for custom cadence`,
    )
  }
  if (cadence !== 'one_time' && amortizationMonths !== null) {
    throw new Error(`${path}.amortizationMonths is only valid for one_time cadence`)
  }

  return {
    name,
    category,
    costCents,
    cadence,
    startsOn,
    endsOn,
    amortizationMonths,
    intervalCount,
    intervalUnit: unit,
  }
}

function normalizeDonationInput(value: unknown, path: string): DonationInput {
  const donation = record(value, path)
  const name = string(donation.name, `${path}.name`)
  const amountCents = integer(donation.amountCents, `${path}.amountCents`, 1)
  const cadence = donation.cadence === undefined
    ? 'one_time'
    : string(donation.cadence, `${path}.cadence`)
  if (cadence !== 'one_time' && cadence !== 'monthly' && cadence !== 'yearly') {
    throw new Error(`${path}.cadence is invalid`)
  }

  const receivedOn = date(donation.receivedOn, `${path}.receivedOn`)
  const endsOn = nullableDate(donation.endsOn, `${path}.endsOn`)
  if (endsOn !== null && endsOn < receivedOn) {
    throw new Error(`${path}.endsOn must be on or after ${path}.receivedOn`)
  }
  if (cadence === 'one_time' && endsOn !== null) {
    throw new Error(`${path}.endsOn must be null for one_time cadence`)
  }

  return {
    name,
    amountCents,
    cadence,
    receivedOn,
    endsOn,
    userId: nullableString(donation.userId, `${path}.userId`),
  }
}

function normalizeUserSightings(
  value: unknown,
  path: string,
): Array<{ id: string; name: string }> {
  const users = array(value, path).map((user, index) =>
    normalizeUserSighting(user, `${path}[${index}]`)
  )
  const ids = new Set<string>()
  for (const user of users) {
    if (ids.has(user.id)) throw new Error(`${path} contains duplicate id ${user.id}`)
    ids.add(user.id)
  }
  return users
}

function normalizeUserSighting(value: unknown, path: string): { id: string; name: string } {
  const user = record(value, path)
  return {
    id: string(user.id, `${path}.id`),
    name: string(user.name, `${path}.name`),
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`)
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
    throw new Error(`${path} must be a safe integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function nullableInteger(value: unknown, path: string, maximum: number): number | null {
  if (value === undefined || value === null) return null
  return integer(value, path, 1, maximum)
}

function date(value: unknown, path: string): string {
  const iso = string(value, path)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`${path} must be YYYY-MM-DD`)
  const [year, month, day] = iso.split('-').map(Number)
  const parsed = new Date(Date.UTC(year!, month! - 1, day!))
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${path} is not a valid date`)
  }
  return iso
}

function nullableDate(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  return date(value, path)
}

function timestamp(value: unknown, path: string): string {
  const iso = string(value, path)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || !Number.isFinite(Date.parse(iso))) {
    throw new Error(`${path} must be a valid ISO timestamp`)
  }
  date(iso.slice(0, 10), path)
  return iso
}

function intervalUnit(value: unknown, path: string): CostPoint['intervalUnit'] {
  if (value === undefined || value === null) return null
  if (value !== 'days' && value !== 'weeks' && value !== 'months' && value !== 'years') {
    throw new Error(`${path} is invalid`)
  }
  return value
}

function currencyCode(value: unknown, path: string): string {
  const code = string(value, path)
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`${path} must be a three-letter currency code`)
  try {
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: code })
  } catch {
    throw new Error(`${path} is not supported by Intl.NumberFormat`)
  }
  return code
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function uniqueIds(values: Array<{ id: number }>, path: string): void {
  const ids = new Set<number>()
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${path} contains duplicate id ${value.id}`)
    ids.add(value.id)
  }
}

function uniqueStrings(values: Array<{ id: string }>, path: string): void {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${path} contains duplicate id ${value.id}`)
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
