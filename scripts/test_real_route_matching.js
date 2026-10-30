import 'dotenv/config';
import { ProxyAgent } from 'undici';
import { buildRouteContext, planRoutePlaceSampleRatios } from '../src/services/route-context.js';
import { decodePolyline } from '../src/services/route-segments.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline';
const cases = [
  { id: 'single-jimbocho', scope: '单区域短距离', origin: '神保町駅, 東京都千代田区', destination: 'すずらん通り, 東京都千代田区' },
  { id: 'jimbocho-ochanomizu', scope: '相邻跨区域', origin: '神保町駅, 東京都千代田区', destination: '御茶ノ水駅, 東京都文京区' },
  { id: 'yanaka-nezu', scope: '老街跨区域', origin: '谷中銀座商店街, 東京都台東区', destination: '根津神社, 東京都文京区' },
  { id: 'shibuya-roppongi', scope: '中心城区跨区域', origin: '渋谷スクランブル交差点, 東京都渋谷区', destination: '六本木交差点, 東京都港区' },
  { id: 'shinjuku-ikebukuro', scope: '长路线／中途覆盖空白', origin: '新宿駅東口, 東京都新宿区', destination: '池袋駅東口, 東京都豊島区' },
  { id: 'asakusa-ryogoku', scope: '东部相邻区域', origin: '浅草寺, 東京都台東区', destination: '両国国技館, 東京都墨田区' },
  { id: 'kitasenju-asakusa', scope: '北部至东部多区域', origin: '北千住駅, 東京都足立区', destination: '浅草寺, 東京都台東区' },
  { id: 'ginza-tsukiji', scope: '中央区单区内相邻街区', origin: '銀座四丁目交差点, 東京都中央区', destination: '築地場外市場, 東京都中央区' },
  { id: 'nakano-koenji', scope: '西部相邻区域', origin: '中野駅北口, 東京都中野区', destination: '高円寺駅, 東京都杉並区' },
  { id: 'nakameguro-jiyugaoka', scope: '南部较长路线', origin: '中目黒駅, 東京都目黒区', destination: '自由が丘駅, 東京都目黒区' },
  { id: 'kinshicho-oshiage', scope: '东部短距离', origin: '錦糸町駅, 東京都墨田区', destination: '押上駅, 東京都墨田区' },
  { id: 'shinagawa-togoshi', scope: '南部跨街区', origin: '品川駅高輪口, 東京都港区', destination: '戸越銀座商店街, 東京都品川区' },
];

function durationSeconds(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value ?? '');
  return match ? Math.round(Number(match[1])) : null;
}

async function fetchRoute(testCase) {
  const dispatcher = process.env.HTTPS_PROXY?.trim()
    ? new ProxyAgent(process.env.HTTPS_PROXY.trim())
    : undefined;
  const response = await fetch(ROUTES_URL, {
    method: 'POST',
    dispatcher,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      origin: { address: testCase.origin },
      destination: { address: testCase.destination },
      travelMode: 'WALK',
      languageCode: 'ja-JP',
      units: 'METRIC',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? `Routes HTTP ${response.status}`);
  const route = body.routes?.[0];
  if (!route?.polyline?.encodedPolyline) throw new Error('Google Routes 未返回路线折线。');
  return route;
}

if (!process.env.GOOGLE_MAPS_API_KEY) throw new Error('GOOGLE_MAPS_API_KEY is not configured.');
const results = [];
for (const testCase of cases) {
  try {
    const route = await fetchRoute(testCase);
    const routePoints = decodePolyline(route.polyline.encodedPolyline);
    const sampleRatios = planRoutePlaceSampleRatios(routePoints, undefined, undefined, {
      origin: testCase.origin,
      destination: testCase.destination,
    }, 4);
    const context = buildRouteContext({
      encodedPolyline: route.polyline.encodedPolyline,
      origin: testCase.origin,
      destination: testCase.destination,
      placesStatus: 'not_requested',
      placesSampleRatios: sampleRatios,
    });
    results.push({
      id: testCase.id,
      scope: testCase.scope,
      origin: testCase.origin,
      destination: testCase.destination,
      distance_m: route.distanceMeters,
      areas: context.areas.map((area) => area.name),
      coverage: {
        indexed_area_count: context.coverage.indexed_area_count,
        candidate_area_count: context.coverage.candidate_area_count,
        unique_area_count: context.coverage.unique_area_count,
        matched_distance_m: context.coverage.matched_distance_m,
        places_calls: 0,
        deepseek_calls: 0,
        places_sample_ratios: sampleRatios,
      },
      transitions: context.transition_segments.map((segment) => ({
        distance_m: segment.distance_m,
        planned_gap_samples: sampleRatios.filter((ratio) => ratio > segment.start_ratio && ratio < segment.end_ratio),
      })),
    });
  } catch (error) {
    results.push({ id: testCase.id, scope: testCase.scope, error: error.message });
  }
}

console.log(JSON.stringify({ route_api_calls: cases.length, places_api_calls: 0, deepseek_api_calls: 0, results }, null, 2));
