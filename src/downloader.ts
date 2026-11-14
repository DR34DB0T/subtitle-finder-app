// downloader.ts — works through the queue and downloads every subtitle.
//
// It runs in two phases:
//   1. LOOK UP: for each queued title (and each chosen season) ask the server
//      which subtitles exist in the chosen languages.
//   2. DOWNLOAD: fetch each subtitle file, one at a time, with a short pause
//      between downloads to respect the OpenSubtitles rate limits.
//
// Anything that can't be found or downloaded is recorded as a Failure
// instead of stopping the whole run. Those failures end up in summary.txt.

import { api, ClientError } from './client.ts'
import { LANGUAGES, type MediaKind, type SubtitleCandidate } from './shared.ts'

/** One entry in the batch queue. */
export interface QueueItem {
  id: string
  featureId: string
  title: string
  year: number | null
  kind: MediaKind
  poster: string | null
  /** Series only: chosen season numbers. */
  seasons: number[]
  /** Series only: "all" episodes or an inclusive range, applied to every chosen season. */
  episodes: { mode: 'all' } | { mode: 'range'; from: number; to: number }
  /** Series only: episode numbers per season, when OpenSubtitles knows them. */
  knownEpisodes: Record<number, number[]>
}

/** A subtitle that was downloaded successfully (kept in memory, never on disk). */
export interface DownloadedFile {
  id: string
  item: QueueItem
  language: string
  season: number | null
  episode: number | null
  release: string
  content: string
}

export interface Failure {
  title: string
  what: string
  reason: string
}

export interface Progress {
  phase: 'lookup' | 'download'
  done: number
  total: number
  message: string
}

const DELAY_BETWEEN_REQUESTS_MS = 400
const MAX_ATTEMPTS = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pad = (n: number) => String(n).padStart(2, '0')
export const episodeLabel = (s: number | null, e: number | null) => (s && e ? `S${pad(s)}E${pad(e)}` : '')
export const languageName = (code: string) => LANGUAGES[code] ?? code

/**
 * Runs `fn`, retrying when we are rate limited (waits as long as the server
 * asks) or when the network hiccups. Other errors are thrown straight away.
 */
async function withRetry<T>(fn: () => Promise<T>, onWait: (msg: string) => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const e = err as ClientError
      const retryable = e.code === 'rate_limited' || e.code === 'network'
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err
      const waitMs = e.code === 'rate_limited' ? (e.retryAfter ?? 2) * 1000 * attempt : 1500 * attempt
      onWait(`${e.code === 'rate_limited' ? 'Rate limited' : 'Network hiccup'} — retrying in ${Math.round(waitMs / 1000)}s…`)
      await sleep(waitMs)
    }
  }
}

/** Thrown when the whole run must stop (e.g. invalid API key, or cancelled). */
export class FatalError extends Error {}

