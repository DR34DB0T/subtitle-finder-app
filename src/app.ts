// app.ts — the user interface. It wires the page together:
//   • language + format settings (remembered in localStorage)
//   • search box and results
//   • series dialog (pick seasons and episodes)
//   • batch queue
//   • progress display while downloader.ts runs
//   • review list with previews, then zipper.ts builds the ZIP

import './styles.css'
import { api, ClientError } from './client.ts'
import { FatalError, runQueue, type DownloadedFile, type Failure, type QueueItem } from './downloader.ts'
import { LANGUAGES, MAX_LANGUAGES, type Season, type Title } from './shared.ts'
import { buildZip, fileNameFor, folderFor, previewLines, type SubtitleFormat } from './zipper.ts'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** Escapes text before putting it into HTML (prevents broken markup / XSS). */
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Reads/writes JSON in localStorage without ever crashing. */
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage full or disabled: not important */
    }
  },
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  languages: store.get<string[]>('sf.languages', ['en']).filter((l) => l in LANGUAGES),
  format: store.get<SubtitleFormat>('sf.format', 'srt'),
  queue: store.get<QueueItem[]>('sf.queue', []),
  results: [] as Title[],
  files: [] as DownloadedFile[],
  failures: [] as Failure[],
  excluded: new Set<string>(),
  running: false,
  abort: null as AbortController | null,
  zipUrl: null as string | null,
}
if (state.languages.length === 0) state.languages = ['en']

const saveQueue = () => store.set('sf.queue', state.queue)

function friendly(err: unknown): string {
  if (err instanceof ClientError || err instanceof Error) return err.message
  return 'Something went wrong.'
}

// ---------------------------------------------------------------------------
// Status pill (demo mode vs. real API)
// ---------------------------------------------------------------------------
async function loadStatus() {
  const el = $('status')
  try {
    const s = await api.status()
    if (s.demo) {
      el.className = 'status demo'
      el.innerHTML = '<strong>Demo mode</strong> sample data — set <code>OPENSUBTITLES_API_KEY</code> for real subtitles'
    } else {
      el.className = 'status live'
      el.innerHTML = `<strong>Connected</strong> to OpenSubtitles${s.loggedIn ? ' · logged in' : ' · anonymous (low download quota)'}`
    }
  } catch {
    el.className = 'status error'
    el.textContent = 'Server unreachable'
  }
}

// ---------------------------------------------------------------------------
// Settings: languages and format
// ---------------------------------------------------------------------------
function renderLanguages() {
  $('languages').innerHTML = Object.entries(LANGUAGES)
    .map(
      ([code, name]) =>
        `<button type="button" class="chip" data-lang="${esc(code)}" aria-pressed="${state.languages.includes(code)}">${esc(name)}</button>`,
    )
    .join('')
  $('lang-count').textContent = `${state.languages.length} of max ${MAX_LANGUAGES} selected · remembered`
}

$('languages').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-lang]')
  if (!btn || state.running) return
  const code = btn.dataset.lang!
  if (state.languages.includes(code)) {
    if (state.languages.length === 1) return flash($('lang-count'), 'Keep at least one language.')
    state.languages = state.languages.filter((l) => l !== code)
  } else {
    if (state.languages.length >= MAX_LANGUAGES) return flash($('lang-count'), `Max ${MAX_LANGUAGES} languages at once.`)
    state.languages.push(code)
  }
  store.set('sf.languages', state.languages)
  renderLanguages()
})

function flash(el: HTMLElement, msg: string) {
  el.textContent = msg
  el.classList.add('warn')
  setTimeout(() => {
    el.classList.remove('warn')
    renderLanguages()
  }, 1800)
}

document.querySelectorAll<HTMLInputElement>('input[name="format"]').forEach((input) => {
  input.checked = input.value === state.format
  input.addEventListener('change', () => {
    state.format = input.value as SubtitleFormat
    store.set('sf.format', state.format)
    if (state.files.length) renderReview()
  })
})

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const q = $<HTMLInputElement>('q').value.trim()
  const type = $<HTMLSelectElement>('type').value as 'all' | 'movie' | 'series'
  const errorEl = $('search-error')
  errorEl.textContent = ''

  // Validate before calling the server.
  if (q.length < 2) {
    errorEl.textContent = 'Type at least 2 characters.'
    return
  }

  $('results').innerHTML = Array.from({ length: 4 }, () => '<div class="card skeleton"><div class="poster"></div><div class="lines"><i></i><i></i></div></div>').join('')
  try {
    state.results = await api.search(q, type)
    renderResults(q)
  } catch (err) {
    $('results').innerHTML = ''
    errorEl.textContent = friendly(err)
  }
})

