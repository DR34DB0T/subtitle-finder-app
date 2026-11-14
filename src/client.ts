// client.ts — tiny helper for calling our own server's /api routes.
// It turns any failure (including "no internet") into a ClientError with a
// code, so the rest of the app can decide what to do (retry, skip, stop).

import type { ApiErrorBody, ErrorCode, Season, SubtitleCandidate, Title } from './shared.ts'

export class ClientError extends Error {
  code: ErrorCode
  retryAfter?: number

  constructor(code: ErrorCode, message: string, retryAfter?: number) {
    super(message)
    this.code = code
    this.retryAfter = retryAfter
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ClientError('network', 'Network error: could not reach the server. Check your connection.')
  }
  const data = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null
  if (!res.ok || !data) {
    const e = data?.error
    throw new ClientError(e?.code ?? 'upstream', e?.message ?? `Server error (HTTP ${res.status}).`, e?.retryAfter)
  }
  return data
}

export const api = {
  status: () => call<{ demo: boolean; loggedIn: boolean }>('/api/status'),

  search: (q: string, type: 'all' | 'movie' | 'series') =>
    call<{ results: Title[] }>(`/api/search?${new URLSearchParams({ q, type })}`).then((r) => r.results),

  seasons: (featureId: string) =>
    call<{ seasons: Season[] }>(`/api/seasons/${encodeURIComponent(featureId)}`).then((r) => r.seasons),

  subtitles: (p: { featureId: string; kind: 'movie' | 'series'; season: number | null; languages: string[] }) => {
    const params = new URLSearchParams({ featureId: p.featureId, kind: p.kind, languages: p.languages.join(',') })
    if (p.season !== null) params.set('season', String(p.season))
    return call<{ subtitles: SubtitleCandidate[] }>(`/api/subtitles?${params}`).then((r) => r.subtitles)
  },

  download: (fileId: number) =>
    call<{ content: string; remaining: number | null }>('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    }),
}
