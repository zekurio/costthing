import { strict as assert } from 'node:assert'
import { Jellyfin, JellyfinError, type JellyfinErrorKind, type JellyfinFetch } from './auth.ts'

interface FetchCall {
  url: string
  init: RequestInit
}

type FetchResult = Response | Error | (() => Response | Promise<Response>)

function fakeFetch(results: FetchResult[]): { fetch: JellyfinFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetch: JellyfinFetch = (input, init = {}) => {
    calls.push({ url: String(input), init })
    const result = results.shift()
    if (result === undefined) throw new Error('unexpected fetch')
    if (result instanceof Error) return Promise.reject(result)
    if (typeof result === 'function') return Promise.resolve(result())
    return Promise.resolve(result)
  }
  return { fetch, calls }
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function userDto(
  id = 'user-1',
  name = 'Alice',
  isAdmin = true,
  avatarTag: string | null = 'avatar-tag',
): Record<string, unknown> {
  return {
    Id: id,
    Name: name,
    Policy: { IsAdministrator: isAdmin },
    PrimaryImageTag: avatarTag,
  }
}

function headers(call: FetchCall): Headers {
  return new Headers(call.init.headers)
}

async function expectJellyfinError(
  promise: Promise<unknown>,
  kind: JellyfinErrorKind,
  status: number | null = null,
): Promise<JellyfinError> {
  try {
    await promise
    assert.fail('expected JellyfinError')
  } catch (error) {
    assert.ok(error instanceof JellyfinError)
    assert.equal(error.kind, kind)
    assert.equal(error.status, status)
    return error
  }
}

Deno.test('authenticate uses the caller device id and caches the returned session', async () => {
  const transport = fakeFetch([
    json({ AccessToken: 'session-token', User: userDto() }),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example///', { fetch: transport.fetch })

  const session = await jellyfin.authenticate('alice', 'secret', 'browser-f47ac10b')

  assert.deepEqual(session, {
    token: 'session-token',
    user: {
      id: 'user-1',
      name: 'Alice',
      isAdmin: true,
      avatarTag: 'avatar-tag',
    },
  })
  assert.equal(transport.calls.length, 1)
  const call = transport.calls[0]!
  assert.equal(call.url, 'https://jellyfin.example/Users/AuthenticateByName')
  assert.equal(call.init.method, 'POST')
  assert.equal(headers(call).get('content-type'), 'application/json')
  assert.equal(
    headers(call).get('authorization'),
    'MediaBrowser Client="costthing", Device="costthing", DeviceId="browser-f47ac10b", Version="1.0"',
  )
  assert.equal(headers(call).has('x-emby-token'), false)
  assert.deepEqual(JSON.parse(String(call.init.body)), { Username: 'alice', Pw: 'secret' })

  assert.deepEqual(await jellyfin.user('session-token'), session?.user)
  assert.equal(transport.calls.length, 1)
})

Deno.test('MediaBrowser headers reject controls and safely quote visible values', async () => {
  const transport = fakeFetch([json(userDto())])
  const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })

  await assert.rejects(
    () => jellyfin.authenticate('alice', 'secret', 'browser\r\ninjected'),
    TypeError,
  )
  assert.equal(transport.calls.length, 0)

  await jellyfin.user('token"\\part')
  assert.equal(
    headers(transport.calls[0]!).get('authorization'),
    'MediaBrowser Token="token\\"\\\\part"',
  )
})

Deno.test('authenticate returns null for rejected credentials but types upstream failures', async () => {
  for (const status of [401, 403]) {
    const transport = fakeFetch([new Response(null, { status })])
    const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })
    assert.equal(await jellyfin.authenticate('alice', 'wrong', `browser-${status}`), null)
  }

  const upstream = fakeFetch([new Response(null, { status: 500 })])
  await expectJellyfinError(
    new Jellyfin('https://jellyfin.example', { fetch: upstream.fetch }).authenticate(
      'alice',
      'secret',
      'browser-500',
    ),
    'upstream',
    500,
  )

  const network = fakeFetch([new Error('connection refused')])
  const networkError = await expectJellyfinError(
    new Jellyfin('https://jellyfin.example', { fetch: network.fetch }).authenticate(
      'alice',
      'secret',
      'browser-network',
    ),
    'network',
  )
  assert.equal((networkError.cause as Error).message, 'connection refused')
})

