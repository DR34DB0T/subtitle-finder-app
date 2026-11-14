# Subtitle Finder

Search movies and TV series, choose languages, seasons and episodes, and download all the subtitles as **one tidy ZIP**:

```
Show Name/Season 01/Show Name S01E03 - English.srt
Movie Name (2019)/Movie Name (2019) - French.srt
summary.txt          ← what was included, and what failed or was missing
```

It's hosted on Netlify. A small server keeps your OpenSubtitles API key secret, and your browser builds the ZIP.

## Features

- Search by title. Each result shows its title, year, poster and type (movie or series).
- For series, pick one or more seasons, then either **all episodes** or a range such as 3–7.
- Choose up to 5 languages. The app remembers your choice, and your format, in this browser.
- **Batch queue:** add as many titles as you want and compile them into one ZIP. The queue survives a page reload.
- A progress bar with a live status line, plus a Cancel button.
- Preview the first lines of each subtitle and untick any you don't want before you build the ZIP.
- Optional conversion from **.srt to .vtt**.
- Errors are handled without stopping the batch: no results, network errors (retried), rate limits (it waits and retries), an invalid API key (the run stops with a clear message), a used-up daily quota, and missing episodes. Anything that fails is skipped and listed in `summary.txt`.
- Requests are rate-limited: at least 250 ms apart on the server and 400 ms apart between downloads.

## Setup

### 1. Get an OpenSubtitles API key

1. Create a free account at <https://www.opensubtitles.com>.
2. Open **Profile → API consumers** (<https://www.opensubtitles.com/consumers>) and create a new consumer.
3. Copy its **API key**.

### 2. Add the key to Netlify

In the Netlify UI, go to **Project configuration → Environment variables** and add:

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENSUBTITLES_API_KEY` | yes | Your API key |
| `OPENSUBTITLES_USERNAME` | recommended | Logging in raises the daily download quota |
| `OPENSUBTITLES_PASSWORD` | recommended | Used together with the username |

Then redeploy. Until the key is set, the app runs in **demo mode** with sample titles and subtitles, and a "Demo mode" badge appears at the top. A few sample files are deliberately missing or broken, so you can see what `summary.txt` looks like.

The key is never hardcoded and never sent to the browser.

### 3. Run it locally (optional)

You need Node.js 24 or later.

```bash
npm install
cp .env.example .env          # then put your key in .env
npx netlify dev               # opens http://localhost:8888
```

## How each module works

| File | What it does |
| --- | --- |
| `netlify/server/api.ts` | The OpenSubtitles client. It searches titles, lists the seasons of a series, finds the best subtitle for each language and episode (by download count, preferring human translations), and downloads `.srt` files. It also handles rate limiting, the optional login, and turning HTTP errors into friendly ones. |
| `netlify/server/demo.ts` | Sample data with the same functions as `api.ts`. It's used automatically when no API key is set. |
| `netlify/server/index.ts` | The web server (Hono). It exposes `/api/search`, `/api/seasons/:id`, `/api/subtitles` and `/api/download`, and checks every input before using it. |
| `src/downloader.ts` | Works through the queue in two phases: it looks up what's available, then downloads each file with a pause in between. It retries rate-limit and network errors and records anything missing or failed. |
| `src/zipper.ts` | Cleans up file names, builds the folder layout, converts SRT to VTT, writes `summary.txt` and builds the ZIP. |
| `src/app.ts` | The user interface: settings, search, the series dialog, the queue, the progress bar, and the review screen with previews. |
| `src/client.ts`, `src/shared.ts` | A small fetch helper, plus the types and language list shared by the browser and the server. |

**About temp folders:** downloaded subtitles are kept only in the browser's memory, and the ZIP is built there too. Nothing is written to disk on the server, so there's nothing to clean up. Starting a new batch or closing the tab discards everything.

## Note on the tech stack

You asked for Python and Flask, but Netlify can't host a Python server, so the app is written in TypeScript with the same structure: `api` → `downloader` → `zipper` → `app`. `package.json` takes the place of `requirements.txt`, and `.env.example` lists the environment variables.
