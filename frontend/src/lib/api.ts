import { hc, type InferRequestType, type PickResponseByStatusCode } from 'hono/client'
import type { AppType } from '../../../src/app.ts'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function checkedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: 'same-origin' })
  if (response.ok) return response

  let message = response.statusText
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object' && body !== null && 'error' in body &&
      typeof body.error === 'string'
    ) {
      message = body.error
    }
  } catch {
    // Keep statusText when an ordinary HTTP resource has no JSON error body.
  }
  throw new ApiError(response.status, message)
}

// checkedFetch turns every non-2xx response into ApiError before callers decode it.
type SuccessApp = PickResponseByStatusCode<AppType, 200 | 201 | 204>
const client = hc<SuccessApp>('/', { fetch: checkedFetch })

type CostSaveInput = InferRequestType<typeof client.api.costs.$post>['json']
type IncomeSaveInput = InferRequestType<typeof client.api.income.$post>['json']

function randomDeviceId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID()
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    // The identifier is only for Jellyfin session isolation, not authentication.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-costthing`
  }
}

function deviceId(): string {
  const key = 'costthing.device-id'
  try {
    const stored = localStorage.getItem(key)
    if (stored && /^[a-zA-Z0-9-]{16,100}$/.test(stored)) return stored
    const created = randomDeviceId()
    localStorage.setItem(key, created)
    return created
  } catch {
    return randomDeviceId()
  }
}

export const api = {
  summary: async () => (await client.api.summary.$get()).json(),
  me: async () => (await client.api.me.$get()).json(),
  login: async (username: string, password: string) =>
    (await client.api.auth.$post({
      json: { username, password, deviceId: deviceId() },
    })).json(),
  logout: () => client.api.logout.$post(),
  create: async (input: CostSaveInput) =>
    (await client.api.costs.$post({ json: input })).json(),
  update: async (id: number, input: CostSaveInput) =>
    (await client.api.costs[':id'].$put({
      param: { id: String(id) },
      json: input,
    })).json(),
  remove: async (id: number) => {
    await client.api.costs[':id'].$delete({ param: { id: String(id) } })
  },
  createIncome: async (input: IncomeSaveInput) =>
    (await client.api.income.$post({ json: input })).json(),
  updateIncome: async (id: number, input: IncomeSaveInput) =>
    (await client.api.income[':id'].$put({
      param: { id: String(id) },
      json: input,
    })).json(),
  removeIncome: async (id: number) => {
    await client.api.income[':id'].$delete({ param: { id: String(id) } })
  },
  exportJson: async () => (await client.api.export.$get()).json(),
  importJson: async (data: unknown) =>
    (await client.api.import.$post({ json: data })).json(),
}
