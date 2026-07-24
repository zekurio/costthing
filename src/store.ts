import { dirname } from 'node:path'
import type {
  CostFile,
  CostInput,
  CostPoint,
  Donation,
  DonationInput,
  KnownUser,
} from '../shared/types.ts'

/**
 * The on-disk format is exactly the export format, so a previous export can be
 * dropped in as the data file without any conversion.
 */
export class Store {
  #file: string
  #data: CostFile

  private constructor(file: string, data: CostFile) {
    this.#file = file
    this.#data = data
  }

  static async load(file: string): Promise<Store> {
    let raw: string | null = null
    try {
      raw = await Deno.readTextFile(file)
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err
      console.log(`[store] no data file at ${file}, starting empty`)
    }

    let data: CostFile
    if (raw !== null) {
      data = normalizeCostFile(JSON.parse(raw))
    } else {
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

    const store = new Store(file, data)
    if (!(await exists(file))) await store.#persist()
    return store
  }

  get currency(): string {
    return this.#data.currency
  }

  get categoryIcons(): Record<string, string> {
    return { ...this.#data.categoryIcons }
  }

  list(): CostPoint[] {
    return [...this.#data.costPoints].sort((a, b) => b.id - a.id)
  }

  async add(input: CostInput, icon?: string | null): Promise<CostPoint> {
    const id = this.#data.costPoints.reduce((max, p) => Math.max(max, p.id), 0) + 1
    const point: CostPoint = { id, ...input }
    this.#data.costPoints.push(point)
    this.#applyIcon(input.category, icon)
    await this.#persist()
    return point
  }

  async update(id: number, input: CostInput, icon?: string | null): Promise<CostPoint | null> {
    const index = this.#data.costPoints.findIndex((p) => p.id === id)
    if (index === -1) return null
    const point: CostPoint = { id, ...input }
    this.#data.costPoints[index] = point
    this.#applyIcon(input.category, icon)
    await this.#persist()
    return point
  }

  /** undefined = leave untouched, null = clear */
  #applyIcon(category: string, icon: string | null | undefined): void {
    if (icon === undefined) return
    if (icon === null) delete this.#data.categoryIcons[category]
    else this.#data.categoryIcons[category] = icon
  }

  async remove(id: number): Promise<boolean> {
    const before = this.#data.costPoints.length
    this.#data.costPoints = this.#data.costPoints.filter((p) => p.id !== id)
    if (this.#data.costPoints.length === before) return false
    await this.#persist()
    return true
  }

  listKnownUsers(): KnownUser[] {
    return [...this.#data.knownUsers].sort((a, b) =>
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
    const now = new Date().toISOString()
    const seen = new Set(current.map((u) => u.id))
    let changed = false

    for (const user of current) {
      const known = this.#data.knownUsers.find((k) => k.id === user.id)
      if (!known) {
        this.#data.knownUsers.push({
          id: user.id,
          name: user.name,
          lastSeenAt: now,
          archived: false,
        })
        changed = true
      } else if (known.name !== user.name || known.archived) {
        known.name = user.name
        known.archived = false
        known.lastSeenAt = now
        changed = true
      } else {
        known.lastSeenAt = now // refreshed silently; persisted with the next write
      }
    }
    for (const known of this.#data.knownUsers) {
      if (!seen.has(known.id) && !known.archived) {
        known.archived = true
        changed = true
      }
    }

    // backfill: donations recorded before a user existed (or before linking
    // shipped) get matched now that the archive is fresh
    if (changed || this.#reconcileDonationLinks()) await this.#persist()
    return this.listKnownUsers()
  }

  /** exact-name lookup among known users — active accounts win over archived, ambiguity yields null */
  #userByName(name: string): KnownUser | null {
    const needle = name.trim().toLowerCase()
    if (!needle) return null
    const matches = this.#data.knownUsers.filter((u) => u.name.trim().toLowerCase() === needle)
    const active = matches.filter((u) => !u.archived)
    if (active.length === 1) return active[0]!
    if (active.length === 0 && matches.length === 1) return matches[0]!
    return null
  }

  /**
   * One donor name, one identity. Unlinked donations inherit the link of
   * already-linked donations with the same name (a single manual link spreads
   * to the donor's whole history), otherwise they are matched to a Jellyfin
   * account by exact name. Runs on every write, so it also backfills data
   * from before linking existed. Names claimed by several different users
   * are left alone — better unlinked than wrong.
   */
  #reconcileDonationLinks(): boolean {
    // donor name → userId from linked donations; null marks an ambiguous name
    const claimed = new Map<string, string | null>()
    for (const d of this.#data.donations) {
      if (!d.userId) continue
      const key = d.name.trim().toLowerCase()
      claimed.set(key, claimed.has(key) && claimed.get(key) !== d.userId ? null : d.userId)
    }
    let changed = false
    for (const d of this.#data.donations) {
      if (d.userId) continue
      const key = d.name.trim().toLowerCase()
      if (claimed.has(key)) {
        const inherited = claimed.get(key)
        if (inherited) {
          d.userId = inherited
          changed = true
        }
        continue // ambiguous name — never guess
      }
      const user = this.#userByName(d.name)
      if (user) {
        d.userId = user.id
        changed = true
      }
    }
    return changed
  }

  /** Records a single user sighting (e.g. the submitter of a donation). */
  async touchKnownUser(user: { id: string; name: string }): Promise<void> {
    const now = new Date().toISOString()
    const known = this.#data.knownUsers.find((k) => k.id === user.id)
    if (!known) {
      this.#data.knownUsers.push({ id: user.id, name: user.name, lastSeenAt: now, archived: false })
    } else {
      known.name = user.name
      known.archived = false
      known.lastSeenAt = now
    }
    // no separate persist — callers persist via the donation write that follows
  }

  listDonations(): Donation[] {
    return [...this.#data.donations].sort(
      (a, b) => b.receivedOn.localeCompare(a.receivedOn) || b.id - a.id,
    )
  }

  async addDonation(input: DonationInput): Promise<Donation> {
    return await this.#insertDonation(input, 'confirmed', null)
  }

  /** user-submitted donation: stays pending (not counted) until an admin confirms it */
  async submitDonation(
    input: DonationInput,
    submitter: { id: string; name: string },
  ): Promise<Donation> {
    await this.touchKnownUser(submitter)
    return await this.#insertDonation(
      { ...input, userId: submitter.id },
      'pending',
      submitter.name,
    )
  }

