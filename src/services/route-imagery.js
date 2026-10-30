import { readFileSync } from 'node:fs';

const neighborhoodIndex = JSON.parse(readFileSync(new URL('../../data/tokyo_neighborhood_index.json', import.meta.url), 'utf8'));
const imageryAreas = JSON.parse(readFileSync(new URL('../../data/tokyo_imagery.json', import.meta.url), 'utf8'));
const imageryByArea = new Map(imageryAreas.map((area) => [normalize(area.area), area]));

const ADDRESS_TYPES = new Set([
  'neighborhood',
  'sublocality',
  'sublocality_level_1',
  'sublocality_level_2',
  'sublocality_level_3',
]);

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]/gu, '');
}

function normalizeEndpoint(value) {
  return normalize(value).replace(/(?:駅周辺|駅|周辺|station)$/iu, '');
}

function compareEndpoint(candidateText, endpointText) {
  const candidate = normalizeEndpoint(candidateText);
  const endpoint = normalizeEndpoint(endpointText);
  return candidate && endpoint && candidate === endpoint ? 250 : 0;
}

function getTextSignals(places) {
  const addressSignals = new Set();
  const areaCounts = new Map();
  const placeSignals = new Set();

  for (const place of places) {
    const displayName = place.displayName?.text;
    if (displayName) placeSignals.add(displayName);

    for (const component of place.addressComponents ?? []) {
      if (!(component.types ?? []).some((type) => ADDRESS_TYPES.has(type))) continue;
      const componentName = component.longText ?? component.shortText;
      if (componentName) {
        addressSignals.add(componentName);
        if ((component.types ?? []).some((type) => ['neighborhood', 'sublocality_level_2'].includes(type))) {
          areaCounts.set(componentName, (areaCounts.get(componentName) ?? 0) + 1);
        }
      }
    }
  }

  const dominantAreaSignals = [...areaCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .filter((entry) => entry[1] === Math.max(0, ...areaCounts.values()))
    .map(([name]) => name);
  return { addressSignals: [...addressSignals], dominantAreaSignals, placeSignals: [...placeSignals] };
}

function compare(candidateText, signalText, exactScore, partialScore) {
  const candidate = normalize(candidateText);
  const signal = normalize(signalText).replace(/(?:周辺|周边)$/u, '');
  if (!candidate || !signal) return 0;
  if (candidate === signal) return exactScore + Math.min(candidate.length, 20) / 10;
  // Partial matching is only safe when both terms carry enough identifying text.
  if (Math.min(candidate.length, signal.length) >= 3 && (candidate.includes(signal) || signal.includes(candidate))) {
    return partialScore + Math.min(candidate.length, signal.length, 20) / 10;
  }
  return 0;
}

function buildImageryContext(imagery) {
  return {
    area: imagery.area,
    images: imagery.images.slice(0, 2).map((image) => ({
      term: image.term,
      associations: image.associations.slice(0, 2),
    })),
  };
}

export function getAreaImagery(areaName) {
  const imagery = imageryByArea.get(normalize(areaName));
  return imagery ? buildImageryContext(imagery) : null;
}

/**
 * Match one existing Places sample to a named neighborhood without another API call.
 * Returns null on ties instead of guessing between adjacent candidate areas.
 */
export function matchRouteNeighborhood(places = [], routeEndpoint = '') {
  const { addressSignals, dominantAreaSignals, placeSignals } = getTextSignals(places);
  const areaSignals = dominantAreaSignals.length ? dominantAreaSignals : addressSignals;

  // A user-selected endpoint is more precise than nearby POI addresses. Resolve
  // it against the imagery catalog first (including landmarks outside the ward index).
  if (routeEndpoint) {
    const endpointMatches = imageryAreas.map((imagery) => ({
      imagery,
      score: Math.max(...[imagery.area, ...(imagery.aliases ?? [])].map((name) => compareEndpoint(name, routeEndpoint))),
    })).filter((match) => match.score > 0).sort((left, right) => right.score - left.score);
    if (endpointMatches.length && (!endpointMatches[1] || endpointMatches[0].score !== endpointMatches[1].score)) {
      const { imagery } = endpointMatches[0];
      const indexedArea = neighborhoodIndex.areas.find((area) => normalize(area.imagery_area ?? '') === normalize(imagery.area));
      return {
        id: indexedArea?.id ?? `legacy-${normalize(imagery.area)}`,
        name: imagery.area,
        ward: indexedArea?.ward ?? [],
        ...(!indexedArea ? { scope: 'outside_23_wards' } : {}),
        matched_by: 'route_endpoint',
        matched_term: routeEndpoint,
        imagery: buildImageryContext(imagery),
      };
    }
  }

  const ranked = [];

  for (const area of neighborhoodIndex.areas) {
    const names = [area.name, ...(area.aliases ?? [])];
    const anchors = area.anchors ?? [];
    let best = null;

    if (routeEndpoint) {
      for (const name of names) {
        const score = compareEndpoint(name, routeEndpoint);
        if (score > (best?.score ?? 0)) best = { score, matchedBy: 'route_endpoint', matchedTerm: routeEndpoint };
      }
    }

    for (const signal of areaSignals) {
      if (best?.matchedBy === 'route_endpoint') break;
      for (const name of names) {
        const score = compare(name, signal, 120, 100);
        if (score > (best?.score ?? 0)) best = { score, matchedBy: 'address_component', matchedTerm: signal };
      }
    }

    // A route segment label comes from the most common neighborhood component.
    // Prefer those address signals over nearby POI names, whose search radius can
    // cross neighborhood boundaries.
    if (!best && addressSignals.length === 0) {
      for (const signal of placeSignals) {
        for (const name of names) {
          const score = compareEndpoint(name, signal) ? 70 : 0;
          if (score > (best?.score ?? 0)) best = { score, matchedBy: 'place_name', matchedTerm: signal };
        }
        for (const anchor of anchors) {
          const score = compareEndpoint(anchor, signal) ? 65 : 0;
          if (score > (best?.score ?? 0)) best = { score, matchedBy: 'route_anchor', matchedTerm: signal };
        }
      }
    }

    if (best) ranked.push({ area, ...best });
  }

  ranked.sort((left, right) => right.score - left.score);
  if (!ranked.length) {
    // Keep the two existing non-ward imagery records (Kichijoji and Inokashira)
    // available without treating them as part of the 23-ward candidate set.
    const indexedImagery = new Set(neighborhoodIndex.areas.map((area) => normalize(area.imagery_area ?? '')));
    const legacyMatches = [];
    for (const imagery of imageryAreas) {
      if (indexedImagery.has(normalize(imagery.area))) continue;
      let score = 0;
      let matchedBy = '';
      let matchedTerm = '';
      if (routeEndpoint) {
        for (const name of [imagery.area, ...(imagery.aliases ?? [])]) {
          const candidateScore = compareEndpoint(name, routeEndpoint);
          if (candidateScore > score) {
            score = candidateScore;
            matchedBy = 'route_endpoint';
            matchedTerm = routeEndpoint;
          }
        }
      }
      for (const signal of areaSignals) {
        if (matchedBy === 'route_endpoint') break;
        for (const name of [imagery.area, ...(imagery.aliases ?? [])]) {
          const candidateScore = compare(name, signal, 150, 100);
          if (candidateScore > score) {
            score = candidateScore;
            matchedBy = 'address_component';
            matchedTerm = signal;
          }
        }
      }
      if (matchedBy !== 'route_endpoint') for (const signal of placeSignals) {
        for (const name of [imagery.area, ...(imagery.aliases ?? [])]) {
          // An exact named landmark (e.g. Inokashira Park) is more informative
          // than a partial match to a broad neighboring district (e.g. Kichijoji).
          const candidateScore = compareEndpoint(name, signal) ? 135 : 0;
          if (candidateScore > score) {
            score = candidateScore;
            matchedBy = 'place_name';
            matchedTerm = signal;
          }
        }
      }
      if (score) legacyMatches.push({ imagery, score, matchedBy, matchedTerm });
    }
    legacyMatches.sort((left, right) => right.score - left.score);
    if (!legacyMatches.length || (legacyMatches[1] && legacyMatches[0].score === legacyMatches[1].score)) return null;
    const { imagery, matchedBy, matchedTerm } = legacyMatches[0];
    return {
      id: `legacy-${normalize(imagery.area)}`,
      name: imagery.area,
      ward: [],
      scope: 'outside_23_wards',
      matched_by: matchedBy,
      matched_term: matchedTerm,
      imagery: buildImageryContext(imagery),
    };
  }
  if (ranked[1] && ranked[0].score === ranked[1].score) return null;

  const { area, matchedBy, matchedTerm } = ranked[0];
  const match = {
    id: area.id,
    name: area.name,
    ward: area.ward,
    matched_by: matchedBy,
    matched_term: matchedTerm,
  };

  if (area.imagery_area) {
    const imagery = imageryByArea.get(normalize(area.imagery_area));
    if (imagery) match.imagery = buildImageryContext(imagery);
  }

  return match;
}
