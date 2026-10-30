import { readFileSync } from 'node:fs';
import { decodePolyline } from './route-segments.js';
import { getAreaImagery } from './route-imagery.js';

const areaIndex = JSON.parse(readFileSync(new URL('../../data/tokyo_area_index.json', import.meta.url), 'utf8'));
const MATCH_INTERVAL_METERS = Math.max(10, Number(areaIndex.sampling_interval_m) || 30);

/** Enrich a Google Route locally; no additional Google API calls are made. */
export function buildRouteContext({ encodedPolyline = '', origin = '', destination = '', environmentSegments = [], placesStatus = 'unavailable', placesSampleCount = 0, placesSampleRatios = [] } = {}) {
  const points = encodedPolyline ? decodePolyline(encodedPolyline) : [];
  const areaMatches = matchRouteAreas(points, areaIndex.areas, MATCH_INTERVAL_METERS, { origin, destination });
  const activeAreas = areaIndex.areas.filter(isMatchableArea);
  const matchedDistance = areaMatches.reduce((sum, area) => sum + area.covered_distance_m, 0);
  const routeDistance = getRouteDistance(points);
  const transitionSegments = buildTransitionSegments(areaMatches, environmentSegments, routeDistance);

  return {
    version: 1,
    area_index_version: areaIndex.version,
    area_index_coverage: areaIndex.coverage,
    areas: areaMatches.map((match) => ({
      ...match,
      imagery: match.imagery_area ? getAreaImagery(match.imagery_area) : undefined,
    })),
    environment_segments: environmentSegments,
    transition_segments: transitionSegments,
    coverage: {
      candidate_area_count: areaIndex.candidate_area_count ?? areaIndex.areas.length,
      indexed_area_count: activeAreas.length,
      matched_segment_count: areaMatches.length,
      unique_area_count: new Set(areaMatches.map((area) => area.id)).size,
      matched_distance_m: Math.round(matchedDistance),
      route_polyline_distance_m: Math.round(routeDistance),
      unmatched_distance_m: transitionSegments.reduce((sum, segment) => sum + segment.distance_m, 0),
      transition_segment_count: transitionSegments.length,
      places_enrichment: placesStatus,
      places_sample_count: placesSampleCount,
      places_sample_ratios: placesSampleRatios.length ? placesSampleRatios : environmentSegments.flatMap((segment) => segment.sample_ratios ?? []),
      environment_segment_count: environmentSegments.length,
    },
  };
}

/** Pick up to four existing Places requests, prioritizing long unmatched route gaps. */
export function planRoutePlaceSampleRatios(routePoints = [], areas = areaIndex.areas, intervalMeters = MATCH_INTERVAL_METERS, endpointHints = {}, sampleCount = 4) {
  const routeDistance = getRouteDistance(routePoints);
  if (!routeDistance || sampleCount <= 0) return [];
  const areaMatches = matchRouteAreas(routePoints, areas, intervalMeters, endpointHints);
  const minimumGapMeters = Math.max(350, routeDistance * 0.08);
  const gaps = getUnmatchedIntervals(areaMatches, routeDistance)
    .filter((gap) => gap.distance_m >= minimumGapMeters)
    .sort((left, right) => right.distance_m - left.distance_m);
  const selected = [];
  const minimumSeparationMeters = Math.min(250, Math.max(30, routeDistance * 0.025));
  const add = (ratio) => {
    const normalized = Math.max(0.04, Math.min(0.96, ratio));
    if (selected.every((existing) => Math.abs(existing - normalized) * routeDistance >= minimumSeparationMeters)) {
      selected.push(normalized);
    }
  };

  // Keep one sample near each endpoint, then put remaining samples in the longest gaps.
  add(0.08);
  if (sampleCount > 1) add(0.92);
  for (const gap of gaps) {
    if (selected.length >= sampleCount) break;
    add((gap.start_ratio + gap.end_ratio) / 2);
  }
  for (const gap of gaps.filter((item) => item.distance_m >= 1400)) {
    if (selected.length >= sampleCount) break;
    add(gap.start_ratio + (gap.end_ratio - gap.start_ratio) / 3);
    if (selected.length < sampleCount) add(gap.start_ratio + (gap.end_ratio - gap.start_ratio) * 2 / 3);
  }
  for (const ratio of [0.36, 0.64, 0.5, 0.22, 0.78]) {
    if (selected.length >= sampleCount) break;
    add(ratio);
  }
  return selected.sort((left, right) => left - right).slice(0, sampleCount).map((ratio) => Number(ratio.toFixed(4)));
}

