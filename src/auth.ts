import { Type } from '@sinclair/typebox'
import type { JellyfinUser } from '../shared/types.ts'
import { decode } from './validation.ts'

export type { JellyfinUser } from '../shared/types.ts'

/** Minimal Jellyfin auth client with bounded requests and a short-lived user cache. */

const JellyfinUserResponseSchema = Type.Object({
  Id: Type.String({ minLength: 1 }),
  Name: Type.String({ minLength: 1 }),
  PrimaryImageTag: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  Policy: Type.Optional(Type.Union([
    Type.Object({
      IsAdministrator: Type.Optional(Type.Boolean()),
    }, { additionalProperties: true }),
    Type.Null(),
  ])),
}, { additionalProperties: true })

const AuthenticationResponseSchema = Type.Object({
  AccessToken: Type.String({ minLength: 1 }),
  User: JellyfinUserResponseSchema,
}, { additionalProperties: true })

const UsersResponseSchema = Type.Array(JellyfinUserResponseSchema)

export type JellyfinFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface JellyfinOptions {
  fetch?: JellyfinFetch
  timeoutMs?: number
  cacheTtlMs?: number
  maxCacheEntries?: number
  now?: () => number
}

export type JellyfinErrorKind = 'network' | 'timeout' | 'upstream' | 'malformed-response'

/** A Jellyfin failure that is not an expected invalid credential/session response. */
export class JellyfinError extends Error {
  readonly kind: JellyfinErrorKind
  readonly status: number | null