  async #insertDonation(
    input: DonationInput,
    status: Donation['status'],
    submittedBy: string | null,
  ): Promise<Donation> {
    const id = this.#data.donations.reduce((max, d) => Math.max(max, d.id), 0) + 1
    const donation: Donation = { id, ...input, status, submittedBy }
    this.#data.donations.push(donation)
    await this.#persist()
    return donation
  }

  async confirmDonation(id: number): Promise<Donation | null> {
    const donation = this.#data.donations.find((d) => d.id === id)
    if (!donation) return null
    if (donation.status !== 'confirmed') {
      donation.status = 'confirmed'
      await this.#persist()
    }
    return donation
  }

  async updateDonation(id: number, input: DonationInput): Promise<Donation | null> {
    const index = this.#data.donations.findIndex((d) => d.id === id)
    if (index === -1) return null
    const existing = this.#data.donations[index]!
    const donation: Donation = {
      id,
      ...input,
      status: existing.status,
      submittedBy: existing.submittedBy,
    }
    this.#data.donations[index] = donation
    await this.#persist()
    return donation
  }

  async removeDonation(id: number): Promise<boolean> {
    const before = this.#data.donations.length
    this.#data.donations = this.#data.donations.filter((d) => d.id !== id)
    if (this.#data.donations.length === before) return false
    await this.#persist()
    return true
  }

  export(): CostFile {
    return { ...this.#data, exportedAt: new Date().toISOString() }
  }

  async replaceFromImport(value: unknown): Promise<CostFile> {
    const next = normalizeCostFile(value)
    const previous = this.#data
    this.#data = next
    try {
      await this.#persist()
    } catch (err) {
      this.#data = previous
      throw err
    }
    return this.export()
  }

  async #persist(): Promise<void> {
    // keep donor identities unique before anything hits the disk
    this.#reconcileDonationLinks()
    // drop icons of categories that no longer have any cost points
    const live = new Set(this.#data.costPoints.map((p) => p.category))
    for (const category of Object.keys(this.#data.categoryIcons)) {
      if (!live.has(category)) delete this.#data.categoryIcons[category]
    }
    await Deno.mkdir(dirname(this.#file), { recursive: true })
    // keep the previous state as a one-step backup before overwriting
    try {
      await Deno.copyFile(this.#file, `${this.#file}.bak`)
    } catch {
      // first write — nothing to back up yet
    }
    const tmp = `${this.#file}.tmp`
    await Deno.writeTextFile(tmp, JSON.stringify(this.export(), null, 2) + '\n')
    await Deno.rename(tmp, this.#file)
  }
}

function normalizeCostFile(value: unknown): CostFile {
  const root = record(value, 'root')
  if (root.schemaVersion !== 1) throw new Error('unsupported schemaVersion (expected 1)')

  const currency = string(root.currency, 'currency')
  const rawPoints = array(root.costPoints, 'costPoints')
  const rawDonations = root.donations === undefined ? [] : array(root.donations, 'donations')
  const rawKnownUsers = root.knownUsers === undefined ? [] : array(root.knownUsers, 'knownUsers')

  const categoryIcons: Record<string, string> = {}
  if (root.categoryIcons !== undefined) {
    const raw = record(root.categoryIcons, 'categoryIcons')
    for (const [category, icon] of Object.entries(raw)) {
      categoryIcons[category] = string(icon, `categoryIcons[${JSON.stringify(category)}]`)
    }
  }

  const costPoints = rawPoints.map((value, index): CostPoint => {
    const point = record(value, `costPoints[${index}]`)
    const cadence = string(point.cadence, `costPoints[${index}].cadence`)
    if (!['one_time', 'monthly', 'yearly', 'custom'].includes(cadence)) {
      throw new Error(`costPoints[${index}].cadence is invalid`)
    }
    // legacy migration: per-point icons become the category icon (first one wins)
    const legacyIcon = nullableString(point.icon, `costPoints[${index}].icon`)
    const category = string(point.category, `costPoints[${index}].category`)
    if (legacyIcon && categoryIcons[category] === undefined) {
      categoryIcons[category] = legacyIcon
    }
    return {
      id: integer(point.id, `costPoints[${index}].id`, 1),
      name: string(point.name, `costPoints[${index}].name`),
      category,
      costCents: integer(point.costCents, `costPoints[${index}].costCents`, 0),
      cadence: cadence as CostPoint['cadence'],
      startsOn: date(point.startsOn, `costPoints[${index}].startsOn`),
      endsOn: nullableDate(point.endsOn, `costPoints[${index}].endsOn`),
      amortizationMonths: nullableInteger(
        point.amortizationMonths,
        `costPoints[${index}].amortizationMonths`,
      ),
      intervalCount: nullableInteger(
        point.intervalCount,
        `costPoints[${index}].intervalCount`,
      ),
      intervalUnit: intervalUnit(point.intervalUnit, `costPoints[${index}].intervalUnit`),
    }
  })

  const donations = rawDonations.map((value, index): Donation => {
    const donation = record(value, `donations[${index}]`)
    const cadence = donation.cadence === undefined
      ? 'one_time'
      : string(donation.cadence, `donations[${index}].cadence`)
    if (!['one_time', 'monthly', 'yearly'].includes(cadence)) {
      throw new Error(`donations[${index}].cadence is invalid`)
    }
    const status = donation.status === undefined
      ? 'confirmed'
      : string(donation.status, `donations[${index}].status`)
    if (!['confirmed', 'pending'].includes(status)) {
      throw new Error(`donations[${index}].status is invalid`)
    }
    return {
      id: integer(donation.id, `donations[${index}].id`, 1),
      name: string(donation.name, `donations[${index}].name`),
      amountCents: integer(donation.amountCents, `donations[${index}].amountCents`, 1),
      cadence: cadence as Donation['cadence'],
      receivedOn: date(donation.receivedOn, `donations[${index}].receivedOn`),
      endsOn: nullableDate(donation.endsOn, `donations[${index}].endsOn`),
      status: status as Donation['status'],
      submittedBy: nullableString(donation.submittedBy, `donations[${index}].submittedBy`),
      userId: nullableString(donation.userId, `donations[${index}].userId`),
    }
  })

  const knownUsers = rawKnownUsers.map((value, index): KnownUser => {
    const user = record(value, `knownUsers[${index}]`)
    return {
      id: string(user.id, `knownUsers[${index}].id`),
      name: string(user.name, `knownUsers[${index}].name`),
      lastSeenAt: typeof user.lastSeenAt === 'string' ? user.lastSeenAt : new Date().toISOString(),
      archived: user.archived === true,
    }
  })
  const userIds = new Set<string>()
  for (const user of knownUsers) {
    if (userIds.has(user.id)) throw new Error(`knownUsers contains duplicate id ${user.id}`)
    userIds.add(user.id)
  }

  uniqueIds(costPoints, 'costPoints')
  uniqueIds(donations, 'donations')

  return {
    schemaVersion: 1,
    currency,
    exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : new Date().toISOString(),
    costPoints,
    donations,
    knownUsers,
    categoryIcons,
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

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be an integer >= ${minimum}`)
  }
  return value as number
}

function nullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  return string(value, path)
}

function nullableInteger(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null
  return integer(value, path, 1)
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

function intervalUnit(value: unknown, path: string): CostPoint['intervalUnit'] {
  if (value === undefined || value === null) return null
  if (!['days', 'weeks', 'months', 'years'].includes(String(value))) {
    throw new Error(`${path} is invalid`)
  }
  return value as CostPoint['intervalUnit']
}

function uniqueIds(values: Array<{ id: number }>, path: string): void {
  const ids = new Set<number>()
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${path} contains duplicate id ${value.id}`)
    ids.add(value.id)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}
