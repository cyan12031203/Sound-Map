import { matchRouteNeighborhood } from './route-imagery.js';

const SAMPLE_COUNT = 4;

const TYPE_GROUPS = {
  greenery: new Set(['park', 'city_park', 'garden']),
  water: new Set(['marina']),
  cafes: new Set(['cafe', 'coffee_shop']),
  food: new Set(['restaurant', 'japanese_restaurant', 'ramen_restaurant']),
  nightlife: new Set(['bar', 'pub', 'night_club']),
  live_music: new Set(['live_music_venue', 'concert_hall']),
  vintage: new Set(['thrift_store']),
  shopping: new Set(['clothing_store', 'shopping_mall', 'department_store', 'book_store', 'toy_store']),
  entertainment: new Set(['video_arcade', 'movie_theater', 'art_gallery']),
  transit: new Set(['train_station', 'subway_station']),
};

const CULTURE_NAME_PATTERN = /アニメ|漫画|コミック|ホビー|まんだらけ|animate|anime|manga|vintage|古着|ライブ/i;

export const ROUTE_PLACE_TYPES = [...new Set([...Object.values(TYPE_GROUPS)].flatMap((types) => [...types]))];

export function decodePolyline(encoded = '') {
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    const lat = decodeValue(encoded, index);
    index = lat.index;
    const lng = decodeValue(encoded, index);
    index = lng.index;
    latitude += lat.value;
    longitude += lng.value;
    points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
  }
  return points;
}

function decodeValue(encoded, startIndex) {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte;
  do {
    if (index >= encoded.length) throw new Error('Google 路线 polyline 格式无法识别。');
    byte = encoded.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);
  return { value: (result & 1) ? ~(result >> 1) : result >> 1, index };
}

export function sampleRoute(points, count = SAMPLE_COUNT) {
  if (!points.length) return [];
  if (points.length === 1) return [{ ...points[0], ratio: 0.5 }];
  const sampleCount = Math.min(count, points.length);
  const ratios = Array.from({ length: sampleCount }, (_, sampleIndex) =>
    sampleCount === 1 ? 0.5 : 0.08 + sampleIndex * (0.84 / (sampleCount - 1)));
  return sampleRouteAtRatios(points, ratios);
}

export function sampleRouteAtRatios(points, ratios = []) {
  if (!points.length || !ratios.length) return [];
  if (points.length === 1) return [{ ...points[0], ratio: ratios[0] ?? 0.5 }];
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances.push(distances[index - 1] + haversine(points[index - 1], points[index]));
  }
  const total = distances.at(-1);
  if (!total) return [{ ...points[0], ratio: 0.5 }];
  return [...ratios].sort((left, right) => left - right).map((requestedRatio) => {
    const ratio = Math.max(0, Math.min(1, Number(requestedRatio)));
    const target = total * ratio;
    let right = distances.findIndex((distance) => distance >= target);
    if (right < 1) right = 1;
    const left = right - 1;
    const span = distances[right] - distances[left] || 1;
    const localRatio = (target - distances[left]) / span;
    return {
      latitude: points[left].latitude + (points[right].latitude - points[left].latitude) * localRatio,
      longitude: points[left].longitude + (points[right].longitude - points[left].longitude) * localRatio,
      ratio,
    };
  });
}

