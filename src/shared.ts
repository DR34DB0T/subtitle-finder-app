// shared.ts
// Types and constants used by BOTH the browser code (src/) and the
// server code (netlify/server/). Keeping them in one place means the two
// sides always agree on the shape of the data they exchange.

/** Languages the user can pick. Codes are the ones OpenSubtitles uses. */
export const LANGUAGES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  'pt-PT': 'Portuguese',
  'pt-BR': 'Portuguese (Brazil)',
  nl: 'Dutch',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  pl: 'Polish',
  cs: 'Czech',
  hu: 'Hungarian',
  ro: 'Romanian',
  el: 'Greek',
  tr: 'Turkish',
  ru: 'Russian',
  uk: 'Ukrainian',
  ar: 'Arabic',
  he: 'Hebrew',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  id: 'Indonesian',
  vi: 'Vietnamese',
  th: 'Thai',
}

/** Most languages you can request in one go (keeps API usage reasonable). */
export const MAX_LANGUAGES = 5

export type MediaKind = 'movie' | 'series'

/** One search result: a movie or a TV series. */
export interface Title {
  featureId: string
  title: string
  year: number | null
  kind: MediaKind
  poster: string | null
  seasonsCount: number | null
}

/** A season of a series and the episode numbers it contains. */
export interface Season {
  season: number
  episodes: number[]
}

/** The best subtitle file found for one language (and one episode, for series). */
export interface SubtitleCandidate {
  fileId: number
  language: string
  season: number | null
  episode: number | null
  episodeTitle: string | null
  release: string
  downloads: number
}

/** Error codes the server can send back. The UI turns them into friendly messages. */
export type ErrorCode =
  | 'invalid_key'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'not_found'
  | 'network'
  | 'bad_request'
  | 'upstream'

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; retryAfter?: number }
}
