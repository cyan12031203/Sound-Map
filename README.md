# Sound-Map

Sound-Map turns a real-world route into a musical journey. It analyzes the route, creates a soundtrack from your NetEase Cloud Music library, and writes a short bilingual Chinese–Japanese poem inspired by the journey.

This is a personal project and an MVP. The repository contains the frontend, the Node.js application, route analysis, and music-selection logic. NetEase Cloud Music API runs as a separate service.

## Features

- Enter an origin, destination, and travel mode: walking, driving, or bicycling. Place search uses Google Places autocomplete.
- Calculate route geometry and duration with Google Routes API, then derive route characteristics from the surrounding roads, neighborhoods, and scenes.
- Use a PEAR (Perceive, Plan, Act, Reflect) workflow with DeepSeek to interpret the route, shape the music strategy, and write a haiku-inspired introduction in Japanese and Chinese.
- Select songs from your NetEase Cloud Music “Liked Songs” playlist using segment-level energy and rhythm targets, while accounting for the total route duration.
- Play tracks, view synchronized lyrics, skip songs, and follow song and route progress.
- Include neighborhood and scene references for Tokyo, plus locally computed audio-feature data.

## Tech Stack

- Node.js 20+, ES modules, and Express 5
- Native HTML, CSS, and JavaScript frontend in `public/`
- Google Routes API and Google Places API (New)
- DeepSeek API
- NeteaseCloudMusicApi, run locally for development and as a private Vercel Service in production

## Repository Structure

```text
public/              Frontend, player, lyrics, and animated background
src/agent/           PEAR orchestration, DeepSeek planner, and music-selection tools
src/services/        Route, place, music metadata, and audio-feature services
services/netease/    Private NetEase API service used by Sound-Map
data/                Tokyo area references, tag guides, and audio-feature cache
scripts/             Audio profiling and route-data helper scripts
test/                Agent tests
files/               Python prototype and related materials, separate from the Node app
```

## Run Locally

### Prerequisites

- Node.js 20 or later
- A Google Maps Platform project with Places API (New) and Routes API enabled, billing configured, and an API key
- A DeepSeek API key
- A NetEase Cloud Music account and a locally running NeteaseCloudMusicApi service

### 1. Install dependencies and configure environment variables

From the repository root, run:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and add your own credentials:

```dotenv
PORT=4100
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
NETEASE_COOKIE=your_netease_cookie
# Local development only. Vercel injects NETEASE_PRIVATE_URL through a service binding.
NETEASE_API_BASE_URL=http://127.0.0.1:3000

# Set this only if your network requires an outbound proxy.
# HTTPS_PROXY=http://127.0.0.1:7890
```

`.env` is listed in `.gitignore`. Never commit or share your API keys, NetEase cookie, logs containing route locations, or other personal credentials.

### 2. Start the NetEase API

In a first terminal at the repository root, run:

```powershell
npm run netease
```

The service listens on `http://127.0.0.1:3000` by default. Complete the NetEase login flow described by NeteaseCloudMusicApi. Sound-Map uses `NETEASE_API_BASE_URL` to request login status, liked songs, playback URLs, and lyrics.

### 3. Start Sound-Map

In a second terminal at the repository root, run:

```powershell
npm run dev
```

Open [http://localhost:4100](http://localhost:4100). You can also start the Express app with `npm start`.

## Deploy to Vercel

The root [`vercel.json`](vercel.json) defines two services: the Sound-Map app and `services/netease/`. The app declares a private binding to the NetEase service. Vercel injects the bound service URL as `NETEASE_PRIVATE_URL` at runtime. The NetEase service has no public rewrite, so it is reachable through the private binding rather than a public endpoint.

1. Push the repository, including `vercel.json` and `services/netease/`, to GitHub.
2. In Vercel, set the project's **Framework Preset** to **Services**, then deploy the latest commit.
3. Configure `GOOGLE_MAPS_API_KEY`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, and `NETEASE_COOKIE` as Vercel environment variables. Add them to Preview too if you use preview deployments.
4. Do not manually set `NETEASE_PRIVATE_URL`; Vercel injects it from the binding. Do not set `NETEASE_API_BASE_URL` to localhost in production.
5. If you previously configured `NPM_CONFIG_CACHE`, `npm_config_cache`, or `cache-dir` to point to a directory on your computer, remove that setting from Vercel. The build container cannot access your local npm cache.
6. After deployment, check `/api/health`, then try route generation and playback.

Vercel Services are currently in Beta. See the [Vercel Services guide](https://vercel.com/kb/guide/vercel-services) for service definitions, rewrites, and private bindings.

## API

All `POST` endpoints accept JSON.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/places/autocomplete?q=...&sessionToken=...` | Place autocomplete |
| `GET` | `/api/places/details?placeId=...&sessionToken=...` | Retrieve place coordinates and address |
| `POST` | `/api/route` | Calculate a route and its characteristics |
| `GET` | `/api/music/liked` | Read the NetEase Cloud Music “Liked Songs” playlist |
| `GET` | `/api/music/playback/:songId` | Retrieve a playback URL and lyrics |
| `POST` | `/api/agent/mixtape` | Generate and return a complete route mixtape |
| `POST` | `/api/agent/mixtape/stream` | Stream generation updates and the final result using Server-Sent Events |

Example route request:

```json
{
  "origin": "Shibuya Station, Tokyo",
  "destination": "Daikanyama Station, Tokyo",
  "mode": "walking"
}
```

`mode` can be `walking`, `driving`, or `bicycling`. You can also include `originLocation` and `destinationLocation`, each with `latitude` and `longitude` fields.

## Tests and Helper Scripts

Run the automated tests:

```powershell
npm test
```

Inspect the audio profiling script options:

```powershell
npm run audio:profile -- --help
```

Audio profiling accesses NetEase audio URLs and writes to `data/song-audio-features.json`. Avoid sending many requests in a short period, as the upstream service may rate-limit them. Audio-analysis results are not used as a song-selection priority signal.

## Third-Party Services and Rights

Google Maps Platform, DeepSeek, NetEase Cloud Music, and NeteaseCloudMusicApi each have their own terms and usage limits. Follow the applicable terms, copyright requirements, and API policies. This repository does not include a commercial music license.
