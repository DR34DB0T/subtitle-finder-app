// index.ts — the web server (a Netlify Server running Hono).
//
// It exposes a small JSON API under /api/* that the browser calls.
// The browser never talks to OpenSubtitles directly: that way your API key
// stays secret on the server. Every route validates its input before
// doing anything.
//
//   GET  /api/status                     → is an API key configured? (demo mode or not)
//   GET  /api/search?q=...&type=...      → search movies / series
//   GET  /api/seasons/:featureId         → seasons + episodes of a series
//   GET  /api/subtitles?featureId=...    → best subtitle per language / episode
//   POST /api/download { fileId }        → the .srt text of one subtitle

import { Hono, type Context } from 'hono'
import { LANGUAGES, MAX_LANGUAGES } from '../../src/shared.ts'
import * as real from './api.ts'
import * as demo from './demo.ts'
import { ApiError } from './api.ts'

const app = new Hono()

/** Use the real API when a key is configured, otherwise the demo data. */
const provider = () => (real.hasApiKey() ? real : demo)

// ---- Input validation helpers ---------------------------------------------
function bad(message: string): never {
  throw new ApiError('bad_request', message, 400)
}

function parseFeatureId(value: string | undefined): string {
  if (!value || !/^\d{1,12}$/.test(value)) bad('Invalid title id.')
  return value
}

function parseLanguages(value: string | undefined): string[] {
  const langs = [...new Set((value ?? '').split(',').map((l) => l.trim()).filter(Boolean))]
  if (langs.length === 0) bad('Choose at least one language.')
  if (langs.length > MAX_LANGUAGES) bad(`Choose at most ${MAX_LANGUAGES} languages.`)
  for (const l of langs) if (!(l in LANGUAGES)) bad(`Unsupported language: ${l}`)
  return langs
}

// ---- Routes -----------------------------------------------------------------
app.get('/api/status', (c) =>
  c.json({ demo: !real.hasApiKey(), loggedIn: real.hasApiKey() && real.hasLogin() }),
)

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const type = c.req.query('type') ?? 'all'
  if (q.length < 2) bad('Type at least 2 characters to search.')
  if (q.length > 100) bad('That search is too long (max 100 characters).')
  if (type !== 'all' && type !== 'movie' && type !== 'series') bad('Invalid search type.')

  const results = await provider().searchTitles(q, type)
  return c.json({ results })
})

app.get('/api/seasons/:featureId', async (c) => {
  const featureId = parseFeatureId(c.req.param('featureId'))
  const seasons = await provider().getSeasons(featureId)
  return c.json({ seasons })
})

app.get('/api/subtitles', async (c) => {
  const featureId = parseFeatureId(c.req.query('featureId'))
  const kind = c.req.query('kind')
  if (kind !== 'movie' && kind !== 'series') bad('Invalid kind (movie or series).')
  let season: number | null = null
  if (kind === 'series') {
    season = Number(c.req.query('season'))
    if (!Number.isInteger(season) || season < 1 || season > 100) bad('Invalid season number.')
  }
  const languages = parseLanguages(c.req.query('languages'))

  const subtitles = await provider().findSubtitles({ featureId, kind, season, languages })
  return c.json({ subtitles })
})

app.post('/api/download', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { fileId?: unknown }
  const fileId = Number(body.fileId)
  if (!Number.isSafeInteger(fileId) || fileId <= 0) bad('Invalid file id.')

  const result = await provider().downloadSubtitle(fileId)
  // Subtitles larger than ~2 MB are almost certainly not subtitles.
  if (result.content.length > 2_000_000) throw new ApiError('upstream', 'Subtitle file is unexpectedly large.', 502)
  return c.json(result)
})

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Unknown API route.' } }, 404))

// Any error thrown above ends up here and is sent back as JSON.
app.onError((err, c: Context) => {
  if (err instanceof ApiError) {
    if (err.retryAfter) c.header('Retry-After', String(err.retryAfter))
    return c.json(
      { error: { code: err.code, message: err.message, retryAfter: err.retryAfter } },
      err.status as 400,
    )
  }
  console.error(err)
  return c.json({ error: { code: 'upstream', message: 'Unexpected server error.' } }, 500)
})

export default app

// Only /api/* goes to this server; the rest of the site is static files.
export const config = { path: '/api/*' }