Deno.test('successful but malformed authentication responses are typed failures', async () => {
  for (
    const response of [
      new Response('not-json', { status: 200 }),
      json({ AccessToken: 'token' }),
      json({ AccessToken: 'token', User: { Id: 'id' } }),
    ]
  ) {
    const transport = fakeFetch([response])
    await expectJellyfinError(
      new Jellyfin('https://jellyfin.example', { fetch: transport.fetch }).authenticate(
        'alice',
        'secret',
        'browser-id',
      ),
      'malformed-response',
    )
  }
})

Deno.test('user returns null only for invalid tokens and types other failures', async () => {
  for (const status of [401, 403]) {
    const transport = fakeFetch([new Response(null, { status })])
    const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })
    assert.equal(await jellyfin.user(`invalid-${status}`), null)
    assert.equal(
      headers(transport.calls[0]!).get('authorization'),
      `MediaBrowser Token="invalid-${status}"`,
    )
  }

  const upstream = fakeFetch([new Response(null, { status: 502 })])
  await expectJellyfinError(
    new Jellyfin('https://jellyfin.example', { fetch: upstream.fetch }).user('token'),
    'upstream',
    502,
  )

  const network = fakeFetch([new Error('socket closed')])
  await expectJellyfinError(
    new Jellyfin('https://jellyfin.example', { fetch: network.fetch }).user('token'),
    'network',
  )

  const malformed = fakeFetch([json({ Id: 123, Name: 'Alice' })])
  await expectJellyfinError(
    new Jellyfin('https://jellyfin.example', { fetch: malformed.fetch }).user('token'),
    'malformed-response',
  )
})

Deno.test('every fetch is bounded and aborts on timeout', async () => {
  const observed: { signal?: AbortSignal } = {}
  const fetch: JellyfinFetch = (_input, init) => {
    observed.signal = init?.signal as AbortSignal
    return new Promise<Response>(() => {})
  }
  const jellyfin = new Jellyfin('https://jellyfin.example', { fetch, timeoutMs: 5 })

  await expectJellyfinError(jellyfin.user('token'), 'timeout')
  assert.equal(observed.signal?.aborted, true)
})

Deno.test('response bodies are also bounded by the timeout', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"Id":"user-1"'))
    },
  })
  const transport = fakeFetch([
    new Response(body, { headers: { 'content-type': 'application/json' } }),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', {
    fetch: transport.fetch,
    timeoutMs: 5,
  })

  await expectJellyfinError(jellyfin.user('token'), 'timeout')
})

Deno.test('concurrent user cache misses coalesce and resolved users stay cached', async () => {
  let now = 1_000
  let resolveFirst!: (response: Response) => void
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirst = resolve
  })
  const transport = fakeFetch([
    () => firstResponse,
    json(userDto('user-1', 'Alice refreshed')),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', {
    fetch: transport.fetch,
    cacheTtlMs: 60,
    now: () => now,
  })

  const first = jellyfin.user('token')
  const concurrent = jellyfin.user('token')
  assert.strictEqual(first, concurrent)
  assert.equal(transport.calls.length, 1)

  resolveFirst(json(userDto()))
  assert.deepEqual(await first, await concurrent)
  assert.equal((await jellyfin.user('token'))?.name, 'Alice')
  assert.equal(transport.calls.length, 1)

  now += 61
  const refreshed = jellyfin.user('token')
  const concurrentRefresh = jellyfin.user('token')
  assert.strictEqual(refreshed, concurrentRefresh)
  assert.equal((await refreshed)?.name, 'Alice refreshed')
  assert.equal(transport.calls.length, 2)
})

Deno.test('failed coalesced user lookups are retried rather than cached', async () => {
  let resolveFailure!: (response: Response) => void
  const failure = new Promise<Response>((resolve) => {
    resolveFailure = resolve
  })
  const transport = fakeFetch([
    () => failure,
    json(userDto()),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })

  const first = jellyfin.user('token')
  const concurrent = jellyfin.user('token')
  resolveFailure(new Response(null, { status: 500 }))
  await Promise.all([
    expectJellyfinError(first, 'upstream', 500),
    expectJellyfinError(concurrent, 'upstream', 500),
  ])
  assert.equal(transport.calls.length, 1)

  assert.equal((await jellyfin.user('token'))?.id, 'user-1')
  assert.equal(transport.calls.length, 2)
})

