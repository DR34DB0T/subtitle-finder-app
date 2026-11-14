// api.ts — talks to the OpenSubtitles REST API (https://opensubtitles.stoplight.io)
//
// This file runs on the SERVER only, so your API key never reaches the browser.
// It does four things:
//   1. searchTitles()   – find movies / TV series by name
//   2. getSeasons()     – list the seasons and episodes of a series
//   3. findSubtitles()  – find the best subtitle per language (and per episode)
//   4. downloadSubtitle() – fetch the actual .srt text for one subtitle file
//
// Every request goes through `request()`, which adds the right headers,
// waits a little between calls (rate limiting) and turns HTTP errors into
// friendly `ApiError`s.

import type { ErrorCode, Season, SubtitleCandidate, Title } from '../../src/shared.ts'

const DEFAULT_BASE_URL = 'https://api.opensubtitles.com/api/v1'
// OpenSubtitles asks every app to identify itself with a User-Agent.
const USER_AGENT = 'SubtitleFinder v1.0'
// OpenSubtitles allows about 5 requests per second. We stay well below that.
const MIN_GAP_MS = 250
const REQUEST_TIMEOUT_MS = 15_000

/** An error with a machine-readable code and a human-readable message. */
export class ApiError extends Error {
  code: ErrorCode
  status: number
  retryAfter?: number

  constructor(code: ErrorCode, message: string, status = 502, retryAfter?: number) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

// ---------------------------------------------------------------------------
// Rate limiting: make sure two calls are at least MIN_GAP_MS apart.
// ---------------------------------------------------------------------------
let nextSlot = 0
async function throttle(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextSlot - now)
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

// ---------------------------------------------------------------------------
// Optional login. With a username + password, OpenSubtitles gives you a
// token and a much larger daily download allowance. The token is cached in
// memory (it is only a cache: if the server restarts we simply log in again).
// ---------------------------------------------------------------------------
interface Session {
  token: string
  baseUrl: string
  expiresAt: number
}
let session: Session | null = null
let loginFailedAt = 0

async function getSession(): Promise<Session | null> {
  const username = process.env.OPENSUBTITLES_USERNAME
  const password = process.env.OPENSUBTITLES_PASSWORD
  if (!username || !password) return null
  if (session && session.expiresAt > Date.now()) return session
  // Don't hammer the login endpoint if the credentials are wrong.
  if (Date.now() - loginFailedAt < 5 * 60_000) return null

  try {
    await throttle()
    const res = await fetch(`${DEFAULT_BASE_URL}/login`, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`login failed with HTTP ${res.status}`)
    const data = (await res.json()) as { token: string; base_url?: string }
    session = {
      token: data.token,
      baseUrl: data.base_url ? `https://${data.base_url}/api/v1` : DEFAULT_BASE_URL,
      expiresAt: Date.now() + 12 * 60 * 60_000, // tokens last 24h; refresh after 12h
    }
    return session
  } catch (err) {
    // Fall back to anonymous access instead of breaking the whole app.
    console.warn('OpenSubtitles login failed, continuing without it:', err)
    loginFailedAt = Date.now()
    return null
  }
}

function baseHeaders(): Record<string, string> {
  return {
    'Api-Key': process.env.OPENSUBTITLES_API_KEY ?? '',
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

/** True when an API key has been configured. Without one we use demo data. */
export function hasApiKey(): boolean {
  return Boolean(process.env.OPENSUBTITLES_API_KEY)
}

export function hasLogin(): boolean {
  return Boolean(process.env.OPENSUBTITLES_USERNAME && process.env.OPENSUBTITLES_PASSWORD)
}

// ---------------------------------------------------------------------------
// The one function that actually calls OpenSubtitles.
// ---------------------------------------------------------------------------
async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; query?: Record<string, string | number>; body?: unknown } = {},
): Promise<T> {
  const auth = await getSession()
  await throttle()

  const url = new URL((auth?.baseUrl ?? DEFAULT_BASE_URL) + path)
  // OpenSubtitles recommends sorted, lower-case query parameters
  // (otherwise it answers with a redirect, costing an extra request).
  const entries = Object.entries(options.query ?? {}).sort(([a], [b]) => a.localeCompare(b))
  for (const [key, value] of entries) url.searchParams.set(key, String(value).toLowerCase())

  const headers = baseHeaders()
  if (auth) headers.Authorization = `Bearer ${auth.token}`

  let res: Response
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new ApiError('network', 'Could not reach OpenSubtitles. Check your connection and try again.', 503)
  }

  if (res.ok) return (await res.json()) as T

  // Turn HTTP status codes into errors the UI understands.
  const text = await res.text().catch(() => '')
  if (res.status === 401 || res.status === 403) {
    session = null // the token may have expired
    throw new ApiError('invalid_key', 'OpenSubtitles rejected the API key (or login). Check OPENSUBTITLES_API_KEY.', 401)
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2
    throw new ApiError('rate_limited', 'OpenSubtitles rate limit reached. Slowing down…', 429, retryAfter)
  }
  if (res.status === 406 || /allowed \d+ subtitles|quota/i.test(text)) {
    throw new ApiError(
      'quota_exceeded',
      'Daily download quota reached. Add OPENSUBTITLES_USERNAME/PASSWORD for a larger quota, or try again tomorrow.',
      429,
    )
  }
  if (res.status === 404) throw new ApiError('not_found', 'Not found on OpenSubtitles.', 404)
  throw new ApiError('upstream', `OpenSubtitles returned an error (HTTP ${res.status}).`, 502)
}