function buildTransitionSegments(areaMatches, environmentSegments, routeDistance) {
  if (!routeDistance) return [];
  return getUnmatchedIntervals(areaMatches, routeDistance)
    .filter((gap) => gap.distance_m >= 120)
    .map((gap, index) => {
      const evidence = environmentSegments.filter((segment) =>
        (segment.end_ratio ?? 0) > gap.start_ratio && (segment.start_ratio ?? 1) < gap.end_ratio);
      return {
        id: `transition-${index + 1}`,
        label: '未命名过渡段',
        start_ratio: Number(gap.start_ratio.toFixed(4)),
        end_ratio: Number(gap.end_ratio.toFixed(4)),
        distance_m: Math.round(gap.distance_m),
        evidence_sample_count: evidence.reduce((sum, segment) => sum + (segment.sample_count ?? 1), 0),
        labels: [...new Set(evidence.map((segment) => segment.label).filter(Boolean))].slice(0, 3),
        traits: [...new Set(evidence.flatMap((segment) => segment.traits ?? []))].slice(0, 8),
      };
    });
}

function getUnmatchedIntervals(areaMatches, routeDistance) {
  const intervals = areaMatches.map((area) => ({
    start_ratio: Math.max(0, Math.min(1, area.start_ratio)),
    end_ratio: Math.max(0, Math.min(1, area.end_ratio)),
  })).sort((left, right) => left.start_ratio - right.start_ratio);
  const gaps = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.start_ratio > cursor) {
      gaps.push({ start_ratio: cursor, end_ratio: interval.start_ratio, distance_m: (interval.start_ratio - cursor) * routeDistance });
    }
    cursor = Math.max(cursor, interval.end_ratio);
  }
  if (cursor < 1) gaps.push({ start_ratio: cursor, end_ratio: 1, distance_m: (1 - cursor) * routeDistance });
  return gaps.filter((gap) => gap.end_ratio > gap.start_ratio);
}

function getRouteDistance(points) {
  if (points.length < 2) return 0;
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) distance += haversine(points[index - 1], points[index]);
  return distance;
}

/** Match a decoded route polyline against circular neighborhood zones. */
export function matchRouteAreas(routePoints = [], areas = areaIndex.areas, intervalMeters = MATCH_INTERVAL_METERS, endpointHints = {}) {
  const matchableAreas = areas.filter(isMatchableArea);
  const samples = resampleRoute(routePoints, intervalMeters);
  if (!samples.length) return [];
  const originArea = findEndpointArea(endpointHints.origin, matchableAreas);
  const destinationArea = findEndpointArea(endpointHints.destination, matchableAreas);

  let previousAreaId = null;
  const assignments = samples.map((sample, sample_index) => {
    const endpointArea = sample_index === 0 ? originArea
      : sample_index === samples.length - 1 ? destinationArea : null;
    if (endpointArea) {
      previousAreaId = endpointArea.id;
      return { ...sample, sample_index, area: endpointArea, confidence: 0.95, match_source: 'route_endpoint' };
    }
    const candidates = matchableAreas.map((area) => {
      const distance = haversine(sample, area.center);
      return { area, distance, score: distance <= area.radius_m ? 1 - distance / area.radius_m : -1 };
    }).filter((candidate) => candidate.score >= 0)
      .sort((left, right) => right.score - left.score);

    if (!candidates.length) {
      previousAreaId = null;
      return { ...sample, sample_index, area: null, confidence: 0, match_source: null };
    }

    let selected = candidates[0];
    const previous = candidates.find((candidate) => candidate.area.id === previousAreaId);
    if (previous && previous.score >= selected.score - 0.12) selected = previous;
    previousAreaId = selected.area.id;
    const runnerUp = candidates.find((candidate) => candidate.area.id !== selected.area.id);
    const margin = runnerUp ? Math.max(0, selected.score - runnerUp.score) : selected.score;
    return {
      ...sample,
      sample_index,
      area: selected.area,
      confidence: Number(Math.min(0.97, 0.68 + margin * 0.28).toFixed(2)),
      match_source: 'geometry_circle',
    };
  });

  const matches = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const leftNeighbor = samples[run.first.sample_index - 1];
    const rightNeighbor = samples[run.last.sample_index + 1];
    const leftEdge = leftNeighbor
      ? (leftNeighbor.distance_along_m + run.first.distance_along_m) / 2
      : 0;
    const rightEdge = rightNeighbor
      ? (rightNeighbor.distance_along_m + run.last.distance_along_m) / 2
      : samples.at(-1).distance_along_m;
    const coveredDistance = Math.max(0, rightEdge - leftEdge);
    matches.push({
      id: run.area.id,
      name: run.area.name,
      ward: run.area.ward,
      imagery_area: run.area.imagery_area ?? null,
      match_source: run.matchSource,
      confidence: Number((run.confidenceTotal / run.sampleCount).toFixed(2)),
      start_ratio: Number(run.first.ratio.toFixed(4)),
      end_ratio: Number(run.last.ratio.toFixed(4)),
      start_distance_m: Math.round(run.first.distance_along_m),
      end_distance_m: Math.round(run.last.distance_along_m),
      covered_distance_m: Math.round(coveredDistance),
    });
    run = null;
  };

  for (const assignment of assignments) {
    if (!assignment.area) {
      flush();
      continue;
    }
    if (!run || run.area.id !== assignment.area.id) {
      flush();
      run = {
        area: assignment.area,
        first: assignment,
        last: assignment,
        sample_index: assignment.sample_index,
        matchSource: assignment.match_source,
        confidenceTotal: assignment.confidence,
        sampleCount: 1,
      };
      continue;
    }
    run.last = assignment;
    if (run.matchSource !== assignment.match_source) run.matchSource = 'geometry_and_endpoint';
    run.confidenceTotal += assignment.confidence;
    run.sampleCount += 1;
  }
  flush();
  return mergeShortSameAreaGaps(matches, Math.max(120, intervalMeters * 4));
}