  constructor(
    message: string,
    options: { kind: JellyfinErrorKind; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'JellyfinError'
    this.kind = options.kind
    this.status = options.status ?? null
  }
}

const CLIENT = 'costthing'
const DEVICE = 'costthing'
const VERSION = '1.0'
const DEFAULT_TIMEOUT_MS = 10_000
/** how long a resolved token→user mapping is trusted before re-asking Jellyfin */
const DEFAULT_CACHE_TTL_MS = 60_000
const DEFAULT_MAX_CACHE_ENTRIES = 1_000

function quotedHeaderValue(name: string, value: string): string {
  // HTTP field values cannot contain controls; escaping quotes also keeps the MediaBrowser grammar.
  if (!value || value.length > 4_096 || /[^\x20-\x7e]/.test(value)) {
    throw new TypeError(`invalid ${name} header value`)
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function mediaBrowserAuthorization(parts: ReadonlyArray<readonly [string, string]>): string {
  return `MediaBrowser ${
    parts.map(([name, value]) => `${name}=${quotedHeaderValue(name, value)}`).join(', ')
  }`
}

function deviceAuthorization(deviceId: string): string {
  return mediaBrowserAuthorization([
    ['Client', CLIENT],
    ['Device', DEVICE],
    ['DeviceId', deviceId],
    ['Version', VERSION],
  ])
}

function tokenAuthorization(token: string): string {
  return mediaBrowserAuthorization([['Token', token]])
}

function parseUser(value: unknown): JellyfinUser {
  const user = decode(JellyfinUserResponseSchema, value)
  return {
    id: user.Id,
    name: user.Name,
    isAdmin: user.Policy?.IsAdministrator ?? false,
    avatarTag: user.PrimaryImageTag ?? null,
  }
}

function parseAuthentication(value: unknown): { token: string; user: JellyfinUser } {
  const session = decode(AuthenticationResponseSchema, value)
  return { token: session.AccessToken, user: parseUser(session.User) }
}

function parseUsers(value: unknown): JellyfinUser[] {
  return decode(UsersResponseSchema, value).map(parseUser)
}

export class Jellyfin {
  #base: string
  #fetcher: JellyfinFetch
  #timeoutMs: number
  #cacheTtlMs: number
  #maxCacheEntries: number
  #now: () => number
  #cache = new Map<string, { user: JellyfinUser; expires: number }>()
  #pendingUsers = new Map<string, Promise<JellyfinUser | null>>()
  #revokedTokens = new Set<string>()

  constructor(baseUrl: string, options: JellyfinOptions = {}) {
    this.#base = baseUrl.replace(/\/+$/, '')
    this.#fetcher = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.#maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES
    this.#now = options.now ?? Date.now

    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be positive')
    }
    if (!Number.isFinite(this.#cacheTtlMs) || this.#cacheTtlMs < 0) {
      throw new RangeError('cacheTtlMs must not be negative')
    }
    if (!Number.isInteger(this.#maxCacheEntries) || this.#maxCacheEntries <= 0) {
      throw new RangeError('maxCacheEntries must be a positive integer')
    }
  }

  /** Logs in via /Users/AuthenticateByName. Returns null on wrong credentials. */
  async authenticate(
    username: string,
    password: string,
    deviceId: string,
  ): Promise<{ token: string; user: JellyfinUser } | null> {
    const res = await this.#request('/Users/AuthenticateByName', 'authentication', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: deviceAuthorization(deviceId),
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) await this.#throwForStatus(res, 'authentication')

    const session = await this.#readJson(res, 'authentication', parseAuthentication)
    this.#revokedTokens.delete(session.token)
    this.#cacheUser(session.token, session.user)
    return session
  }

  /** Resolves a session token to its user; null only if the token is no longer valid. */
  user(token: string): Promise<JellyfinUser | null> {
    if (this.#revokedTokens.has(token)) return Promise.resolve(null)
    const now = this.#now()
    const hit = this.#cache.get(token)
    if (hit && hit.expires > now) return Promise.resolve(hit.user)

    this.#pruneCache(now)
    const pending = this.#pendingUsers.get(token)
    if (pending) return pending

    const request = this.#loadUser(token)
    this.#pendingUsers.set(token, request)
    const clearPending = () => {
      if (this.#pendingUsers.get(token) === request) this.#pendingUsers.delete(token)
    }
    void request.then(clearPending, clearPending)
    return request
  }

  /**
   * Lists all users on the server. Requires an admin token — Jellyfin
   * restricts /Users to administrators.
   */
  async users(token: string): Promise<JellyfinUser[]> {
    const res = await this.#request('/Users', 'user list', {
      headers: { authorization: tokenAuthorization(token) },
    })
    if (!res.ok) await this.#throwForStatus(res, 'user list')
    return await this.#readJson(res, 'user list', parseUsers)
  }

  /** Invalidates the session on the Jellyfin side (best effort). */
  async logout(token: string): Promise<void> {
    this.#cache.delete(token)
    this.#pendingUsers.delete(token)
    this.#revokedTokens.add(token)
    while (this.#revokedTokens.size > this.#maxCacheEntries) {
      const oldest = this.#revokedTokens.values().next().value
      if (oldest === undefined) break
      this.#revokedTokens.delete(oldest)
    }
    try {
      const res = await this.#request('/Sessions/Logout', 'logout', {
        method: 'POST',
        headers: { authorization: tokenAuthorization(token) },
      })
      await res.body?.cancel()
    } catch {
      // Jellyfin unreachable — the browser cookie is cleared either way.
    }
  }

  /** Proxies the user's primary image so the browser never talks to Jellyfin directly. */
  async avatar(userId: string, tag: string, token: string): Promise<Response> {
    const res = await this.#request(
      `/Users/${encodeURIComponent(userId)}/Images/Primary?tag=${
        encodeURIComponent(tag)
      }&quality=90`,
      'avatar',
      { headers: { authorization: tokenAuthorization(token) } },
    )
    if (res.status === 404) {
      await res.body?.cancel()
      return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
    }
    if (!res.ok) await this.#throwForStatus(res, 'avatar')
    const body = await this.#readBody(res, 'avatar', () => res.arrayBuffer())
    return new Response(body, {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'image/jpeg',
        'cache-control': 'no-store',
      },
    })
  }

  async #loadUser(token: string): Promise<JellyfinUser | null> {
    const res = await this.#request('/Users/Me', 'session validation', {
      headers: { authorization: tokenAuthorization(token) },
    })
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel()
      this.#cache.delete(token)
      return null
    }
    if (!res.ok) await this.#throwForStatus(res, 'session validation')

    const user = await this.#readJson(res, 'session validation', parseUser)
    if (this.#revokedTokens.has(token)) return null
    this.#cacheUser(token, user)
    return user
  }

  async #request(path: string, operation: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(
          new JellyfinError(`jellyfin ${operation} timed out`, {
            kind: 'timeout',
          }),
        )
      }, this.#timeoutMs)
    })

    try {
      return await Promise.race([
        this.#fetcher(`${this.#base}${path}`, { ...init, signal: controller.signal }),
        timeout,
      ])
    } catch (cause) {
      if (cause instanceof JellyfinError) throw cause
      if (timedOut) {
        throw new JellyfinError(`jellyfin ${operation} timed out`, {
          kind: 'timeout',
          cause,
        })
      }
      throw new JellyfinError(`jellyfin ${operation} request failed`, {
        kind: 'network',
        cause,
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async #throwForStatus(response: Response, operation: string): Promise<never> {
    const status = response.status
    await response.body?.cancel()
    throw new JellyfinError(`jellyfin ${operation} failed with status ${status}`, {
      kind: 'upstream',
      status,
    })
  }

  async #readJson<T>(
    response: Response,
    operation: string,
    parse: (value: unknown) => T,
  ): Promise<T> {
    try {
      const value = await this.#readBody(response, operation, () => response.json())
      return parse(value)
    } catch (cause) {
      if (cause instanceof JellyfinError) throw cause
      throw new JellyfinError(`jellyfin ${operation} returned a malformed response`, {
        kind: 'malformed-response',
        cause,
      })
    }
  }

  async #readBody<T>(
    response: Response,
    operation: string,
    read: () => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void response.body?.cancel().catch(() => {})
        reject(new JellyfinError(`jellyfin ${operation} timed out`, { kind: 'timeout' }))
      }, this.#timeoutMs)
    })
    try {
      return await Promise.race([read(), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #cacheUser(token: string, user: JellyfinUser): void {
    const now = this.#now()
    this.#pruneCache(now)
    // Re-insertion makes the bounded map evict the least recently cached token first.
    this.#cache.delete(token)
    this.#cache.set(token, { user, expires: now + this.#cacheTtlMs })
    while (this.#cache.size > this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value
      if (oldest === undefined) break
      this.#cache.delete(oldest)
    }
  }

  #pruneCache(now: number): void {
    for (const [token, entry] of this.#cache) {
      if (entry.expires <= now) this.#cache.delete(token)
    }
  }
}
