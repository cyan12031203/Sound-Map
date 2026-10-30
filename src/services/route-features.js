const ROAD_RULES = [
  { pattern: /motorway|freeway|expressway|interstate|高速|快速路/i, noise: 9, scene: 'industrial_fast' },
  { pattern: /highway|parkway|turnpike|国道|省道|公路/i, noise: 7, scene: 'suburban_artery' },
  { pattern: /avenue|boulevard|main st(?:reet)?|大街|大道/i, noise: 5, scene: 'urban_commercial' },
  { pattern: /street|road|drive|路|街/i, noise: 3, scene: 'city_grid' },
  { pattern: /lane|court|place|way|巷|胡同|弄/i, noise: 2, scene: 'residential_quiet' },
  { pattern: /path|trail|walkway|boardwalk|步道|绿道|公园/i, noise: 1, scene: 'nature_park' },
];

export function classifyRoad(instruction = '') {
  return ROAD_RULES.find((rule) => rule.pattern.test(instruction))
    ?? { noise: 4, scene: 'unknown' };
}

export function extractRouteFeatures(route, expectedMode, fallbackDuration) {
  const steps = route.legs?.flatMap((leg) => leg.steps ?? []) ?? [];
  const sceneSeconds = new Map();
  let weightedNoise = 0;
  let measuredSeconds = 0;
  let turnCount = 0;
  let sceneTransitions = 0;
  let previousScene = null;
  const routeCues = [];

  for (const step of steps) {
    if (step.travelMode && step.travelMode !== expectedMode) {
      throw new Error('Google 返回了混合交通方式，本 MVP 只支持单一出行方式。');
    }
    const duration = parseDuration(step.staticDuration);
    if (duration <= 0) continue;
    const instruction = cleanInstruction(step.navigationInstruction?.instructions ?? '');
    const road = classifyRoad(instruction);
    weightedNoise += road.noise * duration;
    measuredSeconds += duration;
    sceneSeconds.set(road.scene, (sceneSeconds.get(road.scene) ?? 0) + duration);
    if (/turn|merge|ramp|roundabout|keep (?:left|right)|左转|右转|匝道|环岛|并入/i.test(instruction)) turnCount += 1;
    if (previousScene && previousScene !== road.scene) sceneTransitions += 1;
    previousScene = road.scene;
    if (instruction && routeCues.length < 6) routeCues.push(instruction.slice(0, 120));
  }

  // 无步骤时采用与出行方式相符的温和兜底值，保证短路线仍可生成歌单。
  if (!measuredSeconds) {
    const fallback = expectedMode === 'DRIVE'
      ? { noise: 5, scene: 'urban_commercial' }
      : { noise: 2, scene: 'residential_quiet' };
    return makeFeatures(fallbackDuration, fallback.noise, fallback.scene, expectedMode, route, {
      sceneSeconds: new Map([[fallback.scene, fallbackDuration]]), turnCount: 0, sceneTransitions: 0, routeCues: [],
    });
  }

  const knownScenes = [...sceneSeconds.entries()].filter(([scene]) => scene !== 'unknown');
  const dominantScene = (knownScenes.length ? knownScenes : [...sceneSeconds.entries()])
    .sort((a, b) => b[1] - a[1])[0][0];
  return makeFeatures(fallbackDuration, weightedNoise / measuredSeconds, dominantScene, expectedMode, route, {
    sceneSeconds, turnCount, sceneTransitions, routeCues,
  });
}

function makeFeatures(totalDuration, avgNoise, dominantScene, mode, route, details) {
  const distanceMeters = Number(route.distanceMeters) || 0;
  const distanceKm = distanceMeters / 1000;
  const turnsPerKm = distanceKm > 0 ? details.turnCount / distanceKm : 0;
  const classifiedSeconds = [...details.sceneSeconds.values()].reduce((sum, seconds) => sum + seconds, 0);
  return {
    total_duration_sec: totalDuration,
    distance_meters: distanceMeters,
    avg_noise: Number(avgNoise.toFixed(1)),
    dominant_scene: dominantScene,
    scene_distribution: Object.fromEntries([...details.sceneSeconds.entries()]
      .map(([scene, seconds]) => [scene, Number((seconds / Math.max(1, classifiedSeconds)).toFixed(2))])),
    route_pace: classifyPace(mode, distanceMeters, totalDuration),
    route_complexity: turnsPerKm >= 4 ? 'winding' : turnsPerKm >= 2 ? 'varied' : 'direct',
    turn_count: details.turnCount,
    scene_transition_count: details.sceneTransitions,
    route_cues: details.routeCues,
    mode,
  };
}

function classifyPace(mode, distanceMeters, durationSeconds) {
  const speedKmh = durationSeconds > 0 ? (distanceMeters / durationSeconds) * 3.6 : 0;
  const thresholds = mode === 'WALK' ? [3.8, 5.2] : mode === 'BICYCLE' ? [10, 18] : [18, 35];
  return speedKmh >= thresholds[1] ? 'brisk' : speedKmh >= thresholds[0] ? 'steady' : 'unhurried';
}

function cleanInstruction(value) {
  return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value ?? '');
  return match ? Math.round(Number(match[1])) : 0;
}
