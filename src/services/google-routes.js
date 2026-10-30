import { ProxyAgent } from 'undici';
import { extractRouteFeatures } from './route-features.js';
import { getRoutePlaceSegments } from './google-places.js';
import { buildRouteContext, planRoutePlaceSampleRatios } from './route-context.js';
import { decodePolyline } from './route-segments.js';

const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

let proxyAgent;

function getGoogleDispatcher() {
  const proxyUrl = process.env.HTTPS_PROXY?.trim();
  if (!proxyUrl) return undefined;
  if (!proxyAgent) proxyAgent = new ProxyAgent(proxyUrl);
  return proxyAgent;
}

const travelModes = {
  walking: 'WALK',
  driving: 'DRIVE',
  bicycling: 'BICYCLE',
};

export async function calculateRoute({ origin, destination, originLocation, destinationLocation, mode }) {
  const travelMode = travelModes[mode];
  if (!travelMode) throw new Error('不支持的交通方式。');

  const body = {
    origin: originLocation ? { location: { latLng: originLocation } } : { address: origin },
    destination: destinationLocation ? { location: { latLng: destinationLocation } } : { address: destination },
    travelMode,
    // 英文导航指令便于按 PRD 中的国外道路关键词判断道路性格。
    languageCode: 'en-US',
    units: 'METRIC',
  };

  // 交通感知偏好只适用于驾车。
  if (mode === 'driving') body.routingPreference = 'TRAFFIC_AWARE';

  let response;
  try {
    response = await fetch(GOOGLE_ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': [
          'routes.duration',
          'routes.distanceMeters',
          'routes.localizedValues',
          'routes.polyline.encodedPolyline',
          'routes.legs.steps.staticDuration',
          'routes.legs.steps.distanceMeters',
          'routes.legs.steps.polyline.encodedPolyline',
          'routes.legs.steps.navigationInstruction.instructions',
          'routes.legs.steps.travelMode',
        ].join(','),
      },
      // 仅 Google 请求走代理；读取本机网易云 API 的请求不会受影响。
      dispatcher: getGoogleDispatcher(),
      body: JSON.stringify(body),
    });
  } catch (error) {
    const reason = error.cause?.message ?? error.message;
    throw new Error(`无法连接 Google Routes API：${reason}`);
  }

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? 'Google Routes API 请求失败。');

  const route = data.routes?.[0];
  if (!route) throw new Error('未找到路线，请尝试输入更完整的地名。');

  const baseRoute = {
    durationSeconds: parseGoogleDuration(route.duration),
    distanceMeters: route.distanceMeters,
    localized: route.localizedValues ?? null,
  };
  const encodedPolyline = route.polyline?.encodedPolyline;
  const sampleRatios = planRoutePlaceSampleRatios(decodePolyline(encodedPolyline ?? ''), undefined, undefined, { origin, destination }, 4);
  const placeContext = await getRoutePlaceSegments({ encodedPolyline, mode: travelMode, origin, destination, sampleRatios })
    .catch(() => ({ segments: [], sampleCount: 0, successfulRequests: 0 }));
  const features = extractRouteFeatures(route, travelMode, baseRoute.durationSeconds);
  const placesStatus = placeContext.successfulRequests
    ? (placeContext.successfulRequests === placeContext.sampleCount ? 'complete' : 'partial')
    : 'unavailable';
  const routeContext = buildRouteContext({
    encodedPolyline,
    origin,
    destination,
    environmentSegments: placeContext.segments,
    placesStatus,
    placesSampleCount: placeContext.sampleCount,
    placesSampleRatios: placeContext.sampleRatios ?? sampleRatios,
  });
  return {
    ...baseRoute,
    features: {
      ...features,
      segments: placeContext.segments,
      route_context: routeContext,
      places_enrichment: placesStatus,
      places_sample_count: placeContext.sampleCount,
      places_enrichment_error: placeContext.error ?? null,
    },
  };
}

function parseGoogleDuration(duration) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration ?? '');
  if (!match) throw new Error('Google 返回的路线时长格式无法识别。');
  return Math.round(Number(match[1]));
}
