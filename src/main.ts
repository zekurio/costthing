import { Elysia, t } from 'elysia'
import type { Me, Summary } from '../shared/types.ts'
import { Jellyfin, JellyfinError, type JellyfinUser, parseCookies } from './auth.ts'
import { amortizationElapsed, annualizedCents, monthlyCents } from './calc.ts'
import { Store, StoreValidationError } from './store.ts'
import { buildCoverage, buildTimeline } from './summary.ts'
import { serveStatic } from './static.ts'

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

function isSecure(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return forwarded === 'https' || new URL(request.url).protocol === 'https:'
}

// 400 days is the maximum browsers accept; Jellyfin tokens remain valid until revoked.
function sessionCookie(token: string, secure: boolean): string {
  const flags = secure ? '; Secure' : ''
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${
    60 * 60 * 24 * 400
  }${flags}`
}

function clearSessionCookie(secure: boolean): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

interface CurrentSession {
  token: string
  user: JellyfinUser
}

const requestSessions = new WeakMap<Request, Promise<CurrentSession | null>>()

function sessionToken(request: Request): string | null {
  const encoded = parseCookies(request.headers.get('cookie'))[COOKIE]
  if (!encoded) return null
  try {
    const token = decodeURIComponent(encoded)
    return token.length <= 4_096 && !/[^\x20-\x7e]/.test(token) ? token : null
  } catch {
    return null
  }
}

/** Resolves a request once so nested guards and handlers share one upstream lookup. */
function currentSession(request: Request): Promise<CurrentSession | null> {
  const cached = requestSessions.get(request)
  if (cached) return cached
  const pending = (async () => {
    const token = sessionToken(request)
    if (!token) return null
    const user = await jellyfin.user(token)
    return user ? { token, user } : null
  })()
  requestSessions.set(request, pending)
  return pending
}

function toMe(user: JellyfinUser): Me {
  return { name: user.name, isAdmin: user.isAdmin, hasAvatar: user.avatarTag !== null }
}

async function storeCall<T>(action: () => Promise<T>): Promise<T | Response> {
  try {
    return await action()
  } catch (err) {
    if (!(err instanceof StoreValidationError)) throw err
    return Response.json({ error: err.message }, { status: 400 })
  }
}

const app = new Elysia()
  .get('/api/health', () => ({ ok: true }))
  .post(
    '/api/auth',
    async ({ body, request, set }) => {
      let session: Awaited<ReturnType<Jellyfin['authenticate']>>
      try {
        session = await jellyfin.authenticate(body.username, body.password, body.deviceId)
      } catch {
        set.status = 502
        return { error: 'Jellyfin is unreachable' }
      }
      if (!session) {
        set.status = 401
        return { error: 'wrong username or password' }
      }
      set.headers['set-cookie'] = sessionCookie(session.token, isSecure(request))
      return toMe(session.user)
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1 }),
        password: t.String(),
        deviceId: t.String({
          minLength: 16,
          maxLength: 100,
          pattern: '^[A-Za-z0-9-]+$',
        }),
      }),
    },
  )
  .post('/api/logout', ({ request, set }) => {
    const token = sessionToken(request)
    set.headers['set-cookie'] = clearSessionCookie(isSecure(request))
    if (token) void jellyfin.logout(token)
    return { ok: true }
  })
  // --- viewer area: everything below requires a valid Jellyfin session ---
  .guard(
    {
      async beforeHandle({ request, set }) {
        try {
          if (!(await currentSession(request))) {
            set.status = 401
            return { error: 'login required' }
          }
        } catch (err) {
          if (!(err instanceof JellyfinError)) throw err
          set.status = 503
          return { error: 'Jellyfin is temporarily unavailable' }
        }
      },
    },
    (app) =>
      app
        .get('/api/me', async ({ request }): Promise<Me> => {
          const { user } = (await currentSession(request))!
          return toMe(user)
        })
        .get('/api/me/avatar', async ({ request }) => {
          const { token, user } = (await currentSession(request))!
          if (!user.avatarTag) return new Response(null, { status: 404 })
          return await jellyfin.avatar(user.id, user.avatarTag, token)
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
              yearlyCents: stored.reduce((sum, point) => sum + annualizedCents(point, now), 0),
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
        .post('/api/donations/submit', async ({ request, body, set }) => {
          const { user } = (await currentSession(request))!
          // self-reported donations are always linked to the submitter's account
          const { userId: _ignored, ...input } = body
          const result = await storeCall(() =>
            store.submitDonation({ ...input, userId: user.id }, {
              id: user.id,
              name: user.name,
            })
          )
          if (!(result instanceof Response)) set.status = 201
          return result
        }, { body: donationBody })
        // --- admin area: Jellyfin administrators only ---
        .guard(
          {
            async beforeHandle({ request, set }) {
              const session = await currentSession(request)
              if (!session?.user.isAdmin) {
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
              .get('/api/users', async ({ request }) => {
                const { token } = (await currentSession(request))!
                try {
                  const live = await jellyfin.users(token)
                  return await store.syncKnownUsers(live)
                } catch (err) {
                  if (!(err instanceof JellyfinError)) throw err
                  // Jellyfin unreachable — serve the archive as-is.
                  return store.listKnownUsers()
                }
              })
              .get('/api/export', ({ set }) => {
                set.headers['content-disposition'] = `attachment; filename="cost-${
                  new Date().toISOString().slice(0, 10)
                }.json"`
                return store.export()
              })
              .post(
                '/api/import',
                async ({ body }) => await storeCall(() => store.replaceFromImport(body)),
              )
              .post('/api/costs', async ({ body, set }) => {
                const { icon, ...input } = body
                const result = await storeCall(() => store.add(input, icon))
                if (!(result instanceof Response)) set.status = 201
                return result
              }, { body: costBody })
              .put('/api/costs/:id', async ({ params, body, set }) => {
                const { icon, ...input } = body
                const updated = await storeCall(() => store.update(Number(params.id), input, icon))
                if (updated instanceof Response) return updated
                if (!updated) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return updated
              }, { body: costBody })
              .delete('/api/costs/:id', async ({ params, set }) => {
                const removed = await storeCall(() => store.remove(Number(params.id)))
                if (removed instanceof Response) return removed
                if (!removed) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return new Response(null, { status: 204 })
              })
              .post('/api/donations', async ({ body, set }) => {
                const result = await storeCall(() => store.addDonation({ userId: null, ...body }))
                if (!(result instanceof Response)) set.status = 201
                return result
              }, { body: donationBody })
              .post('/api/donations/:id/confirm', async ({ params, set }) => {
                const confirmed = await storeCall(() => store.confirmDonation(Number(params.id)))
                if (confirmed instanceof Response) return confirmed
                if (!confirmed) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return confirmed
              })
              .put('/api/donations/:id', async ({ params, body, set }) => {
                const updated = await storeCall(() =>
                  store.updateDonation(Number(params.id), {
                    userId: null,
                    ...body,
                  })
                )
                if (updated instanceof Response) return updated
                if (!updated) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return updated
              }, { body: donationBody })
              .delete('/api/donations/:id', async ({ params, set }) => {
                const removed = await storeCall(() => store.removeDonation(Number(params.id)))
                if (removed instanceof Response) return removed
                if (!removed) {
                  set.status = 404
                  return { error: 'not found' }
                }
                return new Response(null, { status: 204 })
              }),
        ),
  )
  .get('/api', ({ set }) => {
    set.status = 404
    return { error: 'not found' }
  })
  .get('/api/*', ({ set }) => {
    set.status = 404
    return { error: 'not found' }
  })
  .get(
    '*',
    ({ path, request }) =>
      serveStatic(
        path,
        request.headers.get('accept') ?? '',
        STATIC_DIR,
        request.headers.get('accept-encoding') ?? '',
      ),
  )

Deno.serve({ port: PORT }, app.fetch)
console.log(`costthing listening on http://localhost:${PORT}`)