export function buildRouteSegments(samples, nearbyResults, endpointHints = {}) {
  const positionedSamples = samples.map((sample, index) => ({
    ...sample,
    ratio: Number.isFinite(sample.ratio)
      ? sample.ratio
      : samples.length === 1 ? 0.5 : 0.08 + index * (0.84 / (samples.length - 1)),
  }));
  const rawSegments = positionedSamples.map((sample, index) => {
    const places = nearbyResults[index] ?? [];
    const startRatio = index === 0 ? 0 : (positionedSamples[index - 1].ratio + sample.ratio) / 2;
    const endRatio = index === positionedSamples.length - 1 ? 1 : (sample.ratio + positionedSamples[index + 1].ratio) / 2;
    const segment = profileSample(sample, places, index, startRatio, endRatio);
    const routeEndpoint = sample.ratio <= 0.15
      ? endpointHints.origin ?? ''
      : sample.ratio >= 0.85 ? endpointHints.destination ?? '' : '';
    const matchedArea = matchRouteNeighborhood(places, routeEndpoint);
    if (!matchedArea) return segment;

    segment.matched_area = {
      name: matchedArea.name,
      ward: matchedArea.ward,
      match_source: matchedArea.matched_by,
    };
    if (matchedArea.imagery) segment.imagery = matchedArea.imagery;
    segment.signature += `|area:${matchedArea.id}`;
    return segment;
  });
  return rawSegments.reduce((segments, segment) => {
    const previous = segments.at(-1);
    if (previous && previous.signature === segment.signature) {
      previous.end_ratio = segment.end_ratio;
      previous.sample_count += 1;
      previous.sample_ratios.push(...segment.sample_ratios);
      previous.confidence = Math.max(previous.confidence, segment.confidence);
      return segments;
    }
    segments.push({ ...segment });
    return segments;
  }, []).map(({ signature, ...segment }) => segment);
}

function profileSample(sample, places, index, startRatio, endRatio) {
  const counts = Object.fromEntries(Object.keys(TYPE_GROUPS).map((key) => [key, 0]));
  for (const place of places) {
    const types = new Set([place.primaryType, ...(place.types ?? [])].filter(Boolean));
    for (const [group, groupTypes] of Object.entries(TYPE_GROUPS)) {
      if ([...types].some((type) => groupTypes.has(type))) counts[group] += 1;
    }
    if (CULTURE_NAME_PATTERN.test(place.displayName?.text ?? '')) counts.entertainment += 1;
  }

  const commercial = counts.cafes + counts.food + counts.nightlife + counts.shopping + counts.entertainment;
  const traits = [];
  if (counts.greenery) traits.push('greenery', 'park-edge');
  if (counts.water) traits.push('waterside');
  if (counts.cafes) traits.push('cafe-dotted');
  if (counts.live_music) traits.push('live-music');
  if (counts.vintage) traits.push('vintage');
  if (counts.nightlife) traits.push('nightlife');
  if (counts.shopping) traits.push('shopping');
  if (counts.food >= 2) traits.push('food-rich');
  if (counts.entertainment) traits.push('entertainment');
  if (counts.live_music && counts.vintage + counts.nightlife + counts.cafes >= 2) traits.push('alternative-culture');
  if (commercial <= 3 && !counts.transit) traits.push('quiet', 'low-commercial-density');
  if (!counts.greenery && commercial <= 2) traits.push('residential');
  if (commercial + counts.transit * 2 >= 6) traits.push('active-pedestrian-proxy');
  if (!traits.length) traits.push('mixed-local');

  const label = mostCommonArea(places) ?? (sample.ratio < 0.25 ? '路线前段'
    : sample.ratio < 0.5 ? '路线中前段'
      : sample.ratio < 0.75 ? '路线中后段' : '路线后段');
  return {
    order: index + 1,
    start_ratio: Number(startRatio.toFixed(4)),
    end_ratio: Number(endRatio.toFixed(4)),
    label,
    traits: [...new Set(traits)],
    poi_mix: counts,
    confidence: places.length >= 10 ? 0.8 : places.length >= 5 ? 0.65 : 0.45,
    sample_count: 1,
    sample_ratios: [Number(sample.ratio.toFixed(4))],
    signature: traits.slice().sort().join('|'),
  };
}

function mostCommonArea(places) {
  const counts = new Map();
  for (const place of places) {
    for (const component of place.addressComponents ?? []) {
      if (!(component.types ?? []).some((type) => ['neighborhood', 'sublocality_level_2'].includes(type))) continue;
      const name = component.longText?.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const area = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return area ? `${area}周边` : null;
}

function haversine(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians(b.longitude - a.longitude);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
