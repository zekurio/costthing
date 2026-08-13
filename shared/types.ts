export type Cadence = 'one_time' | 'monthly' | 'yearly' | 'custom'
export type DonationCadence = 'one_time' | 'monthly' | 'yearly'
export type DonationStatus = 'confirmed' | 'pending'
export type IntervalUnit = 'days' | 'weeks' | 'months' | 'years'

export interface PriceChange {
  /** ISO date, YYYY-MM-DD — the new amount counts for the whole calendar month of this date */
  startsOn: string
  costCents: number
}

export interface CostPoint {
  id: number
  name: string
  category: string
  /** amount that counts from startsOn until the first price change */
  costCents: number
  /**
   * Later amounts, sorted by startsOn with unique calendar months: each counts
   * from its month until the next change (or endsOn). Empty = the price never
   * changes. Not valid for one_time costs — a single payment has no history.
   */
  priceChanges: PriceChange[]
  cadence: Cadence
  /** ISO date, YYYY-MM-DD */
  startsOn: string
  /** ISO date — cancelled services keep their history but stop counting after this month */
  endsOn: string | null
  /** one_time only: spread over this many calendar months, starting with startsOn's month */
  amortizationMonths: number | null
  /** custom cadence: every <intervalCount> <intervalUnit> */
  intervalCount: number | null
  intervalUnit: IntervalUnit | null
}

export type CostInput = Omit<CostPoint, 'id'>

/**
 * Cost save payload: optionally (re)assigns the category's icon.
 * undefined = leave the category icon untouched, null = clear it.
 */
export type CostSaveInput = CostInput & { icon?: string | null }

export interface Donation {
  id: number
  /** label, e.g. donor name or source — shown publicly */
  name: string
  amountCents: number
  /** one-off or repeating donation */
  cadence: DonationCadence
  /** ISO date, YYYY-MM-DD — the receipt date or first occurrence */
  receivedOn: string
  /** recurring only: counts through the month containing this date */
  endsOn: string | null
  /** pending = submitted by a user, waiting for admin confirmation; doesn't count yet */
  status: DonationStatus
  /** Jellyfin username of the submitter, null if added by an admin */
  submittedBy: string | null
  /** Jellyfin user id this donation belongs to, null = external/unlinked donor */
  userId: string | null
}

export type DonationInput = Omit<Donation, 'id' | 'status' | 'submittedBy'>

/**
 * A Jellyfin user seen at least once by this app. Kept forever — even after
 * the account is deleted on the server (archived) — so old donations stay
 * attributable and future donations from returning donors map to the same id.
 */
export interface KnownUser {
  /** Jellyfin user id */
  id: string
  name: string
  /** ISO timestamp of the last time this user was seen on the Jellyfin server */
  lastSeenAt: string
  /** true once the account no longer exists on the Jellyfin server */
  archived: boolean
}

export interface CostFile {
  schemaVersion: 1
  currency: string
  exportedAt: string
  costPoints: CostPoint[]
  donations: Donation[]
  /** Jellyfin users ever seen — archival, survives account deletion */
  knownUsers: KnownUser[]
  /** category name → lucide icon name (curated set in the frontend) */
  categoryIcons: Record<string, string>
}

export interface SummaryPoint extends CostPoint {
  /** effective cost per month right now, in cents */
  monthlyCents: number
  /** one_time + amortized only: how many months of the window have passed */
  amortizationElapsedMonths: number | null
}

export interface TimelineEntry {
  /** YYYY-MM */
  month: string
  totalCents: number
  /** donations received that month */
  donatedCents: number
  /** category name → cents that month */
  categories: Record<string, number>
}

export interface Coverage {
  /** current month, YYYY-MM */
  month: string
  costCents: number
  donatedCents: number
  /** donatedCents - costCents: positive = surplus */
  balanceCents: number
  /** running balance from the first donation month through the current month */
  cumulativeBalanceCents: number
}

/** the logged-in Jellyfin user, as exposed to the frontend */
export interface Me {
  name: string
  isAdmin: boolean
  /** true if /api/me/avatar will return an image */
  hasAvatar: boolean
}

export interface Summary {
  currency: string
  generatedAt: string
  totals: {
    monthlyCents: number
    yearlyCents: number
    pointCount: number
  }
  points: SummaryPoint[]
  donations: Donation[]
  /** category name → lucide icon name */
  categoryIcons: Record<string, string>
  /** donations vs. cost for the current month (+ cumulative balance) */
  coverage: Coverage
  /** effective monthly cost per month: earliest cost → 12 months ahead */
  timeline: TimelineEntry[]
}