function isMatchableArea(area) {
  return area?.active !== false
    && Number.isFinite(area?.center?.lat)
    && Number.isFinite(area?.center?.lng)
    && Number.isFinite(area?.radius_m)
    && area.radius_m > 0;
}

function mergeShortSameAreaGaps(matches, maxGapMeters) {
  const merged = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    const gap = previous ? match.start_distance_m - previous.end_distance_m : Infinity;
    if (!previous || previous.id !== match.id || gap > maxGapMeters) {
      merged.push({ ...match });
      continue;
    }
    previous.end_ratio = match.end_ratio;
    previous.end_distance_m = match.end_distance_m;
    previous.covered_distance_m += Math.max(0, gap) + match.covered_distance_m;
    previous.confidence = Math.min(previous.confidence, match.confidence);
    previous.bridged_gap_m = (previous.bridged_gap_m ?? 0) + Math.max(0, gap);
    if (previous.match_source !== match.match_source) previous.match_source = 'geometry_and_endpoint';
  }
  return merged;
}

function findEndpointArea(endpoint, areas) {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (!normalizedEndpoint) return null;
  const matches = areas.flatMap((area) => [area.name, ...(area.aliases ?? []), ...(area.anchors ?? [])]
    .map((name) => normalizeEndpoint(name))
    .filter((name) => name.length >= 2 && normalizedEndpoint.includes(name))
    .map((name) => ({ area, name })));
  matches.sort((left, right) => right.name.length - left.name.length);
  if (!matches.length) return null;
  if (matches[1] && matches[0].name.length === matches[1].name.length && matches[0].area.id !== matches[1].area.id) return null;
  return matches[0].area;
}

function normalizeEndpoint(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .replace(/(?:駅周辺|駅|周辺|station)$/iu, '');
}

function resampleRoute(points, intervalMeters) {
  if (!points.length) return [];
  if (points.length === 1) return [{ ...points[0], ratio: 0, distance_along_m: 0 }];

  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + haversine(points[index - 1], points[index]));
  }
  const total = cumulative.at(-1);
  if (!total) return [{ ...points[0], ratio: 0, distance_along_m: 0 }];

  const targets = [];
  for (let distance = 0; distance < total; distance += intervalMeters) targets.push(distance);
  if (targets.at(-1) !== total) targets.push(total);

  return targets.map((target) => {
    let right = cumulative.findIndex((distance) => distance >= target);
    if (right < 1) right = 1;
    const left = right - 1;
    const span = cumulative[right] - cumulative[left] || 1;
    const localRatio = Math.max(0, Math.min(1, (target - cumulative[left]) / span));
    return {
      latitude: points[left].latitude + (points[right].latitude - points[left].latitude) * localRatio,
      longitude: points[left].longitude + (points[right].longitude - points[left].longitude) * localRatio,
      ratio: target / total,
      distance_along_m: target,
    };
  });
}

function haversine(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude ?? b.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = radians((b.longitude ?? b.lng) - a.longitude);
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
