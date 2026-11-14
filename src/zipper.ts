// zipper.ts — names files cleanly, sorts them into folders and builds the ZIP.
//
// The ZIP is built entirely in your browser's memory with the small `fflate`
// library, so nothing is ever written to a temp folder on a server: when the
// page is closed (or you start a new batch) everything is gone.
//
// Layout inside the ZIP:
//   Show Name/Season 01/Show Name S01E03 - English.srt
//   Movie Name (2019)/Movie Name (2019) - French.srt
//   summary.txt

import { strToU8, zipSync, type Zippable } from 'fflate'
import { episodeLabel, languageName, type DownloadedFile, type Failure } from './downloader.ts'

export type SubtitleFormat = 'srt' | 'vtt'

/** Removes characters that are not allowed in file names on Windows/macOS/Linux. */
export function safeName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '') || 'Untitled'
  )
}

/** "Movie Name (2019)" or just "Show Name". */
function displayTitle(file: DownloadedFile): string {
  const { title, year, kind } = file.item
  return kind === 'movie' && year ? `${title} (${year})` : title
}

/** Folder path inside the ZIP for a file. */
export function folderFor(file: DownloadedFile): string {
  const base = safeName(displayTitle(file))
  if (file.item.kind === 'series') return `${base}/Season ${String(file.season ?? 0).padStart(2, '0')}`
  return base
}

/** Clean file name, e.g. "Show Name S01E03 - English.srt". */
export function fileNameFor(file: DownloadedFile, format: SubtitleFormat): string {
  const main =
    file.item.kind === 'series'
      ? `${file.item.title} ${episodeLabel(file.season, file.episode)}`
      : displayTitle(file)
  return `${safeName(`${main} - ${languageName(file.language)}`)}.${format}`
}

/**
 * Converts SubRip (.srt) text to WebVTT (.vtt).
 * The two formats are almost identical: VTT needs a "WEBVTT" header and uses
 * a dot instead of a comma in timestamps (00:00:01.000 instead of 00:00:01,000).
 */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '') // remove a byte-order mark, if any
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${body.trim()}\n`
}

/** The first few lines of dialogue, for the preview (skips numbers and timestamps). */
export function previewLines(srt: string, count = 6): string[] {
  return srt
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l) => l && !/^\d+$/.test(l) && !l.includes('-->'))
    .slice(0, count)
}

/** Human-readable report of what was included and what failed. */
export function buildSummary(included: DownloadedFile[], failures: Failure[], excluded: DownloadedFile[], format: SubtitleFormat): string {
  const lines: string[] = []
  lines.push('SUBTITLE FINDER — SUMMARY', `Created: ${new Date().toLocaleString()}`, `Format: .${format}`, '')
  lines.push(`Included: ${included.length} file(s)`)
  for (const f of included) lines.push(`  ✓ ${folderFor(f)}/${fileNameFor(f, format)}   [${f.release}]`)
  lines.push('')

  lines.push(`Failed or missing: ${failures.length}`)
  if (failures.length === 0) lines.push('  (none)')
  for (const f of failures) lines.push(`  ✗ ${f.title} — ${f.what}: ${f.reason}`)
  lines.push('')

  if (excluded.length) {
    lines.push(`Left out by you after preview: ${excluded.length}`)
    for (const f of excluded) lines.push(`  – ${fileNameFor(f, format)}`)
    lines.push('')
  }
  lines.push('Subtitles provided by OpenSubtitles.com')
  return lines.join('\n')
}

/** Builds the final ZIP file and returns it as a Blob ready to download. */
export function buildZip(
  included: DownloadedFile[],
  failures: Failure[],
  excluded: DownloadedFile[],
  format: SubtitleFormat,
): Blob {
  const entries: Zippable = {}
  const used = new Set<string>()

  for (const file of included) {
    let path = `${folderFor(file)}/${fileNameFor(file, format)}`
    // Avoid two files with the same name overwriting each other.
    for (let n = 2; used.has(path.toLowerCase()); n++) {
      path = `${folderFor(file)}/${fileNameFor(file, format).replace(/\.(srt|vtt)$/, ` (${n}).$1`)}`
    }
    used.add(path.toLowerCase())
    const text = format === 'vtt' ? srtToVtt(file.content) : file.content
    entries[path] = strToU8(text)
  }

  entries['summary.txt'] = strToU8(buildSummary(included, failures, excluded, format))
  const zipped = zipSync(entries, { level: 6 })
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
}
