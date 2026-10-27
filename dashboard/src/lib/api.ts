import 'server-only'

// Server-side only. API_URL is read at runtime (Docker: http://api:3000).
export function apiBaseUrl(): string {
  return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'
}

export async function apiFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
}

export type Me = {
  user: { id: string; email: string | null }
  workspace: { id: string; name: string; setupCompleted: boolean } | null
  role: 'admin' | 'member' | null
}

export async function getMe(token: string): Promise<Me> {
  const res = await apiFetch('/api/me', token)
  if (!res.ok) throw new Error(`GET /api/me failed: ${res.status}`)
  return res.json() as Promise<Me>
}