Deno.test('the user cache evicts old entries at its configured bound', async () => {
  const transport = fakeFetch([
    json(userDto('one', 'One')),
    json(userDto('two', 'Two')),
    json(userDto('three', 'Three')),
    json(userDto('one', 'One again')),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', {
    fetch: transport.fetch,
    maxCacheEntries: 2,
  })

  await jellyfin.user('token-one')
  await jellyfin.user('token-two')
  await jellyfin.user('token-three')
  assert.equal((await jellyfin.user('token-one'))?.name, 'One again')
  assert.equal(transport.calls.length, 4)
})

Deno.test('users sends modern token authorization and validates its response', async () => {
  const transport = fakeFetch([
    json([userDto('one', 'One', false, null), userDto('two', 'Two')]),
    json({ Users: [] }),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })

  assert.deepEqual(await jellyfin.users('admin-token'), [
    { id: 'one', name: 'One', isAdmin: false, avatarTag: null },
    { id: 'two', name: 'Two', isAdmin: true, avatarTag: 'avatar-tag' },
  ])
  assert.equal(
    headers(transport.calls[0]!).get('authorization'),
    'MediaBrowser Token="admin-token"',
  )
  assert.equal(headers(transport.calls[0]!).has('x-emby-token'), false)

  await expectJellyfinError(jellyfin.users('admin-token'), 'malformed-response')
})

Deno.test('logout sends token authorization, revokes the local cache, and is best effort', async () => {
  const transport = fakeFetch([
    json(userDto()),
    new Error('offline'),
    new Response(null, { status: 500 }),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })

  await jellyfin.user('token')
  await jellyfin.logout('token')
  const logoutCall = transport.calls[1]!
  assert.equal(logoutCall.url, 'https://jellyfin.example/Sessions/Logout')
  assert.equal(logoutCall.init.method, 'POST')
  assert.equal(headers(logoutCall).get('authorization'), 'MediaBrowser Token="token"')
  assert.equal(headers(logoutCall).has('x-emby-token'), false)

  assert.equal(await jellyfin.user('token'), null)
  assert.equal(transport.calls.length, 2)
  await jellyfin.logout('another-token')
})

Deno.test('logout prevents an in-flight lookup from re-caching the token', async () => {
  let resolveUser!: (response: Response) => void
  const pendingResponse = new Promise<Response>((resolve) => {
    resolveUser = resolve
  })
  const transport = fakeFetch([
    () => pendingResponse,
    new Response(null, { status: 204 }),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })

  const lookup = jellyfin.user('token')
  await jellyfin.logout('token')
  resolveUser(json(userDto()))

  assert.equal(await lookup, null)
  assert.equal(await jellyfin.user('token'), null)
  assert.equal(transport.calls.length, 2)
})

Deno.test('avatar authenticates upstream and always returns no-store responses', async () => {
  const transport = fakeFetch([
    new Response('image bytes', {
      status: 200,
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=86400',
      },
    }),
    new Response(null, { status: 404 }),
  ])
  const jellyfin = new Jellyfin('https://jellyfin.example', { fetch: transport.fetch })

  const avatar = await jellyfin.avatar('user/id', 'tag +', 'session-token')
  assert.equal(
    transport.calls[0]!.url,
    'https://jellyfin.example/Users/user%2Fid/Images/Primary?tag=tag%20%2B&quality=90',
  )
  assert.equal(
    headers(transport.calls[0]!).get('authorization'),
    'MediaBrowser Token="session-token"',
  )
  assert.equal(headers(transport.calls[0]!).has('x-emby-token'), false)
  assert.equal(avatar.status, 200)
  assert.equal(avatar.headers.get('content-type'), 'image/webp')
  assert.equal(avatar.headers.get('cache-control'), 'no-store')
  assert.equal(await avatar.text(), 'image bytes')

  const missing = await jellyfin.avatar('user/id', 'missing', 'session-token')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'no-store')
})