function posterHtml(t: { poster: string | null; title: string; kind: string }) {
  if (t.poster) return `<img src="${esc(t.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
  const initials = t.title.split(/\s+/).slice(0, 2).map((w) => w[0]).join('')
  return `<span class="poster-fallback ${t.kind}">${esc(initials)}</span>`
}

function renderResults(q: string) {
  const el = $('results')
  if (state.results.length === 0) {
    el.innerHTML = `<div class="empty"><span class="mono">[ no results ]</span><p>Nothing found for “${esc(q)}”. Check the spelling, try the original title, or switch the type filter.</p></div>`
    return
  }
  el.innerHTML = state.results
    .map((t, i) => {
      const inQueue = state.queue.some((q) => q.featureId === t.featureId)
      const meta = [t.year ?? 'Year unknown', t.kind === 'series' && t.seasonsCount ? `${t.seasonsCount} seasons` : null]
        .filter(Boolean)
        .join(' · ')
      return `<article class="card" style="--i:${i}">
        <div class="poster">${posterHtml(t)}</div>
        <div class="card-body">
          <span class="badge ${t.kind}">${t.kind === 'movie' ? 'Movie' : 'Series'}</span>
          <h3>${esc(t.title)}</h3>
          <p class="mono">${esc(meta)}</p>
          <button class="btn small ${inQueue ? 'ghost' : 'primary'}" data-add="${i}" type="button">
            ${inQueue ? 'Add again' : t.kind === 'series' ? 'Choose episodes…' : 'Add to queue'}
          </button>
        </div>
      </article>`
    })
    .join('')
}

$('results').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-add]')
  if (!btn) return
  const title = state.results[Number(btn.dataset.add)]
  if (!title) return
  if (title.kind === 'movie') {
    addToQueue({ ...baseItem(title), seasons: [], episodes: { mode: 'all' }, knownEpisodes: {} })
  } else {
    openSeriesDialog(title)
  }
})

const baseItem = (t: Title) => ({
  id: `${t.featureId}-${Date.now().toString(36)}`,
  featureId: t.featureId,
  title: t.title,
  year: t.year,
  kind: t.kind,
  poster: t.poster,
})

// ---------------------------------------------------------------------------
// Series dialog
// ---------------------------------------------------------------------------
let dialogTitle: Title | null = null
let dialogSeasons: Season[] = []

async function openSeriesDialog(title: Title) {
  dialogTitle = title
  dialogSeasons = []
  $('series-title').textContent = `${title.title}${title.year ? ` (${title.year})` : ''}`
  $('series-error').textContent = ''
  const picker = $('season-picker')
  picker.innerHTML = '<div class="skeleton-row"></div>'
  $<HTMLDialogElement>('series-dialog').showModal()

  try {
    dialogSeasons = await api.seasons(title.featureId)
  } catch {
    dialogSeasons = [] // fall back to typing the season numbers by hand
  }
  if (dialogTitle !== title) return

  if (dialogSeasons.length) {
    picker.innerHTML =
      `<label class="chip-check all"><input type="checkbox" id="all-seasons" /> <span>All seasons</span></label>` +
      dialogSeasons
        .map(
          (s) =>
            `<label class="chip-check"><input type="checkbox" name="season" value="${s.season}" ${s.season === 1 ? 'checked' : ''} /> <span>S${String(s.season).padStart(2, '0')} <small>${s.episodes.length} ep</small></span></label>`,
        )
        .join('')
    $('all-seasons').addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked
      picker.querySelectorAll<HTMLInputElement>('input[name="season"]').forEach((c) => (c.checked = on))
    })
  } else {
    picker.innerHTML = `<label class="manual">Season numbers <input id="season-text" type="text" value="1" placeholder="e.g. 1-3, 5" /></label>
      <p class="hint">OpenSubtitles didn't list this show's seasons, so type them in (e.g. <span class="mono">1-3, 5</span>).</p>`
  }
}

/** Parses "1-3, 5" into [1, 2, 3, 5]. Returns null when the text is invalid. */
function parseSeasonText(text: string): number[] | null {
  const out = new Set<number>()
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,3})(?:\s*-\s*(\d{1,3}))?$/)
    if (!m) return null
    const from = Number(m[1])
    const to = Number(m[2] ?? m[1])
    if (from < 1 || to < from || to > 100) return null
    for (let s = from; s <= to; s++) out.add(s)
  }
  return out.size ? [...out].sort((a, b) => a - b) : null
}

$('series-cancel').addEventListener('click', () => $<HTMLDialogElement>('series-dialog').close())

// Typing in the range boxes selects the "range" option automatically.
;['ep-from', 'ep-to'].forEach((id) =>
  $(id).addEventListener('focus', () => {
    document.querySelector<HTMLInputElement>('input[name="ep-mode"][value="range"]')!.checked = true
  }),
)

$('series-form').addEventListener('submit', (e) => {
  e.preventDefault()
  if (!dialogTitle) return
  const errorEl = $('series-error')

  // Seasons
  let seasons: number[] | null
  if (dialogSeasons.length) {
    seasons = [...document.querySelectorAll<HTMLInputElement>('input[name="season"]:checked')].map((c) => Number(c.value))
    if (seasons.length === 0) seasons = null
  } else {
    seasons = parseSeasonText($<HTMLInputElement>('season-text').value)
  }
  if (!seasons) {
    errorEl.textContent = 'Pick at least one valid season.'
    return
  }

  // Episodes
  const mode = document.querySelector<HTMLInputElement>('input[name="ep-mode"]:checked')!.value
  let episodes: QueueItem['episodes'] = { mode: 'all' }
  if (mode === 'range') {
    const from = Number($<HTMLInputElement>('ep-from').value)
    const to = Number($<HTMLInputElement>('ep-to').value)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 999) {
      errorEl.textContent = 'Enter a valid episode range, e.g. 1 to 5.'
      return
    }
    episodes = { mode: 'range', from, to }
  }

  const knownEpisodes: Record<number, number[]> = {}
  for (const s of dialogSeasons) knownEpisodes[s.season] = s.episodes

  addToQueue({ ...baseItem(dialogTitle), seasons, episodes, knownEpisodes })
  $<HTMLDialogElement>('series-dialog').close()
})

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function addToQueue(item: QueueItem) {
  if (state.queue.length >= 50) {
    $('start-error').textContent = 'The queue is limited to 50 titles.'
    return
  }
  state.queue.push(item)
  saveQueue()
  renderQueue()
  renderResults($<HTMLInputElement>('q').value.trim())
}

function describeItem(item: QueueItem): string {
  if (item.kind === 'movie') return item.year ? `Movie · ${item.year}` : 'Movie'
  const seasons = item.seasons.length > 4 ? `${item.seasons.length} seasons` : item.seasons.map((s) => `S${String(s).padStart(2, '0')}`).join(' ')
  const eps = item.episodes.mode === 'all' ? 'all episodes' : `ep ${item.episodes.from}–${item.episodes.to}`
  return `${seasons} · ${eps}`
}

function renderQueue() {
  const list = $('queue-list')
  $<HTMLButtonElement>('start').disabled = state.running || state.queue.length === 0
  if (state.queue.length === 0) {
    list.innerHTML = `<li class="queue-empty"><span class="mono">— empty reel —</span>Search for a title and add it here. Add as many as you like; they all go into one ZIP.</li>`
    return
  }
  list.innerHTML = state.queue
    .map(
      (item) => `<li>
        <div class="q-title"><strong>${esc(item.title)}</strong><span class="mono">${esc(describeItem(item))}</span></div>
        <button class="icon-btn" data-remove="${esc(item.id)}" aria-label="Remove ${esc(item.title)}" type="button" ${state.running ? 'disabled' : ''}>×</button>
      </li>`,
    )
    .join('')
}

$('queue-list').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]')
  if (!btn || state.running) return
  state.queue = state.queue.filter((q) => q.id !== btn.dataset.remove)
  saveQueue()
  renderQueue()
})

$('clear-queue').addEventListener('click', () => {
  if (state.running) return
  state.queue = []
  saveQueue()
  renderQueue()
})

// ---------------------------------------------------------------------------
// Run: download everything with a progress indicator
// ---------------------------------------------------------------------------
$('start').addEventListener('click', async () => {
  $('start-error').textContent = ''
  if (state.queue.length === 0) return
  if (state.languages.length === 0) {
    $('start-error').textContent = 'Choose at least one language.'
    return
  }

  // Forget the previous batch (our in-memory "temp folder").
  resetBatch()
  state.running = true
  state.abort = new AbortController()
  renderQueue()

  const run = $('run')
  run.hidden = false
  $('run-title').textContent = 'Finding subtitles…'
  run.scrollIntoView({ behavior: 'smooth', block: 'center' })

  try {
    const { files, failures } = await runQueue(
      state.queue,
      [...state.languages],
      (p) => {
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
        $('progress-bar').style.transform = `scaleX(${pct / 100})`
        run.querySelector('.progress')!.setAttribute('aria-valuenow', String(pct))
        $('progress-count').textContent = `${p.done} / ${p.total}`
        $('progress-msg').textContent = p.message
        $('run-title').textContent = p.phase === 'lookup' ? 'Finding subtitles…' : 'Downloading subtitles…'
      },
      state.abort.signal,
    )
    state.files = files
    state.failures = failures
    run.hidden = true
    renderReview()
  } catch (err) {
    $('run-title').textContent = err instanceof FatalError && err.message === 'Cancelled.' ? 'Cancelled' : 'Stopped'
    $('progress-msg').textContent = friendly(err)
  } finally {
    state.running = false
    state.abort = null
    renderQueue()
  }
})

$('cancel').addEventListener('click', () => state.abort?.abort())

function resetBatch() {
  state.files = []
  state.failures = []
  state.excluded.clear()
  if (state.zipUrl) URL.revokeObjectURL(state.zipUrl)
  state.zipUrl = null
  $('review').hidden = true
  $('zip-link').hidden = true
}

// ---------------------------------------------------------------------------
// Review: preview, include/exclude, build the ZIP
// ---------------------------------------------------------------------------
function renderReview() {
  const review = $('review')
  review.hidden = false
  const included = state.files.filter((f) => !state.excluded.has(f.id))
  $('review-meta').textContent = `${included.length} of ${state.files.length} file(s) selected · ${state.failures.length} failed or missing`
  $<HTMLButtonElement>('build-zip').disabled = false

  if (state.files.length === 0) {
    $('review-list').innerHTML = `<div class="empty"><span class="mono">[ nothing downloaded ]</span><p>No subtitles could be downloaded. You can still build a ZIP containing summary.txt, which explains what failed.</p></div>`
  } else {
    // Group files by their folder inside the ZIP.
    const groups = new Map<string, DownloadedFile[]>()
    for (const f of state.files) {
      const folder = folderFor(f)
      groups.set(folder, [...(groups.get(folder) ?? []), f])
    }
    $('review-list').innerHTML = [...groups.entries()]
      .map(
        ([folder, files]) => `<div class="group">
          <h3 class="mono">${esc(folder)}/</h3>
          ${files
            .map(
              (f) => `<div class="file ${state.excluded.has(f.id) ? 'off' : ''}">
                <label class="file-row">
                  <input type="checkbox" data-include="${esc(f.id)}" ${state.excluded.has(f.id) ? '' : 'checked'} />
                  <span class="file-name">${esc(fileNameFor(f, state.format))}</span>
                  <span class="file-release mono">${esc(f.release)}</span>
                </label>
                <button class="btn ghost small" type="button" data-preview="${esc(f.id)}">Preview</button>
                <pre class="preview" id="pv-${esc(f.id)}" hidden></pre>
              </div>`,
            )
            .join('')}
        </div>`,
      )
      .join('')
  }

  const failuresEl = $<HTMLDetailsElement>('failures')
  failuresEl.hidden = state.failures.length === 0
  failuresEl.querySelector('summary')!.textContent = `${state.failures.length} failed or missing (listed in summary.txt)`
  $('failure-list').innerHTML = state.failures
    .map((f) => `<li><strong>${esc(f.title)}</strong> — ${esc(f.what)}: <span>${esc(f.reason)}</span></li>`)
    .join('')
  review.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

$('review-list').addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement
  if (!box.dataset.include) return
  if (box.checked) state.excluded.delete(box.dataset.include)
  else state.excluded.add(box.dataset.include)
  box.closest('.file')!.classList.toggle('off', !box.checked)
  const included = state.files.length - state.excluded.size
  $('review-meta').textContent = `${included} of ${state.files.length} file(s) selected · ${state.failures.length} failed or missing`
})

$('review-list').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-preview]')
  if (!btn) return
  const file = state.files.find((f) => f.id === btn.dataset.preview)
  const pre = document.getElementById(`pv-${btn.dataset.preview}`)
  if (!file || !pre) return
  if (pre.hidden) {
    const lines = previewLines(file.content)
    pre.textContent = lines.length ? lines.join('\n') : '(no readable text found in this file)'
  }
  pre.hidden = !pre.hidden
  btn.textContent = pre.hidden ? 'Preview' : 'Hide'
})

$('build-zip').addEventListener('click', () => {
  const included = state.files.filter((f) => !state.excluded.has(f.id))
  const excluded = state.files.filter((f) => state.excluded.has(f.id))
  const blob = buildZip(included, state.failures, excluded, state.format)

  if (state.zipUrl) URL.revokeObjectURL(state.zipUrl)
  state.zipUrl = URL.createObjectURL(blob)
  const name = state.queue.length === 1 ? `${state.queue[0].title} subtitles.zip` : `subtitles-${new Date().toISOString().slice(0, 10)}.zip`

  const link = $<HTMLAnchorElement>('zip-link')
  link.href = state.zipUrl
  link.download = name
  link.hidden = false
  link.click() // start the download straight away
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// Drop queue items saved by older versions or edited by hand.
state.queue = state.queue.filter((q) => q && q.featureId && q.title && (q.kind === 'movie' || q.kind === 'series'))
renderLanguages()
renderQueue()
loadStatus()
