import 'dotenv/config';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { ProxyAgent } from 'undici';

const root = new URL('../', import.meta.url);
const candidatePath = new URL('data/tokyo_neighborhood_index.json', root);
const geometryPath = new URL('data/tokyo_area_index.json', root);
const endpoint = 'https://places.googleapis.com/v1/places:searchText';
const fieldMask = 'places.id,places.displayName,places.location';
const tokyoBounds = { minLat: 35.4, maxLat: 35.9, minLng: 139.4, maxLng: 140.0 };
const concurrency = 3;
const pauseMs = 220;
let proxyAgent;

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function matchesArea(displayName, area) {
  const haystack = normalize(displayName);
  const keys = [area.name, ...(area.aliases ?? []), ...(area.anchors ?? [])]
    .map(normalize).filter((value) => value.length >= 3);
  return keys.some((key) => haystack.includes(key) || key.includes(haystack));
}

function radiusFor(area) {
  const name = `${area.name} ${(area.aliases ?? []).join(' ')}`;
  if (/公園|池|庭園|河川|臨海|遊園/.test(name)) return 550;
  if (/通り|商店街|銀座|横丁|宿|三角地帯|旧東海道/.test(name)) return 400;
  return 350;
}

async function search(area, query = `${area.name} ${(area.ward ?? []).join(' ')} 東京都 日本`) {
  const dispatcher = process.env.HTTPS_PROXY
    ? (proxyAgent ??= new ProxyAgent(process.env.HTTPS_PROXY.trim()))
    : undefined;
  const response = await fetch(endpoint, {
    method: 'POST',
    dispatcher,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'ja', regionCode: 'JP', maxResultCount: 3 }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `Places HTTP ${response.status}`);
  const places = body.places ?? [];
  const match = places.find((place) => matchesArea(place.displayName?.text, area));
  if (!match?.location) return { query, status: places.length ? 'ambiguous_no_name_match' : 'no_result' };
  const { latitude: lat, longitude: lng } = match.location;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < tokyoBounds.minLat || lat > tokyoBounds.maxLat
    || lng < tokyoBounds.minLng || lng > tokyoBounds.maxLng) {
    return { query, status: 'outside_tokyo_bounds', resolved_name: match.displayName?.text };
  }
  return { query, status: 'verified_name_match', resolved_name: match.displayName?.text, center: { lat, lng } };
}

const candidates = JSON.parse(await readFile(candidatePath, 'utf8'));
const current = JSON.parse(await readFile(geometryPath, 'utf8'));
const retryUnresolved = process.argv.includes('--retry-unresolved');
const pending = candidates.areas.filter((area) => {
  const existing = current.areas.find((item) => item.id === area.id);
  return !existing || (retryUnresolved && existing.active === false);
});
if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error('GOOGLE_MAPS_API_KEY is not configured.');
if (!pending.length) {
  console.log(JSON.stringify({ candidate_count: candidates.areas.length, already_mapped: current.areas.length, searched: 0 }));
  process.exit(0);
}

const results = new Array(pending.length);
let cursor = 0;
async function worker() {
  while (cursor < pending.length) {
    const index = cursor++;
    const area = pending[index];
    let result;
    const ward = (area.ward ?? []).join(' ');
    const queries = [`${area.name} ${ward} 東京都 日本`, ...(area.anchors ?? []).slice(0, 2).map((anchor) => `${anchor} ${ward} 東京都 日本`)];
    for (const query of queries) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await search(area, query);
          break;
        } catch (error) {
          if (attempt === 2) result = { query, status: 'request_failed', error: error.message };
          else await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (result?.center || result?.status === 'request_failed') break;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    results[index] = { source: area, result };
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

const appended = results.map(({ source, result }) => ({
  id: source.id,
  name: source.name,
  ward: source.ward,
  aliases: source.aliases ?? [],
  anchors: source.anchors ?? [],
  ...(source.imagery_area ? { imagery_area: source.imagery_area } : {}),
  active: result.status === 'verified_name_match',
  center: result.center ?? null,
  radius_m: result.center ? radiusFor(source) : null,
  coordinate_source: 'google_places_text_search',
  resolution_status: result.status,
  resolved_name: result.resolved_name ?? null,
  coordinate_query: result.query,
  ...(result.error ? { resolution_error: result.error } : {}),
  ...(result.center ? { radius_source: 'mvp_heuristic', radius_status: 'needs_route_calibration' } : {}),
}));
const next = {
  ...current,
  coverage: 'candidate_100_geocoded',
  candidate_area_count: candidates.areas.length,
  coordinate_note: 'Google Places text-search centers are provisional neighborhood anchors, not authoritative boundaries. Active radii are heuristic and require route calibration; unresolved entries are retained but excluded from matching.',
  areas: [...current.areas.filter((area) => !appended.some((nextArea) => nextArea.id === area.id)), ...appended],
};
const tempPath = new URL('data/tokyo_area_index.json.tmp', root);
await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
await rename(tempPath, geometryPath);
const counts = appended.reduce((acc, area) => {
  acc[area.resolution_status] = (acc[area.resolution_status] ?? 0) + 1;
  return acc;
}, {});
console.log(JSON.stringify({ candidate_count: candidates.areas.length, prior_mapped: current.areas.length, searched: pending.length, total_records: next.areas.length, active_total: next.areas.filter((area) => area.active !== false && area.center).length, counts, unresolved: appended.filter((area) => !area.active).map((area) => ({ id: area.id, name: area.name, status: area.resolution_status })) }, null, 2));
