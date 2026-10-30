import { ProxyAgent } from 'undici';
import { buildRouteSegments, decodePolyline, ROUTE_PLACE_TYPES, sampleRoute, sampleRouteAtRatios } from './route-segments.js';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';
const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
let proxyAgent;

function dispatcher() {
  const proxyUrl = process.env.HTTPS_PROXY?.trim();
  if (!proxyUrl) return undefined;
  if (!proxyAgent) proxyAgent = new ProxyAgent(proxyUrl);
  return proxyAgent;
}

function headers(fieldMask) {
  return { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': fieldMask };
}

async function googleRequest(url, options) {
  let response;
  try { response = await fetch(url, { ...options, dispatcher: dispatcher() }); }
  catch (error) { throw new Error(`无法连接 Google Places API：${error.cause?.message ?? error.message}`); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? 'Google Places API 请求失败。');
  return data;
}

export async function autocompletePlaces({ query, sessionToken }) {
  const data = await googleRequest(AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: headers('suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat'),
    body: JSON.stringify({ input: query, languageCode: 'zh-CN', sessionToken, includeQueryPredictions: false }),
  });
  return (data.suggestions ?? []).flatMap(({ placePrediction: item }) => !item?.placeId || !item.text?.text ? [] : [{
    placeId: item.placeId,
    label: item.text.text,
    primaryText: item.structuredFormat?.mainText?.text ?? item.text.text,
    secondaryText: item.structuredFormat?.secondaryText?.text ?? '',
  }]).slice(0, 6);
}

export async function getPlaceDetails({ placeId, sessionToken }) {
  const url = `${DETAILS_URL}/${encodeURIComponent(placeId)}?languageCode=zh-CN&sessionToken=${encodeURIComponent(sessionToken)}`;
  const data = await googleRequest(url, { headers: headers('id,displayName,formattedAddress,location') });
  if (!data.location) throw new Error('该地点没有可用于路线计算的坐标。');
  return { placeId: data.id, address: data.formattedAddress ?? data.displayName?.text ?? '', location: data.location };
}

export async function getRoutePlaceSegments({ encodedPolyline, mode, origin, destination, sampleRatios = [] }) {
  if (!encodedPolyline) return { segments: [], sampleCount: 0, successfulRequests: 0 };
  const points = decodePolyline(encodedPolyline);
  const samples = sampleRatios.length
    ? sampleRouteAtRatios(points, sampleRatios)
    : sampleRoute(points, 4);
  const radius = mode === 'DRIVE' ? 600 : mode === 'BICYCLE' ? 450 : 300;
  const settled = await Promise.allSettled(samples.map((sample) => searchNearbyContext(sample, radius)));
  const results = settled.map((result) => result.status === 'fulfilled' ? result.value : []);
  const successfulRequests = settled.filter((result) => result.status === 'fulfilled').length;
  return {
    segments: successfulRequests ? buildRouteSegments(samples, results, { origin, destination }) : [],
    sampleCount: samples.length,
    sampleRatios: samples.map((sample) => Number(sample.ratio.toFixed(4))),
    successfulRequests,
    error: successfulRequests ? null : settled.find((result) => result.status === 'rejected')?.reason?.message ?? 'Places 采样失败。',
  };
}

async function searchNearbyContext(center, radius) {
  const data = await googleRequest(NEARBY_URL, {
    method: 'POST',
    headers: headers('places.id,places.displayName,places.primaryType,places.types,places.location,places.addressComponents'),
    body: JSON.stringify({
      languageCode: 'ja',
      regionCode: 'JP',
      includedTypes: ROUTE_PLACE_TYPES,
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      locationRestriction: {
        circle: { center: { latitude: center.latitude, longitude: center.longitude }, radius },
      },
    }),
    signal: AbortSignal.timeout(5_500),
  });
  return data.places ?? [];
}
