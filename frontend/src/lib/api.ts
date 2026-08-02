import type {
  CostFile,
  CostPoint,
  CostSaveInput,
  Donation,
  DonationInput,
  KnownUser,
  Me,
  Summary,
} from '../../../shared/types.ts'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = await res.json()
      if (body?.error) message = body.error
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message)
  }
  return res
}

async function jsonReq<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return undefined as T
  return res.json()
}

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
  summary: async (): Promise<Summary> => (await req('/api/summary')).json(),
  me: async (): Promise<Me> => (await req('/api/me')).json(),
  login: (username: string, password: string) =>
    jsonReq<Me>('/api/auth', 'POST', { username, password, deviceId: deviceId() }),
  logout: () => req('/api/logout', { method: 'POST' }),
  create: (input: CostSaveInput) => jsonReq<CostPoint>('/api/costs', 'POST', input),
  update: (id: number, input: CostSaveInput) => jsonReq<CostPoint>(`/api/costs/${id}`, 'PUT', input),
  remove: (id: number) => jsonReq<void>(`/api/costs/${id}`, 'DELETE'),
  createDonation: (input: DonationInput) => jsonReq<Donation>('/api/donations', 'POST', input),
  submitDonation: (input: DonationInput) =>
    jsonReq<Donation>('/api/donations/submit', 'POST', input),
  confirmDonation: (id: number) => jsonReq<Donation>(`/api/donations/${id}/confirm`, 'POST'),
  updateDonation: (id: number, input: DonationInput) =>
    jsonReq<Donation>(`/api/donations/${id}`, 'PUT', input),
  removeDonation: (id: number) => jsonReq<void>(`/api/donations/${id}`, 'DELETE'),
  /** admin only: Jellyfin users incl. archived ones (accounts deleted on the server) */
  users: async (): Promise<KnownUser[]> => (await req('/api/users')).json(),
  exportJson: () => jsonReq<unknown>('/api/export', 'GET'),
  importJson: (data: unknown) => jsonReq<CostFile>('/api/import', 'POST', data),
}
