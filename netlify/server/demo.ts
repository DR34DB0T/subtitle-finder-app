// demo.ts — sample data used when no OPENSUBTITLES_API_KEY is configured.
//
// It mimics the real API (same function names and return types as api.ts)
// so you can try every screen of the app before you have a key. Some
// subtitles are deliberately "missing" or "broken" so you can also see how
// errors end up in summary.txt. As soon as the API key is set, the server
// switches to the real OpenSubtitles API automatically.

import { LANGUAGES, type Season, type SubtitleCandidate, type Title } from '../../src/shared.ts'
import { ApiError } from './api.ts'

interface DemoTitle extends Title {
  seasons?: Season[]
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

const CATALOGUE: DemoTitle[] = [
  { featureId: '9001', title: 'The Lantern Keeper', year: 2019, kind: 'movie', poster: null, seasonsCount: null },
  { featureId: '9002', title: 'Paper Harbour', year: 2022, kind: 'movie', poster: null, seasonsCount: null },
  {
    featureId: '9003',
    title: 'Night Shift Diaries',
    year: 2021,
    kind: 'series',
    poster: null,
    seasonsCount: 2,
    seasons: [
      { season: 1, episodes: range(8) },
      { season: 2, episodes: range(10) },
    ],
  },
  {
    featureId: '9004',
    title: 'Orbital Kitchen',
    year: 2024,
    kind: 'series',
    poster: null,
    seasonsCount: 1,
    seasons: [{ season: 1, episodes: range(6) }],
  },
]

const LANG_CODES = Object.keys(LANGUAGES)

/** File ids encode everything we need to fake the download later. */
function encodeFileId(featureIdx: number, season: number, episode: number, langIdx: number): number {
  return 7_000_000_000 + featureIdx * 10_000_000 + season * 100_000 + episode * 100 + langIdx
}

function decodeFileId(fileId: number) {
  let n = fileId - 7_000_000_000
  const featureIdx = Math.floor(n / 10_000_000)
  n %= 10_000_000
  const season = Math.floor(n / 100_000)
  n %= 100_000
  return { featureIdx, season, episode: Math.floor(n / 100), langIdx: n % 100 }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function searchTitles(query: string, kind: 'all' | 'movie' | 'series'): Promise<Title[]> {
  await pause(300)
  const q = query.toLowerCase()
  if (q.includes('nothing')) return [] // type "nothing" to see the empty state
  const byKind = CATALOGUE.filter((t) => kind === 'all' || t.kind === kind)
  const matches = byKind.filter((t) => t.title.toLowerCase().includes(q))
  // In demo mode we show the whole sample catalogue if nothing matches,
  // so any search shows something.
  return (matches.length ? matches : byKind).map(({ seasons: _seasons, ...t }) => t)
}

export async function getSeasons(featureId: string): Promise<Season[]> {
  await pause(200)
  const t = CATALOGUE.find((c) => c.featureId === featureId)
  if (!t) throw new ApiError('not_found', 'Unknown title.', 404)
  return t.seasons ?? []
}

export async function findSubtitles(params: {
  featureId: string
  kind: 'movie' | 'series'
  season: number | null
  languages: string[]
}): Promise<SubtitleCandidate[]> {
  await pause(250)
  const featureIdx = CATALOGUE.findIndex((c) => c.featureId === params.featureId)
  const t = CATALOGUE[featureIdx]
  if (!t) return []

  const out: SubtitleCandidate[] = []
  for (const language of params.languages) {
    const langIdx = LANG_CODES.indexOf(language)
    if (t.kind === 'movie') {
      out.push({
        fileId: encodeFileId(featureIdx, 0, 0, langIdx),
        language,
        season: null,
        episode: null,
        episodeTitle: null,
        release: `${t.title.replace(/ /g, '.')}.${t.year}.1080p.WEB`,
        downloads: 12000 - langIdx * 300,
      })
      continue
    }
    const season = t.seasons?.find((s) => s.season === params.season)
    for (const episode of season?.episodes ?? []) {
      // Pretend that episode 4 has no subtitles in anything but English.
      if (episode === 4 && language !== 'en') continue
      out.push({
        fileId: encodeFileId(featureIdx, season!.season, episode, langIdx),
        language,
        season: season!.season,
        episode,
        episodeTitle: `Episode ${episode}`,
        release: `${t.title.replace(/ /g, '.')}.S${pad(season!.season)}E${pad(episode)}.720p.WEB`,
        downloads: 5000 - episode * 50,
      })
    }
  }
  return out
}

export async function downloadSubtitle(fileId: number): Promise<{ content: string; remaining: number | null }> {
  await pause(150)
  const { featureIdx, season, episode, langIdx } = decodeFileId(fileId)
  const t = CATALOGUE[featureIdx]
  if (!t) throw new ApiError('not_found', 'Unknown subtitle file.', 404)
  // Pretend one file is broken so the summary shows a download failure.
  if (season === 1 && episode === 6) {
    throw new ApiError('upstream', 'OpenSubtitles returned an error (HTTP 500). [demo failure]', 502)
  }

  const language = LANGUAGES[LANG_CODES[langIdx]] ?? 'Unknown'
  const label = t.kind === 'movie' ? `${t.title} (${t.year})` : `${t.title} S${pad(season)}E${pad(episode)}`
  const lines = [
    `[DEMO SUBTITLE — ${language}]`,
    `${label}`,
    'This is sample text generated in demo mode.',
    'Set OPENSUBTITLES_API_KEY to download real subtitles.',
    '…the lantern flickers in the harbour fog.',
    'Did you hear that?',
    'Just the wind. Go back to sleep.',
    'Something is moving out on the water.',
  ]
  const content = lines
    .map((text, i) => `${i + 1}\n${time(i * 4 + 1)} --> ${time(i * 4 + 3.5)}\n${text}\n`)
    .join('\n')
  return { content, remaining: null }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function time(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms % 1000).padStart(3, '0')}`
}
