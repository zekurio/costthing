import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { Store } from './store.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }

function costBody() {
  return {
    name: 'Server',
    category: 'Hardware',
    costCents: 1200,
    cadence: 'monthly' as const,
    startsOn: '2026-07-24',
    endsOn: null,
    amortizationMonths: null,
    intervalCount: null,
    intervalUnit: null,
  }
}

async function fixture(isAdmin = true) {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-app-test-' })
  const store = await Store.load(join(directory, 'costs.json'))
  const user = {
    id: 'user-1',
    name: 'Alice',
    isAdmin,
    avatarTag: 'avatar-tag' as string | null,
  }
  let sessionFailure = false
  let authenticatedDeviceId = ''
  let loggedOutToken = ''
  const jellyfin = {
    async authenticate(username: string, _password: string, deviceId: string) {
      authenticatedDeviceId = deviceId
      return username === 'wrong' ? null : { token: 'session-token', user }
    },
    async user(token: string) {
      assert.equal(token, 'session-token')
      if (sessionFailure) {
        const error = new Error('offline')
        error.name = 'JellyfinError'
        throw error
      }
      return user
    },
    async logout(token: string) {
      loggedOutToken = token
    },
    async avatar(userId: string, tag: string, token: string) {
      assert.deepEqual([userId, tag, token], ['user-1', 'avatar-tag', 'session-token'])
      return new Response('avatar', { headers: { 'content-type': 'image/webp' } })
    },
  }
  const app = createApp({
    jellyfin,
    store,
    staticDir: directory,
    serveStatic: async (pathname) => new Response(`static:${pathname}`),
  })

  return {
    app,
    store,
    user,
    directory,
    authenticatedDeviceId: () => authenticatedDeviceId,
    loggedOutToken: () => loggedOutToken,
    failSession: () => sessionFailure = true,
  }
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request('/api/auth', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'x-forwarded-proto': 'https' },
    body: JSON.stringify({
      username: 'alice',
      password: 'secret',
      deviceId: 'browser-123456789',
    }),
  })
  assert.equal(response.status, 200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^costthing_session=session-token;/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Max-Age=34560000/)
  assert.match(setCookie, /Secure/)
  return setCookie.split(';')[0]!
}

Deno.test('Hono app preserves public, viewer, admin, and static route behavior', async () => {
  const test = await fixture()
  try {
    const health = await test.app.request('/api/health')
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const missingSession = await test.app.request('/api/summary')
    assert.equal(missingSession.status, 401)
    assert.deepEqual(await missingSession.json(), { error: 'login required' })

    const malformed = await test.app.request('/api/auth', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: 'alice' }),
    })
    assert.equal(malformed.status, 400)
    assert.equal(typeof (await malformed.json()).error, 'string')

    const cookie = await login(test.app)
    assert.equal(test.authenticatedDeviceId(), 'browser-123456789')

    const me = await test.app.request('/api/me', { headers: { cookie } })
    assert.deepEqual(await me.json(), { name: 'Alice', isAdmin: true, hasAvatar: true })

    const created = await test.app.request('/api/costs', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify(costBody()),
    })
    assert.equal(created.status, 201)
    const point = await created.json()
    assert.equal(point.id, 1)
    assert.deepEqual(point.priceChanges, [])

    const invalidId = await test.app.request('/api/costs/not-an-id', {
      method: 'DELETE',
      headers: { cookie },
    })
    assert.equal(invalidId.status, 400)

    const removed = await test.app.request('/api/costs/1', {
      method: 'DELETE',
      headers: { cookie },
    })
    assert.equal(removed.status, 204)
    assert.equal(await removed.text(), '')

    const unknownApi = await test.app.request('/api/missing', { headers: { cookie } })
    assert.equal(unknownApi.status, 404)
    assert.deepEqual(await unknownApi.json(), { error: 'not found' })

    const navigation = await test.app.request('/dashboard')
    assert.equal(await navigation.text(), 'static:/dashboard')

    const logout = await test.app.request('/api/logout', {
      method: 'POST',
      headers: { cookie },
    })
    assert.equal(logout.status, 200)
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/)
    await Promise.resolve()
    assert.equal(test.loggedOutToken(), 'session-token')
  } finally {
    await Deno.remove(test.directory, { recursive: true })
  }
})

Deno.test('Hono authorization keeps outages distinct from invalid sessions', async () => {
  const test = await fixture()
  try {
    const cookie = await login(test.app)
    test.failSession()
    const outage = await test.app.request('/api/me', { headers: { cookie } })
    assert.equal(outage.status, 503)
    assert.deepEqual(await outage.json(), { error: 'Jellyfin is temporarily unavailable' })
  } finally {
    await Deno.remove(test.directory, { recursive: true })
  }

  const viewer = await fixture(false)
  try {
    const cookie = await login(viewer.app)
    const forbidden = await viewer.app.request('/api/income', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ month: '2026-06', amountCents: 2500 }),
    })
    assert.equal(forbidden.status, 403)
    assert.deepEqual(await forbidden.json(), { error: 'admin required' })
  } finally {
    await Deno.remove(viewer.directory, { recursive: true })
  }
})

Deno.test('income bookings are managed by admins and summarized in the pot', async () => {
  const test = await fixture()
  try {
    const cookie = await login(test.app)
    const month = new Date().toISOString().slice(0, 7)

    const invalid = await test.app.request('/api/income', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ month: '2026-6', amountCents: 2500 }),
    })
    assert.equal(invalid.status, 400)

    const created = await test.app.request('/api/income', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ month, amountCents: 2500, note: 'Kasse' }),
    })
    assert.equal(created.status, 201)
    assert.deepEqual(await created.json(), { id: 1, month, amountCents: 2500, note: 'Kasse' })

    const updated = await test.app.request('/api/income/1', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ month, amountCents: 3000 }),
    })
    assert.equal(updated.status, 200)
    assert.deepEqual(await updated.json(), { id: 1, month, amountCents: 3000, note: null })

    const missing = await test.app.request('/api/income/9', {
      method: 'PUT',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ month, amountCents: 3000 }),
    })
    assert.equal(missing.status, 404)

    const summary = await test.app.request('/api/summary', { headers: { cookie } })
    assert.equal(summary.status, 200)
    const body = await summary.json()
    assert.deepEqual(
      body.income.map((entry: { id: number }) => entry.id),
      [1],
    )
    assert.equal(body.coverage.incomeCents, 3000)
    assert.equal(body.coverage.totalIncomeCents, 3000)
    assert.equal(body.coverage.totalCostCents, 0)
    assert.equal(body.coverage.totalBalanceCents, 3000)

    const removed = await test.app.request('/api/income/1', {
      method: 'DELETE',
      headers: { cookie },
    })
    assert.equal(removed.status, 204)
  } finally {
    await Deno.remove(test.directory, { recursive: true })
  }
})
