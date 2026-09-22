import { type Static, Type } from '@sinclair/typebox'

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER

export const DateStringSchema = Type.String({ pattern: DATE_PATTERN })
export const NullableDateSchema = Type.Union([DateStringSchema, Type.Null()])
export const MonthStringSchema = Type.String({ pattern: '^\\d{4}-\\d{2}$' })

export const CadenceSchema = Type.Union([
  Type.Literal('one_time'),
  Type.Literal('monthly'),
  Type.Literal('yearly'),
  Type.Literal('custom'),
])
export type Cadence = Static<typeof CadenceSchema>

export const IntervalUnitSchema = Type.Union([
  Type.Literal('days'),
  Type.Literal('weeks'),
  Type.Literal('months'),
  Type.Literal('years'),
])
export type IntervalUnit = Static<typeof IntervalUnitSchema>

export const PriceChangeSchema = Type.Object({
  /** ISO date, YYYY-MM-DD; the new amount counts for the whole calendar month of this date. */
  startsOn: DateStringSchema,
  costCents: Type.Integer({ minimum: 0, maximum: SAFE_INTEGER }),
}, { additionalProperties: false })
export type PriceChange = Static<typeof PriceChangeSchema>

export const CostPointSchema = Type.Object({
  id: Type.Integer({ minimum: 1, maximum: SAFE_INTEGER }),
  name: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1 }),
  /** Amount that counts from startsOn until the first price change. */
  costCents: Type.Integer({ minimum: 0, maximum: SAFE_INTEGER }),
  /** Later amounts, sorted by startsOn with unique calendar months. */
  priceChanges: Type.Array(PriceChangeSchema),
  cadence: CadenceSchema,
  startsOn: DateStringSchema,
  /** Cancelled services keep their history but stop counting after this month. */
  endsOn: NullableDateSchema,
  /** one_time only: spread over this many calendar months, starting with startsOn's month. */
  amortizationMonths: Type.Union([
    Type.Integer({ minimum: 1, maximum: 1200 }),
    Type.Null(),
  ]),
  /** custom cadence: every intervalCount intervalUnit. */
  intervalCount: Type.Union([
    Type.Integer({ minimum: 1, maximum: 100_000 }),
    Type.Null(),
  ]),
  intervalUnit: Type.Union([IntervalUnitSchema, Type.Null()]),
}, { additionalProperties: false })
export type CostPoint = Static<typeof CostPointSchema>

export const CostInputSchema = Type.Omit(CostPointSchema, ['id'])
export type CostInput = Static<typeof CostInputSchema>

/**
 * Cost save payload: optionally (re)assigns the category's icon.
 * undefined = leave the category icon untouched, null = clear it.
 * priceChanges is optional on the wire for compatibility with older clients.
 */
export const CostSaveInputSchema = Type.Object({
  ...CostInputSchema.properties,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  category: Type.String({ minLength: 1, maxLength: 100 }),
  priceChanges: Type.Optional(CostInputSchema.properties.priceChanges),
  icon: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 100 }),
    Type.Null(),
  ])),
}, { additionalProperties: false })
export type CostSaveInput = Static<typeof CostSaveInputSchema>

/**
 * Money received, booked manually for one calendar month. The pot model keeps
 * no per-donor books: an entry is just amount, month and an optional note.
 */
export const IncomeEntrySchema = Type.Object({
  id: Type.Integer({ minimum: 1, maximum: SAFE_INTEGER }),
  /** Booked month, YYYY-MM: the month this income belongs to. */
  month: MonthStringSchema,
  amountCents: Type.Integer({ minimum: 1, maximum: SAFE_INTEGER }),
  /** Optional free-text note, for example what the income was. */
  note: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false })
export type IncomeEntry = Static<typeof IncomeEntrySchema>

export const IncomeInputSchema = Type.Omit(IncomeEntrySchema, ['id'])
export type IncomeInput = Static<typeof IncomeInputSchema>

