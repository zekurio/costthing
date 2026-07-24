/** Minimal Jellyfin auth client: AuthenticateByName + a short-lived user cache. */

export interface JellyfinUser {
  id: string
  name: string
  isAdmin: boolean
  /** primary image tag — null if the user has no avatar */
  avatarTag: string | null
}

interface UserDto {
  Id: string
  Name: string
  PrimaryImageTag?: string
  Policy?: { IsAdministrator?: boolean }
}

const AUTH_HEADER =
  'MediaBrowser Client="costthing", Device="costthing", DeviceId="costthing", Version="1.0"'

/** how long a resolved token→user mapping is trusted before re-asking Jellyfin */
const CACHE_MS = 60_000

function toUser(dto: UserDto): JellyfinUser {
  return {
    id: dto.Id,
    name: dto.Name,
    isAdmin: dto.Policy?.IsAdministrator ?? false,
    avatarTag: dto.PrimaryImageTag ?? null,
  }
}

export class Jellyfin {
  #base: string
  #cache = new Map<string, { user: JellyfinUser; expires: number }>()

  constructor(baseUrl: string) {
    this.#base = baseUrl.replace(/\/+$/, '')
  }

  /** Logs in via /Users/AuthenticateByName. Returns null on wrong credentials. */
  async authenticate(
    username: string,
    password: string,
  ): Promise<{ token: string; user: JellyfinUser } | null> {
    const res = await fetch(`${this.#base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: AUTH_HEADER },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`jellyfin auth failed with status ${res.status}`)
    }
    const data = (await res.json()) as { AccessToken: string; User: UserDto }
    const user = toUser(data.User)
    this.#cache.set(data.AccessToken, { user, expires: Date.now() + CACHE_MS })
    return { token: data.AccessToken, user }
  }

  /** Resolves a session token to its user; null if the token is no longer valid. */
  async user(token: string): Promise<JellyfinUser | null> {
    const hit = this.#cache.get(token)
    if (hit && hit.expires > Date.now()) return hit.user
    const res = await fetch(`${this.#base}/Users/Me`, { headers: { 'x-emby-token': token } })
    if (!res.ok) {
      await res.body?.cancel()
      this.#cache.delete(token)
      return null
    }
    const user = toUser((await res.json()) as UserDto)
    this.#cache.set(token, { user, expires: Date.now() + CACHE_MS })
    return user
  }

  /**
   * Lists all users on the server. Requires an admin token — Jellyfin
   * restricts /Users to administrators.
   */
  async users(token: string): Promise<JellyfinUser[]> {
    const res = await fetch(`${this.#base}/Users`, { headers: { 'x-emby-token': token } })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`jellyfin user list failed with status ${res.status}`)
    }
    const dtos = (await res.json()) as UserDto[]
    return dtos.map(toUser)
  }

  /** Invalidates the session on the Jellyfin side (best effort). */
  async logout(token: string): Promise<void> {
    this.#cache.delete(token)
    try {
      const res = await fetch(`${this.#base}/Sessions/Logout`, {
        method: 'POST',
        headers: { 'x-emby-token': token },
      })
      await res.body?.cancel()
    } catch {
      // Jellyfin unreachable — the cookie is cleared either way
    }
  }

  /** Proxies the user's primary image so the browser never talks to Jellyfin directly. */
  async avatar(userId: string, tag: string): Promise<Response> {
    const res = await fetch(
      `${this.#base}/Users/${userId}/Images/Primary?tag=${encodeURIComponent(tag)}&quality=90`,
    )
    if (!res.ok) {
      await res.body?.cancel()
      return new Response(null, { status: 404 })
    }
    return new Response(res.body, {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'image/jpeg',
        'cache-control': 'private, max-age=300',
      },
    })
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}
