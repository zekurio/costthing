import { extname, join, normalize, resolve } from 'node:path'
import { Elysia, t } from 'elysia'
import type { CostPoint, Coverage, Donation, Me, Summary, TimelineEntry } from '../shared/types.ts'
import { amortizationElapsed, donationCentsForMonth, monthlyCents } from './calc.ts'
import { Jellyfin, type JellyfinUser, parseCookies } from './auth.ts'
import { Store } from './store.ts'

const PORT = Number(Deno.env.get('PORT') ?? 8080)
const JELLYFIN_URL = Deno.env.get('JELLYFIN_URL') ?? ''
const DATA_FILE = Deno.env.get('DATA_FILE') ??
  new URL('../data/costs.json', import.meta.url).pathname
const STATIC_DIR = Deno.env.get('STATIC_DIR') ??
  new URL('../frontend/dist', import.meta.url).pathname

if (!JELLYFIN_URL) console.warn('[config] JELLYFIN_URL unset — nobody can log in')

const jellyfin = new Jellyfin(JELLYFIN_URL || 'http://localhost:8096')
const store = await Store.load(DATA_FILE)

const costBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 200 }),
  category: t.String({ minLength: 1, maxLength: 100 }),
  icon: t.Optional(t.Nullable(t.String({ minLength: 1, maxLength: 100 }))),
  costCents: t.Integer({ minimum: 0 }),
  cadence: t.Union([
    t.Literal('one_time'),
    t.Literal('monthly'),
    t.Literal('yearly'),
    t.Literal('custom'),
  ]),
  startsOn: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  endsOn: t.Nullable(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  amortizationMonths: t.Nullable(t.Integer({ minimum: 1, maximum: 1200 })),
  intervalCount: t.Nullable(t.Integer({ minimum: 1, maximum: 100000 })),
  intervalUnit: t.Nullable(
    t.Union([t.Literal('days'), t.Literal('weeks'), t.Literal('months'), t.Literal('years')]),
  ),
})

const donationBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 200 }),
  amountCents: t.Integer({ minimum: 1 }),
  cadence: t.Union([t.Literal('one_time'), t.Literal('monthly'), t.Literal('yearly')]),
  receivedOn: t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  endsOn: t.Nullable(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  /** Jellyfin user id to link the donation to (null = external donor) */
  userId: t.Optional(t.Nullable(t.String({ minLength: 1, maxLength: 100 }))),
})

const COOKIE = 'costthing_session'