/** The wire payload accepts clients that omit note and caps its length. */
export const IncomeSaveInputSchema = Type.Object({
  ...IncomeInputSchema.properties,
  note: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 500 }),
    Type.Null(),
  ])),
}, { additionalProperties: false })
export type IncomeSaveInput = Static<typeof IncomeSaveInputSchema>

export const CostFileSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  currency: Type.String({ minLength: 1 }),
  exportedAt: Type.String({ minLength: 1 }),
  costPoints: Type.Array(CostPointSchema),
  income: Type.Array(IncomeEntrySchema),
  /** Category name to a persisted lucide icon name. */
  categoryIcons: Type.Record(Type.String(), Type.String({ minLength: 1 })),
}, { additionalProperties: false })
export type CostFile = Static<typeof CostFileSchema>

export const SummaryPointSchema = Type.Object({
  ...CostPointSchema.properties,
  /** Effective cost per month right now, in cents. */
  monthlyCents: Type.Number(),
  /** one_time and amortized only: how many months of the window have passed. */
  amortizationElapsedMonths: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false })
export type SummaryPoint = Static<typeof SummaryPointSchema>

export const TimelineEntrySchema = Type.Object({
  /** YYYY-MM */
  month: MonthStringSchema,
  totalCents: Type.Number(),
  /** Income booked for that month. */
  incomeCents: Type.Number(),
  /** Category name to cents that month. */
  categories: Type.Record(Type.String(), Type.Number()),
}, { additionalProperties: false })
export type TimelineEntry = Static<typeof TimelineEntrySchema>

export const CoverageSchema = Type.Object({
  /** Current month, YYYY-MM. */
  month: MonthStringSchema,
  /** Cost of the current month, in cents. */
  costCents: Type.Number(),
  /** Income booked for the current month, in cents. */
  incomeCents: Type.Number(),
  /** incomeCents - costCents for the current month. */
  balanceCents: Type.Number(),
  /** Income booked through the current month: what came in until now. */
  totalIncomeCents: Type.Number(),
  /** Cost accumulated since the first income month through the current month. */
  totalCostCents: Type.Number(),
  /** totalIncomeCents - totalCostCents: >= 0 means the pot is break even. */
  totalBalanceCents: Type.Number(),
}, { additionalProperties: false })
export type Coverage = Static<typeof CoverageSchema>

export const JellyfinUserSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  isAdmin: Type.Boolean(),
  /** Primary image tag, null if the user has no avatar. */
  avatarTag: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false })
export type JellyfinUser = Static<typeof JellyfinUserSchema>

/** The logged-in Jellyfin user exposed to the frontend. */
export const MeSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  isAdmin: Type.Boolean(),
  /** True if /api/me/avatar will return an image. */
  hasAvatar: Type.Boolean(),
}, { additionalProperties: false })
export type Me = Static<typeof MeSchema>

export const SummarySchema = Type.Object({
  currency: Type.String({ minLength: 1 }),
  generatedAt: Type.String({ minLength: 1 }),
  totals: Type.Object({
    monthlyCents: Type.Number(),
    yearlyCents: Type.Number(),
    pointCount: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  points: Type.Array(SummaryPointSchema),
  income: Type.Array(IncomeEntrySchema),
  categoryIcons: Type.Record(Type.String(), Type.String()),
  coverage: CoverageSchema,
  timeline: Type.Array(TimelineEntrySchema),
}, { additionalProperties: false })
export type Summary = Static<typeof SummarySchema>

export const AuthInputSchema = Type.Object({
  username: Type.String({ minLength: 1 }),
  password: Type.String(),
  deviceId: Type.String({
    minLength: 16,
    maxLength: 100,
    pattern: '^[A-Za-z0-9-]+$',
  }),
}, { additionalProperties: false })
export type AuthInput = Static<typeof AuthInputSchema>

export const IdParamsSchema = Type.Object({
  id: Type.Transform(Type.String({ minLength: 1 }))
    .Decode((value) => {
      const id = Number(value)
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('invalid id')
      return id
    })
    .Encode((value) => String(value)),
}, { additionalProperties: false })
