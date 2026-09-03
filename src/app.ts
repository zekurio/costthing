import { Type } from '@sinclair/typebox'
import { type Context, Hono, type MiddlewareHandler, type Next } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'
import {
  AuthInputSchema,
  type CostFile,
  type CostInput,
  type CostPoint,
  CostSaveInputSchema,
  type Donation,
  type DonationInput,
  DonationSaveInputSchema,
  IdParamsSchema,
  type JellyfinUser,
  type KnownUser,
  type Me,
  type Summary,
} from '../shared/types.ts'
import { amortizationElapsed, annualizedCents, monthlyCents } from './calc.ts'
import { buildCoverage, buildTimeline } from './summary.ts'
import { typeboxValidator } from './validation.ts'

const COOKIE = 'costthing_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 400

interface CurrentSession {
  token: string
  user: JellyfinUser
}

type AppEnv = {
  Variables: {
    session: CurrentSession
  }
}

interface JellyfinClient {
  authenticate(
    username: string,
    password: string,
    deviceId: string,
  ): Promise<{ token: string; user: JellyfinUser } | null>
  user(token: string): Promise<JellyfinUser | null>
  users(token: string): Promise<JellyfinUser[]>
  logout(token: string): Promise<void>
  avatar(userId: string, tag: string, token: string): Promise<Response>
}

interface AppStore {
  readonly currency: string
  readonly categoryIcons: Record<string, string>
  list(): CostPoint[]
  listDonations(): Donation[]
  listKnownUsers(): KnownUser[]
  syncKnownUsers(users: Array<{ id: string; name: string }>): Promise<KnownUser[]>
  add(input: CostInput, icon?: string | null): Promise<CostPoint>
  update(id: number, input: CostInput, icon?: string | null): Promise<CostPoint | null>
  remove(id: number): Promise<boolean>
  addDonation(input: DonationInput): Promise<Donation>
  submitDonation(
    input: DonationInput,
    submitter: { id: string; name: string },
  ): Promise<Donation>
  confirmDonation(id: number): Promise<Donation | null>
  updateDonation(id: number, input: DonationInput): Promise<Donation | null>
  removeDonation(id: number): Promise<boolean>
  export(): CostFile
  replaceFromImport(value: unknown): Promise<CostFile>
}

type StaticFileHandler = (
  pathname: string,
  accept: string,
  staticDir: string,
  acceptEncoding: string,
) => Promise<Response>

export interface AppDependencies {
  jellyfin: JellyfinClient
  store: AppStore
  staticDir: string
  serveStatic: StaticFileHandler
}

function isSecure(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return forwarded === 'https' || new URL(request.url).protocol === 'https:'
}

function cookieOptions(request: Request): CookieOptions {
  return {
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
    maxAge: SESSION_MAX_AGE,
    secure: isSecure(request),
  }
}

function sessionToken(context: Context<AppEnv>): string | null {
  const token = getCookie(context, COOKIE)
  if (!token) return null
  return token.length <= 4_096 && !/[^\x20-\x7e]/.test(token) ? token : null
}

function toMe(user: JellyfinUser): Me {
  return { name: user.name, isAdmin: user.isAdmin, hasAvatar: user.avatarTag !== null }
}

function isNamedError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}

function viewerAuthorization(jellyfin: JellyfinClient): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const token = sessionToken(context)
    if (!token) return context.json({ error: 'login required' }, 401)

    let user: JellyfinUser | null
    try {
      user = await jellyfin.user(token)
    } catch (error) {
      if (!isNamedError(error, 'JellyfinError')) throw error
      return context.json({ error: 'Jellyfin is temporarily unavailable' }, 503)
    }
    if (!user) return context.json({ error: 'login required' }, 401)
    context.set('session', { token, user })
    await next()
  }
}

async function adminAuthorization(context: Context<AppEnv>, next: Next) {
  if (!context.get('session').user.isAdmin) {
    return context.json({ error: 'admin required' }, 403)
  }
  await next()
}

function summary(store: AppStore): Summary {
  const now = new Date()
  const stored = store.list()
  const donations = store.listDonations()
  const points = stored.map((point) => ({
    ...point,
    monthlyCents: monthlyCents(point, now),
    amortizationElapsedMonths: amortizationElapsed(point, now),
  }))
  const totalMonthly = points.reduce((sum, point) => sum + point.monthlyCents, 0)
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
}