// 400 days is the maximum browsers accept; the Jellyfin token stays valid
// until it is revoked (logout or server-side), we just re-check it periodically
function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 400}`
}

/** Resolves the session cookie to a Jellyfin user (null = not logged in). */
async function currentUser(cookieHeader: string | null): Promise<JellyfinUser | null> {
  const token = parseCookies(cookieHeader)[COOKIE]
  if (!token) return null
  try {
    return await jellyfin.user(token)
  } catch {
    return null // Jellyfin unreachable — treat as logged out
  }
}

function toMe(user: JellyfinUser): Me {
  return { name: user.name, isAdmin: user.isAdmin, hasAvatar: user.avatarTag !== null }
}

const app = new Elysia()
  .get('/api/health', () => ({ ok: true }))
  .post(
    '/api/auth',
    async ({ body, set }) => {
      let session: Awaited<ReturnType<Jellyfin['authenticate']>>
      try {
        session = await jellyfin.authenticate(body.username, body.password)
      } catch {
        set.status = 502
        return { error: 'Jellyfin is unreachable' }
      }
      if (!session) {
        set.status = 401
        return { error: 'wrong username or password' }
      }
      set.headers['set-cookie'] = sessionCookie(session.token)
      return toMe(session.user)
    },
    { body: t.Object({ username: t.String({ minLength: 1 }), password: t.String() }) },
  )
  .post('/api/logout', async ({ headers, set }) => {
    const token = parseCookies(headers['cookie'] ?? null)[COOKIE]
    if (token) await jellyfin.logout(token)
    set.headers['set-cookie'] = `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
    return { ok: true }
  })
  // --- viewer area: everything below requires a valid Jellyfin session ---
  .guard(
    {
      async beforeHandle({ headers, set }) {
        if (!(await currentUser(headers['cookie'] ?? null))) {
          set.status = 401
          return { error: 'login required' }
        }
      },
    },
    (app) =>
      app
        .get('/api/me', async ({ headers }): Promise<Me> => {
          const user = (await currentUser(headers['cookie'] ?? null))!
          return toMe(user)
        })
        .get('/api/me/avatar', async ({ headers }) => {
          const user = (await currentUser(headers['cookie'] ?? null))!
          if (!user.avatarTag) return new Response(null, { status: 404 })
          return await jellyfin.avatar(user.id, user.avatarTag)
        })
        .get('/api/summary', (): Summary => {
          const now = new Date()
          const stored = store.list()
          const donations = store.listDonations()
          const points = stored.map((p) => ({
            ...p,
            monthlyCents: monthlyCents(p, now),
            amortizationElapsedMonths: amortizationElapsed(p, now),
          }))
          const totalMonthly = points.reduce((sum, p) => sum + p.monthlyCents, 0)
          const timeline = buildTimeline(stored, donations, now)
          return {
            currency: store.currency,
            generatedAt: now.toISOString(),
            totals: {
              monthlyCents: totalMonthly,
              yearlyCents: totalMonthly * 12,
              pointCount: points.length,
            },
            points,
            donations,
            categoryIcons: store.categoryIcons,
            coverage: buildCoverage(timeline, donations, now),
            timeline,
          }
        })
        // any logged-in user can report a donation for themselves — it stays
        // pending (not counted) until an admin confirms it
        .post('/api/donations/submit', async ({ headers, body, set }) => {
          const user = (await currentUser(headers['cookie'] ?? null))!
          set.status = 201
          // self-reported donations are always linked to the submitter's account
          const { userId: _ignored, ...input } = body
          return await store.submitDonation({ ...input, userId: user.id }, {
            id: user.id,
            name: user.name,
          })
        }, { body: donationBody })
        // --- admin area: Jellyfin administrators only ---
        .guard(
          {
            async beforeHandle({ headers, set }) {
              const user = await currentUser(headers['cookie'] ?? null)
              if (!user?.isAdmin) {
                set.status = 403
                return { error: 'admin required' }
              }
            },
          },
          (app) =>
            app
              // Jellyfin users, past and present: syncs the archive with the
              // live server (using the admin's own token), keeps departed
              // users as archived entries for donation attribution
              .get('/api/users', async ({ headers }) => {
                const token = parseCookies(headers['cookie'] ?? null)[COOKIE]!
                try {
                  const live = await jellyfin.users(token)
                  return await store.syncKnownUsers(live)
                } catch {
                  // Jellyfin unreachable — serve the archive as-is
                  return store.listKnownUsers()
                }
              })
              .get('/api/export', ({ set }) => {
                set.headers['content-disposition'] = `attachment; filename="cost-${
                  new Date().toISOString().slice(0, 10)
                }.json"`
                return store.export()
              })
              .post('/api/import', async ({ body, set }) => {
                try {
                  return await store.replaceFromImport(body)
                } catch (err) {
                  set.status = 400
                  return { error: err instanceof Error ? err.message : 'invalid import' }
                }
              })
              .post('/api/costs', async ({ body, set }) => {
                set.status = 201
                const { icon, ...input } = body
                return await store.add(input, icon)
              }, { body: costBody })
              .put('/api/costs/:id', async ({ params, body, set }) => {
                const { icon, ...input } = body
                const updated = await store.update(Number(params.id), input, icon)
                if (!updated) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return updated
              }, { body: costBody })
              .delete('/api/costs/:id', async ({ params, set }) => {
                if (!(await store.remove(Number(params.id)))) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return new Response(null, { status: 204 })
              })
              .post('/api/donations', async ({ body, set }) => {
                set.status = 201
                return await store.addDonation({ userId: null, ...body })
              }, { body: donationBody })
              .post('/api/donations/:id/confirm', async ({ params, set }) => {
                const confirmed = await store.confirmDonation(Number(params.id))
                if (!confirmed) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return confirmed
              })
              .put('/api/donations/:id', async ({ params, body, set }) => {
                const updated = await store.updateDonation(Number(params.id), {
                  userId: null,
                  ...body,
                })
                if (!updated) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return updated
              }, { body: donationBody })
              .delete('/api/donations/:id', async ({ params, set }) => {
                if (!(await store.removeDonation(Number(params.id)))) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return new Response(null, { status: 204 })
              }),
        ),
  )
  .get('*', ({ path }) => serveStatic(path))