export async function runQueue(
  queue: QueueItem[],
  languages: string[],
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<{ files: DownloadedFile[]; failures: Failure[] }> {
  const failures: Failure[] = []
  const tasks: Array<{ item: QueueItem; candidate: SubtitleCandidate }> = []

  const checkCancelled = () => {
    if (signal.aborted) throw new FatalError('Cancelled.')
  }
  const fatalIfKeyProblem = (err: unknown) => {
    if (err instanceof ClientError && err.code === 'invalid_key') throw new FatalError(err.message)
  }

  // ---------------- Phase 1: look up what's available ----------------
  const lookups = queue.flatMap((item) =>
    item.kind === 'movie' ? [{ item, season: null as number | null }] : item.seasons.map((season) => ({ item, season })),
  )
  let done = 0
  const total = () => lookups.length + tasks.length

  for (const { item, season } of lookups) {
    checkCancelled()
    const where = item.kind === 'series' ? `${item.title} · Season ${season}` : item.title
    onProgress({ phase: 'lookup', done, total: total(), message: `Looking up ${where}…` })

    try {
      const found = await withRetry(
        () => api.subtitles({ featureId: item.featureId, kind: item.kind, season, languages }),
        (msg) => onProgress({ phase: 'lookup', done, total: total(), message: msg }),
      )
      planTasks(item, season, found, languages, tasks, failures)
    } catch (err) {
      fatalIfKeyProblem(err)
      failures.push({
        title: item.title,
        what: season ? `Season ${season} (all languages)` : 'All languages',
        reason: (err as Error).message,
      })
    }
    done++
    await sleep(DELAY_BETWEEN_REQUESTS_MS)
  }

  // ---------------- Phase 2: download each file ----------------
  const files: DownloadedFile[] = []
  let quotaHit: string | null = null

  for (const { item, candidate } of tasks) {
    checkCancelled()
    const label = [item.title, episodeLabel(candidate.season, candidate.episode), languageName(candidate.language)]
      .filter(Boolean)
      .join(' · ')

    if (quotaHit) {
      // Once the daily quota is used up, every further download would fail too.
      failures.push({ title: item.title, what: describe(candidate), reason: quotaHit })
      done++
      continue
    }

    onProgress({ phase: 'download', done, total: total(), message: `Downloading ${label}` })
    try {
      const { content } = await withRetry(
        () => api.download(candidate.fileId),
        (msg) => onProgress({ phase: 'download', done, total: total(), message: msg }),
      )
      if (!content.trim()) throw new Error('The downloaded file was empty.')
      files.push({
        id: `${item.id}-${candidate.fileId}`,
        item,
        language: candidate.language,
        season: candidate.season,
        episode: candidate.episode,
        release: candidate.release,
        content,
      })
    } catch (err) {
      fatalIfKeyProblem(err)
      if (err instanceof ClientError && err.code === 'quota_exceeded') quotaHit = err.message
      failures.push({ title: item.title, what: describe(candidate), reason: (err as Error).message })
    }
    done++
    await sleep(DELAY_BETWEEN_REQUESTS_MS)
  }

  onProgress({ phase: 'download', done: total(), total: total(), message: 'Done.' })
  return { files, failures }
}

function describe(c: SubtitleCandidate): string {
  return [episodeLabel(c.season, c.episode), languageName(c.language)].filter(Boolean).join(' – ')
}

/**
 * Decides which files to download for one lookup, and records anything that
 * is missing (e.g. "S01E04 – French: no subtitle found").
 */
function planTasks(
  item: QueueItem,
  season: number | null,
  found: SubtitleCandidate[],
  languages: string[],
  tasks: Array<{ item: QueueItem; candidate: SubtitleCandidate }>,
  failures: Failure[],
) {
  if (item.kind === 'movie') {
    for (const lang of languages) {
      const c = found.find((f) => f.language === lang)
      if (c) tasks.push({ item, candidate: c })
      else failures.push({ title: item.title, what: languageName(lang), reason: 'No subtitle found.' })
    }
    return
  }

  // Which episodes do we want for this season?
  const known = item.knownEpisodes[season!] ?? []
  const discovered = [...new Set(found.map((f) => f.episode!))]
  let wanted: number[]
  if (item.episodes.mode === 'range') {
    wanted = []
    for (let e = item.episodes.from; e <= item.episodes.to; e++) wanted.push(e)
    // If we know how many episodes the season has, don't ask for ones that don't exist.
    if (known.length) wanted = wanted.filter((e) => known.includes(e))
  } else {
    wanted = known.length ? known : discovered
  }
  wanted.sort((a, b) => a - b)

  if (wanted.length === 0) {
    failures.push({ title: item.title, what: `Season ${season}`, reason: 'No episodes / subtitles found for this season.' })
    return
  }

  for (const episode of wanted) {
    for (const lang of languages) {
      const c = found.find((f) => f.episode === episode && f.language === lang)
      if (c) tasks.push({ item, candidate: c })
      else
        failures.push({
          title: item.title,
          what: `${episodeLabel(season, episode)} – ${languageName(lang)}`,
          reason: 'No subtitle found (missing episode).',
        })
    }
  }
}
