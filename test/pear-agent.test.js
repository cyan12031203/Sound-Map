import test from 'node:test';
import { createServer } from 'node:http';
import { profileSong, PROFILE_VERSION } from '../src/services/song-profile.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPearAgent } from '../src/agent/pear-agent.js';
import { MockPlanner } from '../src/agent/mock-planner.js';
import { createAgentTools, computeRecentSelectionPenalties, diversifyCandidates, songStrategyScore, solveDuration } from '../src/agent/agent-tools.js';
import { extractRouteFeatures } from '../src/services/route-features.js';
import { buildDeepSeekBody, parseDeepSeekPlan, parseDeepSeekSelection } from '../src/agent/deepseek-planner.js';
import { parseLyrics, parseTimedLines } from '../public/lyrics.js';
import { buildRouteSegments, decodePolyline, ROUTE_PLACE_TYPES, sampleRoute } from '../src/services/route-segments.js';
import { matchRouteNeighborhood } from '../src/services/route-imagery.js';
import { buildRouteContext, matchRouteAreas, planRoutePlaceSampleRatios } from '../src/services/route-context.js';
import { getSongPlayback } from '../src/services/netease.js';

const likedSongs = [
  { id: 1, name: 'Electronic Sun', artists: 'A', album: '', durationMs: 180000 },
  { id: 2, name: 'Pop Dream', artists: 'B', album: '', durationMs: 210000 },
  { id: 3, name: 'Ambient Night', artists: 'C', album: '', durationMs: 150000 },
  { id: 4, name: 'Dance Avenue', artists: 'D', album: '', durationMs: 240000 },
];

function makeTools() {
  return createAgentTools({
    calculateRoute: async () => ({ features: { total_duration_sec: 600, avg_noise: 5, dominant_scene: 'urban_commercial', mode: 'DRIVE' } }),
    getLikedSongs: async () => ({ songs: likedSongs }),
    profileSongs: async (songs) => songs.map(profileSong),
    diagnosticsPath: null,
  });
}

test('PEAR Agent 感知、规划、行动、反思并生成合格歌单', async () => {
  const events = [];
  const result = await runPearAgent({
    input: { origin: 'A', destination: 'B', mode: 'driving' },
    planner: new MockPlanner(), tools: makeTools(), emit: (event) => events.push(event),
  });
  assert.ok(result.total_duration_sec >= 540 && result.total_duration_sec <= 630);
  assert.ok(result.agent_iterations >= 1 && result.agent_iterations <= 3);
  assert.equal(result.dp_used, true);
  assert.match(result.introduction, /音乐/);
  assert.ok(events.some((event) => event.stage === '反思'));
  assert.ok(result.playlist.every((song) => ['1', '2', '3', '4'].includes(song.song_id)));
});