Deno.serve({ port: PORT }, app.fetch)
console.log(`costthing listening on http://localhost:${PORT}`)

function donatedInMonth(donations: Donation[], month: string): number {
  return donations.reduce((sum, donation) => sum + donationCentsForMonth(donation, month), 0)
}

function buildTimeline(
  points: CostPoint[],
  donations: Donation[],
  now: Date,
): TimelineEntry[] {
  if (points.length === 0 && donations.length === 0) return []
  const earliest = [
    ...points.map((p) => p.startsOn),
    ...donations.map((d) => d.receivedOn),
  ].sort()[0]!
  const [startYear, startMonth] = earliest.split('-').map(Number)
  const cursor = new Date(Date.UTC(startYear ?? 1970, (startMonth ?? 1) - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 12, 1))

  const entries: TimelineEntry[] = []
  while (cursor <= end) {
    const y = cursor.getUTCFullYear()
    const m = cursor.getUTCMonth()
    // sample first and last day of the month, so windows starting or ending
    // mid-month still count for that month
    const first = new Date(Date.UTC(y, m, 1))
    const last = new Date(Date.UTC(y, m + 1, 0))
    const categories: Record<string, number> = {}
    let totalCents = 0
    for (const p of points) {
      const value = Math.max(monthlyCents(p, first), monthlyCents(p, last))
      if (value > 0) {
        categories[p.category] = (categories[p.category] ?? 0) + value
        totalCents += value
      }
    }
    const month = `${y}-${String(m + 1).padStart(2, '0')}`
    entries.push({ month, totalCents, donatedCents: donatedInMonth(donations, month), categories })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return entries
}

/**
 * Donations vs. cost for the current month. The cumulative balance only looks
 * at months from the first donation onward — cost history before donation
 * tracking started would otherwise swamp it as pure deficit.
 */
function buildCoverage(timeline: TimelineEntry[], donations: Donation[], now: Date): Coverage {
  const month = now.toISOString().slice(0, 7)
  const current = timeline.find((t) => t.month === month)
  const costCents = current?.totalCents ?? 0
  const donatedCents = current?.donatedCents ?? 0

  let cumulativeBalanceCents = 0
  if (donations.length > 0) {
    const firstMonth = donations.map((d) => d.receivedOn.slice(0, 7)).sort()[0]!
    for (const entry of timeline) {
      if (entry.month < firstMonth || entry.month > month) continue
      cumulativeBalanceCents += entry.donatedCents - entry.totalCents
    }
  }

  return {
    month,
    costCents,
    donatedCents,
    balanceCents: donatedCents - costCents,
    cumulativeBalanceCents,
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.([/\\]|$))+/, '')
  const file = join(STATIC_DIR, rel === '/' || rel === '.' ? 'index.html' : rel)
  if (!resolve(file).startsWith(resolve(STATIC_DIR))) {
    return new Response('forbidden', { status: 403 })
  }
  try {
    const data = await Deno.readFile(file)
    const immutable = file.includes(`${'/'}assets/`)
    return new Response(data, {
      headers: {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  } catch {
    try {
      const data = await Deno.readFile(join(STATIC_DIR, 'index.html'))
      return new Response(data, { headers: { 'content-type': MIME['.html']! } })
    } catch {
      return new Response('frontend not built — run `deno task frontend:build`', { status: 404 })
    }
  }
}