// ---------------------------------------------------------------------------
// 1. Search
// ---------------------------------------------------------------------------
interface FeatureResponse {
  data: Array<{
    attributes: {
      feature_id: number | string
      feature_type: string
      title: string
      year?: string | number | null
      img_url?: string | null
      seasons_count?: number | null
      seasons?: Array<{ season_number: number; episodes?: Array<{ episode_number: number }> }>
    }
  }>
}

function posterUrl(img: string | null | undefined): string | null {
  if (!img || img.includes('empty')) return null
  return img.startsWith('/') ? `https://www.opensubtitles.com${img}` : img
}

export async function searchTitles(query: string, kind: 'all' | 'movie' | 'series'): Promise<Title[]> {
  const type = kind === 'series' ? 'tvshow' : kind
  const res = await request<FeatureResponse>('/features', { query: { query, type } })

  return res.data
    .map(({ attributes: a }) => {
      const featureType = a.feature_type.toLowerCase()
      if (featureType !== 'movie' && featureType !== 'tvshow') return null // skip single episodes
      const year = Number(a.year)
      const title: Title = {
        featureId: String(a.feature_id),
        title: a.title,
        year: Number.isFinite(year) && year > 1800 ? year : null,
        kind: featureType === 'movie' ? 'movie' : 'series',
        poster: posterUrl(a.img_url),
        seasonsCount: a.seasons_count ?? null,
      }
      return title
    })
    .filter((t): t is Title => t !== null)
}

// ---------------------------------------------------------------------------
// 2. Seasons of a series
// ---------------------------------------------------------------------------
export async function getSeasons(featureId: string): Promise<Season[]> {
  const res = await request<FeatureResponse>('/features', { query: { feature_id: featureId } })
  const seasons = res.data[0]?.attributes.seasons ?? []
  return seasons
    .map((s) => ({
      season: s.season_number,
      episodes: [...new Set((s.episodes ?? []).map((e) => e.episode_number))]
        .filter((n) => n > 0)
        .sort((a, b) => a - b),
    }))
    .filter((s) => s.season > 0)
    .sort((a, b) => a.season - b.season)
}

// ---------------------------------------------------------------------------
// 3. Find subtitles
// ---------------------------------------------------------------------------
interface SubtitlesResponse {
  total_pages: number
  data: Array<{
    attributes: {
      language: string
      download_count: number
      machine_translated?: boolean
      ai_translated?: boolean
      release?: string
      files: Array<{ file_id: number; file_name?: string }>
      feature_details?: { season_number?: number; episode_number?: number; title?: string }
    }
  }>
}

const MAX_PAGES = 10

/**
 * Finds the single best subtitle for every language (and, for series,
 * every episode of the given season). "Best" = most downloaded, preferring
 * human translations and single-file (not multi-CD) subtitles.
 */
export async function findSubtitles(params: {
  featureId: string
  kind: 'movie' | 'series'
  season: number | null
  languages: string[]
}): Promise<SubtitleCandidate[]> {
  const best = new Map<string, { score: number; candidate: SubtitleCandidate }>()
  const wanted = new Set(params.languages.map((l) => l.toLowerCase()))

  for (let page = 1; page <= MAX_PAGES; page++) {
    const query: Record<string, string | number> = { languages: params.languages.join(','), page }
    if (params.kind === 'movie') query.id = params.featureId
    else {
      query.parent_feature_id = params.featureId
      query.season_number = params.season ?? 1
    }

    const res = await request<SubtitlesResponse>('/subtitles', { query })

    for (const { attributes: a } of res.data) {
      const language = a.language
      if (!wanted.has(language?.toLowerCase()) || a.files.length === 0) continue
      const episode = params.kind === 'series' ? (a.feature_details?.episode_number ?? null) : null
      if (params.kind === 'series' && !episode) continue

      let score = a.download_count || 0
      if (a.machine_translated || a.ai_translated) score *= 0.01
      if (a.files.length > 1) score *= 0.001 // split across several CDs: avoid

      const key = `${episode ?? 0}|${language.toLowerCase()}`
      const current = best.get(key)
      if (!current || score > current.score) {
        best.set(key, {
          score,
          candidate: {
            fileId: a.files[0].file_id,
            language: params.languages.find((l) => l.toLowerCase() === language.toLowerCase()) ?? language,
            season: params.kind === 'series' ? (params.season ?? 1) : null,
            episode,
            episodeTitle: a.feature_details?.title ?? null,
            release: a.release ?? a.files[0].file_name ?? '',
            downloads: a.download_count || 0,
          },
        })
      }
    }

    if (page >= (res.total_pages || 1)) break
    if (params.kind === 'movie' && page >= 2) break // two pages is plenty for a movie
  }

  return [...best.values()].map((b) => b.candidate)
}

// ---------------------------------------------------------------------------
// 4. Download one subtitle file
// ---------------------------------------------------------------------------
export async function downloadSubtitle(fileId: number): Promise<{ content: string; remaining: number | null }> {
  // Step 1: ask OpenSubtitles for a temporary download link.
  const info = await request<{ link: string; remaining?: number }>('/download', {
    method: 'POST',
    body: { file_id: fileId, sub_format: 'srt' },
  })

  // Step 2: download the file itself from that link.
  let res: Response
  try {
    res = await fetch(info.link, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new ApiError('network', 'The subtitle file could not be downloaded (network error).', 503)
  }
  if (!res.ok) throw new ApiError('upstream', `The subtitle file could not be downloaded (HTTP ${res.status}).`, 502)

  const content = new TextDecoder('utf-8').decode(await res.arrayBuffer())
  return { content, remaining: info.remaining ?? null }
}