/** Builds the HTTP app without reading the environment, disk, or starting a server. */
export function createApp({ jellyfin, store, staticDir, serveStatic }: AppDependencies) {
  const admin = new Hono<AppEnv>()
    .use('*', adminAuthorization)
    .get('/users', async (context) => {
      const { token } = context.get('session')
      try {
        const live = await jellyfin.users(token)
        return context.json(await store.syncKnownUsers(live), 200)
      } catch (error) {
        if (!isNamedError(error, 'JellyfinError')) throw error
        // An outage must not erase the user archive or block the rest of the dashboard.
        return context.json(store.listKnownUsers(), 200)
      }
    })
    .get('/export', (context) => {
      context.header(
        'content-disposition',
        `attachment; filename="cost-${new Date().toISOString().slice(0, 10)}.json"`,
      )
      return context.json(store.export(), 200)
    })
    .post(
      '/import',
      typeboxValidator('json', Type.Unknown()),
      async (context) =>
        context.json(
          await store.replaceFromImport(context.req.valid('json')),
          200,
        ),
    )
    .post(
      '/costs',
      typeboxValidator('json', CostSaveInputSchema),
      async (context) => {
        const { icon, priceChanges = [], ...input } = context.req.valid('json')
        return context.json(await store.add({ ...input, priceChanges }, icon), 201)
      },
    )
    .put(
      '/costs/:id',
      typeboxValidator('param', IdParamsSchema),
      typeboxValidator('json', CostSaveInputSchema),
      async (context) => {
        const { icon, priceChanges = [], ...input } = context.req.valid('json')
        const updated = await store.update(
          context.req.valid('param').id,
          { ...input, priceChanges },
          icon,
        )
        if (!updated) return context.json({ error: 'not found' }, 404)
        return context.json(updated, 200)
      },
    )
    .delete(
      '/costs/:id',
      typeboxValidator('param', IdParamsSchema),
      async (context) => {
        const removed = await store.remove(context.req.valid('param').id)
        if (!removed) return context.json({ error: 'not found' }, 404)
        return context.body(null, 204)
      },
    )
    .post(
      '/donations',
      typeboxValidator('json', DonationSaveInputSchema),
      async (context) => {
        const { userId = null, ...input } = context.req.valid('json')
        return context.json(await store.addDonation({ ...input, userId }), 201)
      },
    )
    .post(
      '/donations/:id/confirm',
      typeboxValidator('param', IdParamsSchema),
      async (context) => {
        const confirmed = await store.confirmDonation(context.req.valid('param').id)
        if (!confirmed) return context.json({ error: 'not found' }, 404)
        return context.json(confirmed, 200)
      },
    )
    .put(
      '/donations/:id',
      typeboxValidator('param', IdParamsSchema),
      typeboxValidator('json', DonationSaveInputSchema),
      async (context) => {
        const { userId = null, ...input } = context.req.valid('json')
        const updated = await store.updateDonation(context.req.valid('param').id, {
          ...input,
          userId,
        })
        if (!updated) return context.json({ error: 'not found' }, 404)
        return context.json(updated, 200)
      },
    )
    .delete(
      '/donations/:id',
      typeboxValidator('param', IdParamsSchema),
      async (context) => {
        const removed = await store.removeDonation(context.req.valid('param').id)
        if (!removed) return context.json({ error: 'not found' }, 404)
        return context.body(null, 204)
      },
    )

  const viewer = new Hono<AppEnv>()
    .use('*', viewerAuthorization(jellyfin))
    .get('/me', (context) => context.json(toMe(context.get('session').user), 200))
    .get('/me/avatar', async (context) => {
      const { token, user } = context.get('session')
      if (!user.avatarTag) return context.body(null, 404)
      return await jellyfin.avatar(user.id, user.avatarTag, token)
    })
    .get('/summary', (context) => context.json(summary(store), 200))
    // Self-reports are always linked to the session user and stay pending.
    .post(
      '/donations/submit',
      typeboxValidator('json', DonationSaveInputSchema),
      async (context) => {
        const { user } = context.get('session')
        const { userId: _ignored, ...input } = context.req.valid('json')
        const donation = await store.submitDonation({ ...input, userId: user.id }, {
          id: user.id,
          name: user.name,
        })
        return context.json(donation, 201)
      },
    )
    .route('/', admin)

  const api = new Hono<AppEnv>()
    .get('/health', (context) => context.json({ ok: true } as const, 200))
    .post(
      '/auth',
      typeboxValidator('json', AuthInputSchema),
      async (context) => {
        const { username, password, deviceId } = context.req.valid('json')
        let session: Awaited<ReturnType<JellyfinClient['authenticate']>>
        try {
          session = await jellyfin.authenticate(username, password, deviceId)
        } catch {
          return context.json({ error: 'Jellyfin is unreachable' }, 502)
        }
        if (!session) return context.json({ error: 'wrong username or password' }, 401)
        setCookie(context, COOKIE, session.token, cookieOptions(context.req.raw))
        return context.json(toMe(session.user), 200)
      },
    )
    .post('/logout', (context) => {
      const token = sessionToken(context)
      deleteCookie(context, COOKIE, cookieOptions(context.req.raw))
      if (token) void jellyfin.logout(token)
      return context.json({ ok: true } as const, 200)
    })
    .route('/', viewer)

  const app = new Hono<AppEnv>()
    .route('/api', api)
    .all('/api', (context) => context.json({ error: 'not found' }, 404))
    .all('/api/*', (context) => context.json({ error: 'not found' }, 404))
    .get('*', (context) =>
      serveStatic(
        context.req.path,
        context.req.header('accept') ?? '',
        staticDir,
        context.req.header('accept-encoding') ?? '',
      ))

  app.onError((error, context) => {
    if (isNamedError(error, 'StoreValidationError')) {
      return context.json({ error: error.message }, 400)
    }
    console.error('[http] unhandled request error', error)
    return context.json({ error: 'internal server error' }, 500)
  })

  return app
}

export type AppType = ReturnType<typeof createApp>