test('完成歌单后将候选排名、阶段评分和入选结果追加到本地 JSONL 诊断日志', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sound-map-diagnostics-'));
  const diagnosticsPath = path.join(directory, 'nested', 'selection-diagnostics.jsonl');
  try {
    const tools = createAgentTools({
      calculateRoute: async () => ({ features: { total_duration_sec: 600, avg_noise: 5, dominant_scene: 'urban_commercial', mode: 'DRIVE' } }),
      getLikedSongs: async () => ({ songs: likedSongs }),
      profileSongs: async (songs) => songs.map(profileSong),
      diagnosticsPath,
    });
    const result = await runPearAgent({
      input: { origin: 'A', destination: 'B', mode: 'driving' },
      planner: new MockPlanner(), tools,
    });
    const [line] = (await readFile(diagnosticsPath, 'utf8')).trim().split('\n');
    const record = JSON.parse(line);
    assert.equal(record.generation_id, result.generation_id);
    assert.equal(record.route.origin, 'A');
    assert.ok(record.candidate_count >= record.selected.length);
    assert.ok(record.candidates.some((song) => song.selected));
    assert.ok(record.selected.every((song) => Number.isFinite(song.search_rank)));
    assert.ok(record.strategy.length > 0);
    assert.equal(record.selection_method, 'duration_dp');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('工具失败返回空时 Agent 不会伪造歌曲', async () => {
  const tools = makeTools();
  tools.search_songs = async () => [];
  await assert.rejects(() => runPearAgent({
    input: { origin: 'A', destination: 'B', mode: 'walking' },
    planner: new MockPlanner(), tools,
  }), /未能生成任何候选歌单/);
});

test('路线计算与网易云曲库读取并行启动', async () => {
  let routeStarted = false;
  let libraryStarted = false;
  let finishRoute;
  const routeGate = new Promise((resolve) => { finishRoute = resolve; });
  const tools = createAgentTools({
    calculateRoute: async () => { routeStarted = true; return routeGate; },
    getLikedSongs: async () => { libraryStarted = true; return { songs: [] }; },
    profileSongs: async () => [],
  });

  const routePromise = tools.get_route_profile({ origin: 'A', destination: 'B' });
  assert.equal(routeStarted, true);
  assert.equal(libraryStarted, true);
  finishRoute({ features: { total_duration_sec: 120, dominant_scene: 'unknown', mode: 'DRIVE' } });
  assert.equal((await routePromise).total_duration_sec, 120);
});

test('DP 在 DeepSeek 候选复核等待期间启动，且结果保留阶段计时', async () => {
  let dpStarted = false;
  const tools = {
    get_route_profile: async () => ({ total_duration_sec: 240, dominant_scene: 'unknown' }),
    search_songs: async () => [{ song_id: 'track', duration_sec: 240 }],
    dp_solver: async () => { dpStarted = true; return ['track']; },
    calculate_duration: async () => ({ total_seconds: 240 }),
    finalize_output: async () => ({ playlist: [] }),
  };
  const planner = {
    plan: async () => ({ summary: 'plan', search: { music_phases: [] }, use_dp: true, max_songs: 2 }),
    select: async () => {
      assert.equal(dpStarted, true);
      return { summary: 'select', use_dp: true, song_ids: [] };
    },
  };

  const result = await runPearAgent({ input: { origin: 'A', destination: 'B' }, planner, tools, maxIterations: 1 });
  assert.equal(result.dp_used, true);
  assert.ok(result.timings_ms.total_ms >= 0);
  assert.ok(result.timings_ms.selection_ms >= 0);
  assert.ok(result.timings_ms.dp_ms >= 0);
});

test('Agent 严格在三轮后停止', async () => {
  const tools = makeTools();
  tools.dp_solver = async ({ songs }) => [songs[0].song_id];
  const result = await runPearAgent({
    input: { origin: 'A', destination: 'B', mode: 'driving' },
    planner: new MockPlanner(), tools,
  });
  assert.equal(result.agent_iterations, 3);
  assert.ok(result.thinking_traces.some((trace) => trace.startsWith('修正:')));
});

test('候选歌曲按路线稳定变化并优先分散艺术家', () => {
  const songs = [
    ...Array.from({ length: 5 }, (_, index) => ({ song_id: `school-${index}`, artist: '中国人民大学合唱团' })),
    ...Array.from({ length: 5 }, (_, index) => ({ song_id: `artist-${index}`, artist: `艺人${index}` })),
  ];
  const routeA = diversifyCandidates(songs, '海淀|朝阳|1800');
  const routeARepeat = diversifyCandidates(songs, '海淀|朝阳|1800');
  const routeB = diversifyCandidates(songs, '徐汇|浦东|2400');

  assert.deepEqual(routeA.map((song) => song.song_id), routeARepeat.map((song) => song.song_id));
  assert.notDeepEqual(routeA.slice(0, 5).map((song) => song.song_id), routeB.slice(0, 5).map((song) => song.song_id));
  assert.equal(new Set(routeA.slice(0, 5).map((song) => song.artist)).size, 5);
});

test('同一路线的近分候选每次会变化，但不会打乱明显更好的匹配', async () => {
  const catalog = [
    { song_id: 'clear-match', title: 'Clear match', artist: 'A', duration_sec: 180, energy: 0.8, pace: 0.6, label_meta: { energy: { confidence: 1 }, pace: { confidence: 1 } } },
    ...Array.from({ length: 30 }, (_, index) => ({
      song_id: `tie-${index}`, title: `Tie ${index}`, artist: `Artist ${index + 1}`, duration_sec: 180,
      energy: 0.5, pace: 0.5, label_meta: { energy: { confidence: 0 }, pace: { confidence: 0 } },
    })),
  ];
  const tools = createAgentTools({
    calculateRoute: async () => ({ features: { total_duration_sec: 1800 } }),
    getLikedSongs: async () => ({ songs: [] }),
    profileSongs: async () => catalog,
    diagnosticsPath: null,
  });
  await tools.get_route_profile({ origin: 'A', destination: 'B', mode: 'driving' });
  const results = await Promise.all(Array.from({ length: 6 }, () => tools.search_songs({
    max_duration: 240,
    music_phases: [{ energy_range: [0.75, 0.85], pace_range: [0.55, 0.65] }],
  })));
  assert.ok(results.every((songs) => songs[0].song_id === 'clear-match'));
  assert.ok(new Set(results.map((songs) => songs.slice(1, 12).map((song) => song.song_id).join(','))).size > 1);
});

test('音乐阶段标签只软排序候选，不会把不匹配或未标注歌曲过滤掉', async () => {
  const catalog = [
    { song_id: 'reference', title: 'Reference', artist: 'A', duration_sec: 180, energy: 0.9, pace: 0.6, style: 'pop', styles: ['pop'], genres: ['pop'], label_meta: { energy: { confidence: 1 }, pace: { confidence: 1 }, genres: { confidence: 1 }, descriptors: { confidence: 1 } } },
    { song_id: 'unknown', title: 'Unknown labels', artist: 'B', duration_sec: 190, energy: null, pace: null, style: 'unknown', styles: [], genres: [], label_meta: {} },
    { song_id: 'different', title: 'Different style', artist: 'C', duration_sec: 200, energy: 0.2, pace: 0.3, style: 'ambient', styles: ['ambient'], genres: ['ambient'], label_meta: { energy: { confidence: 0.15 }, pace: { confidence: 0.15 }, genres: { confidence: 0.15 }, descriptors: { confidence: 0 } } },
    { song_id: 'too-long', title: 'Too long', artist: 'D', duration_sec: 400, energy: null, style: 'unknown', styles: [], genres: [], label_meta: {} },
  ];
  const tools = createAgentTools({
    calculateRoute: async () => ({ features: {} }),
    getLikedSongs: async () => ({ songs: [] }),
    profileSongs: async () => catalog,
  });

  const candidates = await tools.search_songs({
    max_duration: 240,
    music_phases: [{ energy_range: [0.8, 1], genre_hint: 'pop' }],
  });

  assert.deepEqual(new Set(candidates.map((song) => song.song_id)), new Set(['reference', 'unknown', 'different']));
  assert.equal(candidates[0].song_id, 'reference');
});

test('人工标签不再影响偏好排序，24首样本也正常参与候选', async () => {
  const catalog = [
    { song_id: 'reference', title: 'Reference sample', artist: 'A', duration_sec: 180, energy: 0.8, pace: 0.6, genres: ['indie'], styles: [], style: 'unknown', label_meta: { genres: { source: 'manual', confidence: 1 }, energy: { source: 'manual', confidence: 1 } } },
    { song_id: 'similar', title: 'Similar library song', artist: 'B', duration_sec: 190, energy: 0.8, pace: 0.6, genres: ['indie'], styles: [], style: 'unknown', label_meta: { genres: { source: 'metadata_keywords', confidence: 0.35 }, energy: { source: 'metadata_keywords', confidence: 0.15 } } },
    { song_id: 'different', title: 'Different library song', artist: 'C', duration_sec: 200, energy: 0.1, pace: 0.2, genres: ['ambient'], styles: ['ambient'], style: 'ambient', label_meta: { genres: { source: 'metadata_keywords', confidence: 0.35 }, energy: { source: 'metadata_keywords', confidence: 0.15 } } },
    { song_id: 'unknown', title: 'Unlabeled library song', artist: 'D', duration_sec: 210, energy: null, pace: null, genres: [], styles: [], style: 'unknown', label_meta: {} },
  ];
  const tools = createAgentTools({
    calculateRoute: async () => ({ features: {} }),
    getLikedSongs: async () => ({ songs: [] }),
    profileSongs: async () => catalog,
  });

  const candidates = await tools.search_songs({ max_duration: 240 });
  const byId = new Map(candidates.map((song) => [song.song_id, song]));

  assert.deepEqual(new Set(byId.keys()), new Set(['reference', 'similar', 'different', 'unknown']));
  assert.ok(candidates.every((song) => !Object.hasOwn(song, 'taste_reference_score')));
});

test('Google 路段生成包含节奏、曲折度和场景占比的路线性格', () => {
  const features = extractRouteFeatures({ distanceMeters: 4000, legs: [{ steps: [
    { staticDuration: '300s', travelMode: 'DRIVE', navigationInstruction: { instructions: 'Take Main Street' } },
    { staticDuration: '100s', travelMode: 'DRIVE', navigationInstruction: { instructions: 'Turn onto Pine Lane' } },
  ] }] }, 'DRIVE', 400);
  assert.equal(features.avg_noise, 4.3);
  assert.equal(features.dominant_scene, 'urban_commercial');
  assert.equal(features.route_pace, 'brisk');
  assert.equal(features.route_complexity, 'direct');
  assert.equal(features.turn_count, 1);
  assert.deepEqual(features.scene_distribution, { urban_commercial: 0.75, residential_quiet: 0.25 });
  assert.deepEqual(features.route_cues, ['Take Main Street', 'Turn onto Pine Lane']);
});

test('无法识别的道路不会再被误判成公园', () => {
  const features = extractRouteFeatures({ distanceMeters: 900, legs: [{ steps: [
    { staticDuration: '600s', travelMode: 'WALK', navigationInstruction: { instructions: 'Head northeast' } },
  ] }] }, 'WALK', 600);
  assert.equal(features.dominant_scene, 'unknown');
  assert.deepEqual(features.scene_distribution, { unknown: 1 });
  assert.equal(features.avg_noise, 4);
});

test('路线 polyline 只生成最多四个等距代表点', () => {
  const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  const samples = sampleRoute(points, 4);
  assert.equal(points.length, 3);
  assert.equal(samples.length, 3);
  assert.ok(samples.every((sample) => sample.ratio > 0 && sample.ratio < 1));
  assert.ok(ROUTE_PLACE_TYPES.length <= 30);
});

test('Places 采样被压缩为可供导语使用的连续路段画像', () => {
  const samples = Array.from({ length: 4 }, (_, index) => ({ latitude: 35.7 + index * 0.01, longitude: 139.5, ratio: (index + 0.5) / 4 }));
  const area = (name) => [{ longText: name, types: ['sublocality_level_2'] }];
  const segments = buildRouteSegments(samples, [
    [{ primaryType: 'park', displayName: { text: '井の頭公園' }, addressComponents: area('吉祥寺') }, { primaryType: 'cafe', addressComponents: area('吉祥寺') }],
    [],
    [{ primaryType: 'live_music_venue', displayName: { text: 'ライブハウス' }, addressComponents: area('高円寺') }, { primaryType: 'thrift_store', addressComponents: area('高円寺') }, { primaryType: 'cafe', addressComponents: area('高円寺') }],
    [{ primaryType: 'restaurant', addressComponents: area('中野') }, { primaryType: 'restaurant', addressComponents: area('中野') }, { primaryType: 'shopping_mall', addressComponents: area('中野') }, { primaryType: 'video_arcade', addressComponents: area('中野') }, { primaryType: 'train_station', addressComponents: area('中野') }],
  ]);

  assert.equal(segments.length, 4);
  assert.deepEqual(segments[0].traits.slice(0, 3), ['greenery', 'park-edge', 'cafe-dotted']);
  assert.ok(segments[1].traits.includes('residential'));
  assert.ok(segments[2].traits.includes('alternative-culture'));
  assert.ok(segments[3].traits.includes('active-pedestrian-proxy'));
  assert.equal(segments[3].label, '中野周边');
});

test('路线采样点按 Places 地址/地点名匹配候选街区，并只附加已有意象', () => {
  const place = {
    displayName: { text: '神保町駅' },
    addressComponents: [{ longText: '神保町', types: ['sublocality_level_2'] }],
  };
  const matched = matchRouteNeighborhood([place]);
  assert.equal(matched.name, '神保町');
  assert.deepEqual(matched.ward, ['千代田区']);
  assert.equal(matched.imagery.area, '神保町');
  assert.ok(matched.imagery.images.length <= 2);
  assert.ok(matched.imagery.images.every((image) => image.associations.length <= 2));

  const segments = buildRouteSegments(
    [{ latitude: 35.7, longitude: 139.7 }, { latitude: 35.71, longitude: 139.71 }],
    [
      [{ ...place, primaryType: 'cafe' }],
      [{
        primaryType: 'cafe',
        addressComponents: [{ longText: '麻布十番', types: ['neighborhood'] }],
      }],
    ],
  );
  assert.equal(segments.length, 2, '不同街区的相同 POI 画像不可合并');
  assert.deepEqual(segments.map((segment) => segment.matched_area.name), ['神保町', '麻布十番']);
  assert.equal(segments[0].imagery.images.length, 2);
  assert.equal(segments[1].imagery.area, '麻布十番', '扩展后的街区应直接复用已有意象');
  assert.equal(segments[1].imagery.images.length, 2);
});

test('附近 POI 跨街区时优先采样点占主导的地址区域', () => {
  const places = [
    { addressComponents: [{ longText: '神田駿河台', types: ['sublocality_level_2'] }] },
    { addressComponents: [{ longText: '神田駿河台', types: ['sublocality_level_2'] }] },
    {
      displayName: { text: '神保町駅' },
      addressComponents: [{ longText: '神保町', types: ['sublocality_level_2'] }],
    },
  ];
  assert.equal(matchRouteNeighborhood(places).name, '御茶ノ水');
});

test('区域名信息不足时不猜测东池袋或西池袋', () => {
  const match = matchRouteNeighborhood([{
    addressComponents: [{ longText: '池袋', types: ['sublocality_level_2'] }],
  }]);
  assert.equal(match, null);
});

test('23区以外的吉祥寺仍可复用已有意象记录', () => {
  const match = matchRouteNeighborhood([{
    addressComponents: [{ longText: '吉祥寺', types: ['sublocality_level_2'] }],
  }]);
  assert.equal(match.name, '吉祥寺');
  assert.equal(match.scope, 'outside_23_wards');
  assert.equal(match.imagery.area, '吉祥寺');
});

test('具体公园地点名可在吉祥寺周边样本中命中井之头公园意象', () => {
  const match = matchRouteNeighborhood([{
    displayName: { text: '井の頭恩賜公園' },
    addressComponents: [{ longText: '吉祥寺南町', types: ['sublocality_level_2'] }],
  }]);
  assert.equal(match.name, '井の頭公園');
  assert.equal(match.imagery.area, '井の頭公園');
});

test('路线终点提示可在附近结果仅含吉祥寺地址时匹配井之头公园', () => {
  const segments = buildRouteSegments(
    [{ latitude: 35.702, longitude: 139.58, ratio: 0.92 }],
    [[{ addressComponents: [{ longText: '吉祥寺南町', types: ['neighborhood'] }] }]],
    { destination: '井の頭公園' },
  );
  assert.equal(segments[0].matched_area.name, '井の頭公園');
  assert.equal(segments[0].matched_area.match_source, 'route_endpoint');
});

test('车站后缀会被规范化，银座站不会误命中户越银座', () => {
  const match = matchRouteNeighborhood([], '銀座駅');
  assert.equal(match.name, '銀座');
  assert.equal(match.matched_by, 'route_endpoint');
});

test('路线空间匹配按完整折线顺序识别相邻意象区域', () => {
  const matches = matchRouteAreas([
    { latitude: 35.6957, longitude: 139.752 },
    { latitude: 35.6975, longitude: 139.761 },
    { latitude: 35.6994, longitude: 139.770 },
  ]);
  assert.deepEqual(matches.map((area) => area.name), ['神保町', '御茶ノ水', '秋葉原']);
  assert.ok(matches[0].end_ratio < matches[1].start_ratio);
  assert.ok(matches.every((area) => area.match_source === 'geometry_circle'));
  assert.ok(matches.every((area) => area.confidence >= 0.68 && area.confidence <= 0.97));
});

test('RouteContext 汇总空间区域、已有意象与 Places 覆盖状态', () => {
  const routeContext = buildRouteContext({
    encodedPolyline: encodePolyline([
      { latitude: 35.6957, longitude: 139.752 },
      { latitude: 35.6975, longitude: 139.761 },
      { latitude: 35.6994, longitude: 139.770 },
    ]),
    environmentSegments: [{ label: '路线中段', start_ratio: 0.3, end_ratio: 0.6, sample_ratios: [0.45], traits: ['cafe-dotted'] }],
    placesStatus: 'complete',
    placesSampleCount: 4,
  });
  assert.deepEqual(routeContext.areas.map((area) => area.name), ['神保町', '御茶ノ水', '秋葉原']);
  assert.equal(routeContext.areas[0].imagery.area, '神保町');
  assert.equal(routeContext.areas[2].imagery.area, '秋葉原', '新增街区命中后应带出 DeepSeek 意象');
  assert.equal(routeContext.coverage.environment_segment_count, 1);
  assert.equal(routeContext.coverage.places_sample_count, 4);
  assert.deepEqual(routeContext.environment_segments, [{ label: '路线中段', start_ratio: 0.3, end_ratio: 0.6, sample_ratios: [0.45], traits: ['cafe-dotted'] }]);
  assert.ok(routeContext.transition_segments.length >= 1);
  assert.ok(routeContext.transition_segments.some((segment) => segment.traits.includes('cafe-dotted')));
  assert.ok(routeContext.coverage.unmatched_distance_m > 0);
  assert.ok(routeContext.areas[0].imagery.images.length <= 2);
  assert.equal(routeContext.coverage.candidate_area_count, 100);
});

test('Places 采样将长未命名间隔纳入固定四次请求预算', () => {
  const points = [
    { latitude: 35.7, longitude: 139.7 },
    { latitude: 35.7, longitude: 139.76 },
  ];
  const areas = [
    { id: 'start', name: '起点区域', ward: [], aliases: ['起点'], center: { lat: 35.7, lng: 139.7 }, radius_m: 180 },
    { id: 'end', name: '终点区域', ward: [], aliases: ['终点'], center: { lat: 35.7, lng: 139.76 }, radius_m: 180 },
  ];
  const ratios = planRoutePlaceSampleRatios(points, areas, 30, { origin: '起点', destination: '终点' }, 4);
  assert.equal(ratios.length, 4);
  assert.ok(ratios.some((ratio) => Math.abs(ratio - 0.5) < 0.01), '最长未匹配区间中点应得到采样');
  assert.ok(ratios[0] < 0.15 && ratios.at(-1) > 0.85, '保留起终点环境采样');
});

test('没有命名区域的长路段被明确保留为未命名过渡段', () => {
  const routeContext = buildRouteContext({
    encodedPolyline: encodePolyline([
      { latitude: 35.45, longitude: 139.45 },
      { latitude: 35.46, longitude: 139.46 },
    ]),
  });
  assert.deepEqual(routeContext.areas, []);
  assert.equal(routeContext.transition_segments.length, 1);
  assert.equal(routeContext.transition_segments[0].label, '未命名过渡段');
  assert.ok(routeContext.transition_segments[0].distance_m > 1000);
});

test('待核验或无效几何的候选街区不会参与路线匹配', () => {
  const matches = matchRouteAreas([
    { latitude: 35.7000, longitude: 139.7700 },
    { latitude: 35.7001, longitude: 139.7701 },
  ], [
    { id: 'unresolved', name: '待核验区域', ward: ['東京都'], active: false, center: null, radius_m: null },
    { id: 'valid', name: '有效区域', ward: ['東京都'], center: { lat: 35.7000, lng: 139.7700 }, radius_m: 200 },
  ]);
  assert.deepEqual(matches.map((area) => area.name), ['有效区域']);
});

test('路线不进入试点区域时空间匹配保持为空，不猜测街区', () => {
  const matches = matchRouteAreas([
    { latitude: 35.675, longitude: 139.690 },
    { latitude: 35.676, longitude: 139.691 },
  ]);
  assert.deepEqual(matches, []);
});

test('精确选择的区域端点作为路线首尾证据保留', () => {
  const matches = matchRouteAreas([
    { latitude: 35.7033, longitude: 139.5798 },
    { latitude: 35.7020, longitude: 139.5770 },
  ], undefined, 30, { origin: '吉祥寺駅', destination: '井の頭恩賜公園' });
  assert.equal(matches[0].name, '吉祥寺');
  assert.equal(matches.at(-1).name, '井の頭公園');
  assert.ok(['route_endpoint', 'geometry_and_endpoint'].includes(matches.at(-1).match_source));
});

test('同一逻辑区域的相邻圆区小间隙会合并并记录桥接距离', () => {
  const route = [{ latitude: 35.7, longitude: 139.7 }, { latitude: 35.7, longitude: 139.708 }];
  const twoCircles = [
    { id: 'same-area', name: '同一区域', ward: [], center: { lat: 35.7, lng: 139.701 }, radius_m: 230 },
    { id: 'same-area', name: '同一区域', ward: [], center: { lat: 35.7, lng: 139.707 }, radius_m: 230 },
  ];
  const matches = matchRouteAreas(route, twoCircles, 30);
  assert.equal(matches.length, 1);
  assert.ok(matches[0].bridged_gap_m > 0);
  assert.equal(matches[0].name, '同一区域');
});

function encodePolyline(points) {
  let previousLat = 0;
  let previousLng = 0;
  const encodeValue = (value) => {
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    let encoded = '';
    while (shifted >= 0x20) {
      encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    return encoded + String.fromCharCode(shifted + 63);
  };
  return points.map(({ latitude, longitude }) => {
    const lat = Math.round(latitude * 1e5);
    const lng = Math.round(longitude * 1e5);
    const value = encodeValue(lat - previousLat) + encodeValue(lng - previousLng);
    previousLat = lat;
    previousLng = lng;
    return value;
  }).join('');
}

test('DeepSeek 返回未知风格时自动降级为不限风格', () => {
  const plan = parseDeepSeekPlan({
    summary: '测试计划',
    search: { energy_range: [0.3, 0.8], max_duration: 420, genre_hint: '一段错误的字段说明' },
    use_dp: true,
    revision_hint: '下一轮放宽范围',
  });
  assert.equal(plan.search.genre_hint, null);
});

test('DeepSeek 返回过长摘要时自动截短而不中断', () => {
  const plan = parseDeepSeekPlan({
    summary: '规划'.repeat(150),
    search: { energy_range: [0.3, 0.8], max_duration: 420, genre_hint: null },
    use_dp: true,
    revision_hint: '修正'.repeat(150),
  });
  assert.equal(plan.summary.length, 200);
  assert.equal(plan.revision_hint.length, 200);
});

test('DeepSeek 常见字段偏差会被规范化为安全值', () => {
  const plan = parseDeepSeekPlan({
    summary: '', search: { energy_range: [-3, 7], max_duration: '9999' },
    use_dp: 'true', revision_hint: null,
  });
  assert.deepEqual(plan.search.energy_range, [0, 1]);
  assert.equal(plan.search.max_duration, 900);
  assert.equal(plan.use_dp, true);
  assert.ok(plan.summary.length > 0);

  const selection = parseDeepSeekSelection({ use_dp: 'false', song_ids: null, max_songs: 100 });
  assert.equal(selection.use_dp, false);
  assert.deepEqual(selection.song_ids, []);
  assert.equal(selection.max_songs, 20);
});

test('重试未返回创作字段时沿用首轮路线解读与双语诗', () => {
  const previousCreative = {
    route_interpretation: { core_image_ids: ['image_1'], movement_arc: '沿河走向桥边' },
    route_poem: { ja: ['川の灯', '橋を渡れば', '夜の駅'], zh: ['河灯微明', '过桥以后', '夜色抵达车站'] },
  };
  const revised = parseDeepSeekPlan({
    summary: '只修正音乐策略',
    music_strategy: { overall_arc: '渐进后收束', sampling_roles: [] },
    search: { energy_range: [0.2, 0.8], max_duration: 420 },
    use_dp: true,
    revision_hint: '再调整阶段能量',
  }, [], [{ image_id: 'image_1' }], [], previousCreative);

  assert.deepEqual(revised.route_interpretation, previousCreative.route_interpretation);
  assert.deepEqual(revised.route_poem, previousCreative.route_poem);
});

test('DeepSeek 空响应后的重试关闭推理并强制精简 JSON', () => {
  const first = buildDeepSeekBody({ task: 'test' }, { thinkingEnabled: true, fallback: false });
  const fallback = buildDeepSeekBody({ task: 'test' }, { thinkingEnabled: true, fallback: true });

  assert.equal(first.thinking.type, 'enabled');
  assert.equal(first.reasoning_effort, 'high');
  assert.equal(fallback.thinking.type, 'disabled');
  assert.equal('reasoning_effort' in fallback, false);
  assert.match(fallback.messages[1].content, /直接输出.*JSON/);
  assert.match(first.messages[0].content, /在一次请求中按顺序完成两项工作/);
  assert.match(first.messages[0].content, /中文现代自由诗式译文/);
});

test('LRC 解析支持多时间戳、毫秒与排序', () => {
  const lines = parseTimedLines('[00:12.50][00:24.500]副歌\n[00:03.1]开场\n[ar:歌手]');
  assert.deepEqual(lines, [
    { time: 3.1, text: '开场' },
    { time: 12.5, text: '副歌' },
    { time: 24.5, text: '副歌' },
  ]);
});

test('LRC 解析合并翻译并为无时间轴歌词提供顺序', () => {
  assert.deepEqual(parseLyrics('[00:01.00]Hello', '[00:01.00]你好'), [
    { time: 1, text: 'Hello', translation: '你好' },
  ]);
  assert.deepEqual(parseLyrics('第一行\n第二行'), [
    { time: 0, text: '第一行', translation: '' },
    { time: 4, text: '第二行', translation: '' },
  ]);
});

test('播放信息接口同时返回音频地址和歌词，不因音频元数据作用域报错', async () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Content-Type', 'application/json');
    if (path === '/song/url/v1') {
      response.end(JSON.stringify({ code: 200, data: [{ url: 'https://audio.example/song.mp3', type: 'mp3', level: 'standard' }] }));
      return;
    }
    if (path === '/lyric') {
      response.end(JSON.stringify({ code: 200, lrc: { lyric: '[00:01.00]Hello' }, tlyric: { lyric: '[00:01.00]你好' } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 404 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previousBaseUrl = process.env.NETEASE_API_BASE_URL;
  const previousCookie = process.env.NETEASE_COOKIE;
  process.env.NETEASE_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NETEASE_COOKIE = 'test-cookie';
  try {
    assert.deepEqual(await getSongPlayback('123'), {
      songId: '123',
      audioUrl: 'https://audio.example/song.mp3',
      type: 'mp3',
      level: 'standard',
      lyric: '[00:01.00]Hello',
      translatedLyric: '[00:01.00]你好',
    });
  } finally {
    if (previousBaseUrl === undefined) delete process.env.NETEASE_API_BASE_URL;
    else process.env.NETEASE_API_BASE_URL = previousBaseUrl;
    if (previousCookie === undefined) delete process.env.NETEASE_COOKIE;
    else process.env.NETEASE_COOKIE = previousCookie;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// Genre and sound intensity must remain independent; metadata-only labels stay conservative.
test('歌曲标签保留未知能量、多风格和证据来源', () => {
  const song = profileSong({ id: 1, name: 'Rock Pop', artists: 'Metal', album: 'Indie Soundtrack', durationMs: 180000 });
  assert.equal(song.energy, null);
  assert.ok(song.genres.includes('rock') && song.genres.includes('pop') && song.genres.includes('indie'));
  assert.ok(!song.genres.includes('metal'));
  assert.equal(song.valence, null);
  assert.equal(profileSong({ id: 2, name: 'Rocket', durationMs: 1000 }).genres.length, 0);
  assert.equal(profileSong({ id: 1, durationMs: 1000 }).energy, null);
});

test('歌曲缓存随算法版本刷新元数据，不应用人工覆盖', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { profileCatalog } = await import('../src/services/song-profile-cache.js');
  const directory = await mkdtemp(join(tmpdir(), 'song-profile-test-'));
  try {
    const options = { cachePath: join(directory, 'cache.json') };
    const songs = [{ id: 1, name: 'Rock', durationMs: 1000 }];
    await profileCatalog(songs, options);
    assert.equal((await profileCatalog(songs, options))[0].energy, null);
    const updated = await profileCatalog([{ ...songs[0], name: 'Ambient' }], options);
    assert.deepEqual(updated[0].genres, ['ambient']);
    assert.equal(updated[0].energy, null);
    assert.equal(JSON.parse(await readFile(options.cachePath)).version, PROFILE_VERSION);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('音频预分析特征提供归一化能量与节奏值', async () => {
  const { extractAudioFeatures } = await import('../src/services/song-audio-features.js');
  const sampleRate = 8000;
  const pcm = new Float32Array(sampleRate * 8);
  for (let index = 0; index < pcm.length; index += 1) {
    const pulse = index % 400;
    pcm[index] = pulse < 32 ? Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.6 : 0;
  }
  const features = extractAudioFeatures([pcm], sampleRate);
  assert.ok(features.energy_components.loudness_db < 0);
  assert.ok(features.energy_components.onsets_per_minute >= 0);
  assert.ok(features.energy_components.active_ratio >= 0 && features.energy_components.active_ratio <= 1);
  assert.ok(features.energy_components.dynamic_range_db >= 0);
  assert.ok(features.pace >= 0 && features.pace <= 1);
  assert.ok(Number.isFinite(features.bpm));
});

test('仅仅存在预计算缓存不会给歌曲额外选歌分', () => {
  const song = { energy: 0.6, pace: 0.4, label_meta: { energy: { confidence: 0.85 }, pace: { confidence: 0.85 } } };
  const phase = { energy_range: [0.5, 0.7], pace_range: [0.3, 0.5] };
  assert.equal(songStrategyScore(song, phase), songStrategyScore({ ...song, audio_features: { analyzed_at: 'now' } }, phase));
});

test('小样本覆盖不足时不会用已测歌曲的音频特征排序', async () => {
  const catalog = [
    { song_id: 'measured', title: 'Measured', artist: 'A', duration_sec: 180, energy: null, pace: null, label_meta: {}, audio_features: { energy: 0.95, pace: 0.9, confidence: 0.85 } },
    ...['B', 'C', 'D'].map((artist, index) => ({ song_id: `other-${index}`, title: 'Other', artist, duration_sec: 180, energy: null, pace: null, label_meta: {} })),
  ];
  const tools = createAgentTools({
    calculateRoute: async () => ({ features: {} }), getLikedSongs: async () => ({ songs: [] }),
    profileSongs: async () => catalog,
  });
  const candidates = await tools.search_songs({ max_duration: 200, music_phases: [{ energy_range: [0.9, 1], pace_range: [0.8, 1] }] });
  assert.equal(candidates.find((song) => song.song_id === 'measured').energy, null);
});

test('音频覆盖达到阈值后，未分析歌曲仍可作为中性候选', async () => {
  const measured = ['A', 'B', 'C'].map((artist, index) => ({
    song_id: `measured-${index}`, title: 'Measured', artist, duration_sec: 180,
    energy: null, pace: null, label_meta: {},
    audio_features: { energy: 0.2 + index * 0.1, pace: 0.3 + index * 0.1, confidence: 0.8 },
  }));
  const unmeasured = {
    song_id: 'unmeasured', title: 'Unmeasured', artist: 'D', duration_sec: 180,
    energy: null, pace: null, label_meta: {},
  };
  const tools = createAgentTools({
    calculateRoute: async () => ({ features: {} }), getLikedSongs: async () => ({ songs: [] }),
    profileSongs: async () => [...measured, unmeasured],
  });

  const candidates = await tools.search_songs({ max_duration: 200, music_phases: [{ energy_range: [0.2, 0.8], pace_range: [0.3, 0.7] }] });
  assert.equal(candidates.length, 4);
  assert.equal(candidates.find((song) => song.song_id === 'measured-0').energy, 0.2);
  assert.equal(candidates.find((song) => song.song_id === 'unmeasured').energy, null);
  assert.equal(candidates.find((song) => song.song_id === 'unmeasured').pace, null);
});

test('最近歌单中的歌曲会被软性降权，时长匹配时优先选新歌', () => {
  const penalties = computeRecentSelectionPenalties([
    { selected: [{ song_id: 'repeat', artist: 'Band X' }, { song_id: 'same-band', artist: 'Band X' }] },
    { selected: [{ song_id: 'repeat', artist: 'Band X' }, { song_id: 'other-repeat', artist: 'Band Y' }] },
  ]);
  assert.equal(penalties.get('repeat'), 3.24);
  assert.equal(penalties.get('other-repeat'), 1.8);
  assert.equal(penalties.get('artist:band x'), 0.75 + 0.75 * 0.82);
  assert.equal(penalties.get('artist:band y'), 0.75);

  const chosen = solveDuration([
    { song_id: 'repeat', duration_sec: 180, selection_recency_penalty: penalties.get('repeat') },
    { song_id: 'fresh', duration_sec: 180 },
  ], 180, { energy_range: [0, 1] });
  assert.deepEqual(chosen, ['fresh']);
});

test('近期反复出现的歌手会被压低，且同一路线每次重新轮转候选起点', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sound-map-recency-'));
  const diagnosticsPath = path.join(directory, 'selection.jsonl');
  await writeFile(diagnosticsPath, [
    JSON.stringify({ selected: [{ song_id: 'prev-1', artist: 'Band X' }] }),
    JSON.stringify({ selected: [{ song_id: 'prev-2', artist: 'Band X' }, { song_id: 'prev-3', artist: 'Band X' }] }),
  ].join('\n'));
  const catalog = [
    { song_id: 'band-repeat', title: 'Recent Artist', artist: 'Band X', duration_sec: 180, energy: 0.5, pace: 0.5, label_meta: { energy: { confidence: 0 }, pace: { confidence: 0 } } },
    { song_id: 'band-new-song', title: 'Another Recent Artist Song', artist: 'Band X', duration_sec: 180, energy: 0.5, pace: 0.5, label_meta: { energy: { confidence: 0 }, pace: { confidence: 0 } } },
    { song_id: 'artist-fresh', title: 'Fresh Artist', artist: 'Band Y', duration_sec: 180, energy: 0.5, pace: 0.5, label_meta: { energy: { confidence: 0 }, pace: { confidence: 0 } } },
  ];
  try {
    const tools = createAgentTools({
      calculateRoute: async () => ({ features: { total_duration_sec: 1800 } }),
      getLikedSongs: async () => ({ songs: [] }),
      profileSongs: async () => catalog,
      diagnosticsPath,
    });
    await tools.get_route_profile({ origin: 'A', destination: 'B', mode: 'driving' });
    const results = await Promise.all(Array.from({ length: 12 }, () => tools.search_songs({
      max_duration: 240,
      music_phases: [{ energy_range: [0, 1], pace_range: [0, 1] }],
    })));
    assert.ok(results.every((songs) => songs[0].song_id === 'artist-fresh'));
    assert.ok(results.every((songs) => songs.length === 3));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('路线阶段参与组合优化，所选歌曲按实际播放位置匹配能量', () => {
  const songs = [
    { song_id: 'high', artist: 'High artist', duration_sec: 100, energy: 0.9, pace: 0.5, label_meta: { energy: { confidence: 1 }, pace: { confidence: 1 } } },
    { song_id: 'low', artist: 'Low artist', duration_sec: 100, energy: 0.2, pace: 0.5, label_meta: { energy: { confidence: 1 }, pace: { confidence: 1 } } },
  ];
  const musicPhases = [
    { phase_id: 'opening', start_ratio: 0, end_ratio: 0.5, energy_range: [0.1, 0.3] },
    { phase_id: 'ending', start_ratio: 0.5, end_ratio: 1, energy_range: [0.8, 1] },
  ];
  const chosen = solveDuration(songs, 200, { music_phases: musicPhases });
  assert.deepEqual(chosen, ['low', 'high']);
  assert.equal(new Set(chosen).size, chosen.length);
});

test('相同路线的近似歌曲组合允许变化，阶段能量走向仍然稳定', () => {
  const songs = Array.from({ length: 12 }, (_, index) => ({
    song_id: `variant-${index}`, artist: `Artist ${index}`, duration_sec: 100,
    energy: 0.5, pace: 0.5,
    label_meta: { energy: { confidence: 1 }, pace: { confidence: 1 } },
  }));
  const musicPhases = [
    { phase_id: 'opening', start_ratio: 0, end_ratio: 0.5, energy_range: [0.4, 0.6], pace_range: [0.4, 0.6] },
    { phase_id: 'ending', start_ratio: 0.5, end_ratio: 1, energy_range: [0.4, 0.6], pace_range: [0.4, 0.6] },
  ];
  const playlists = Array.from({ length: 12 }, () => solveDuration(songs, 300, { music_phases: musicPhases }));
  assert.ok(playlists.every((playlist) => playlist.length === 3));
  assert.ok(new Set(playlists.map((playlist) => [...playlist].sort().join(','))).size > 1);
  assert.ok(playlists.every((playlist) => playlist.every((id) => songs.some((song) => song.song_id === id))));
});

test('阶段优化后的播放顺序会保留，并按各曲目的实际位置标记路线阶段', async () => {
  const tools = createAgentTools({
    calculateRoute: async () => ({ features: {} }),
    getLikedSongs: async () => ({ songs: [] }),
    profileSongs: async () => [],
    diagnosticsPath: null,
  });
  const phases = [
    { phase_id: 'opening', start_ratio: 0, end_ratio: 0.5, evidence: { areas: ['起点'] } },
    { phase_id: 'ending', start_ratio: 0.5, end_ratio: 1, evidence: { areas: ['终点'] } },
  ];
  const playlist = [
    { song_id: 'low', title: 'Low', artist: 'A', duration_sec: 100 },
    { song_id: 'high', title: 'High', artist: 'B', duration_sec: 100 },
  ];
  const result = await tools.finalize_output({
    input: { origin: 'A', destination: 'B' },
    route_profile: { total_duration_sec: 200 },
    draft: { song_ids: ['low', 'high'], songs: playlist, total_seconds: 200, music_phases: phases, phase_ordered: true },
  });
  assert.deepEqual(result.playlist.map((song) => song.title), ['Low', 'High']);
  assert.deepEqual(result.playlist.map((song) => song.phase_id), ['opening', 'ending']);
});
