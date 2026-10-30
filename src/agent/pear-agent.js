import { randomUUID } from 'node:crypto';
import { ToolRunner } from './tool-runner.js';



export async function runPearAgent({ input, planner, tools, emit = () => {}, maxIterations = 3, toolTimeoutMs = 2000 }) {
  const runner = new ToolRunner(tools, { timeoutMs: toolTimeoutMs });
  const generationId = randomUUID();
  const traces = [];
  const timings = {};
  const totalStartedAt = performance.now();
  const measure = async (name, operation) => {
    const startedAt = performance.now();
    try { return await operation(); }
    finally { timings[name] = (timings[name] ?? 0) + Math.round(performance.now() - startedAt); }
  };
  const publish = (stage, message) => {
    const summary = `${stage}: ${message}`;
    traces.push(summary);
    emit({ stage, message: summary });
  };

  publish('感知', '正在读取路线与道路环境。');
  const routeProfile = await measure('route_and_library_ms', () => runner.call('get_route_profile', input));
  publish('感知', `路线约 ${Math.round(routeProfile.total_duration_sec / 60)} 分钟，主场景为 ${routeProfile.dominant_scene}。`);

  let draft = null;
  let evaluation = null;
  let iterations = 0;
  let dpUsed = false;
  let introduction = '';
  let routePoem = null;
  let routeInterpretation = null;
  let musicStrategy = null;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    iterations = iteration;
    const decision = await measure('planning_ms', () => planner.plan({
      iteration, input, routeProfile, previousDraft: draft, previousEvaluation: evaluation,
      previousCreativeOutput: routePoem && routeInterpretation
        ? { route_poem: routePoem, route_interpretation: routeInterpretation }
        : undefined,
    }));
    introduction = decision.introduction || introduction;
    routePoem = decision.route_poem ?? routePoem;
    routeInterpretation = decision.route_interpretation ?? routeInterpretation;
    musicStrategy = decision.music_strategy ?? musicStrategy;
    publish('规划', decision.summary);

    const candidates = await measure('song_search_ms', () => runner.call('search_songs', decision.search));
    publish('行动', `按本轮策略找到 ${candidates.length} 首候选歌曲。`);
    if (!candidates.length) {
      evaluation = { acceptable: false, reason: '候选歌曲为空' };
      publish('反思', '本轮没有候选歌曲，下一轮将放宽筛选条件。');
      continue;
    }

    // The local DP and remote candidate review are independent once the candidates exist.
    // Start DP while the model reviews, but preserve the model's final choice of selection mode.
    const dpTask = decision.use_dp
      ? measure('dp_ms', () => runner.call('dp_solver', { songs: candidates, target_seconds: routeProfile.total_duration_sec, strategy: decision.search }))
        .then((songIds) => ({ songIds }), (error) => ({ error }))
      : null;
    if (dpTask) await Promise.resolve();
    const selection = planner.select
      ? await measure('selection_ms', () => planner.select({ decision, candidates, routeProfile, previousDraft: draft, previousEvaluation: evaluation }))
      : decision;
    if (selection.summary) publish('行动', selection.summary);

    let songIds;
    let selectionMethod = selection.use_dp
      ? decision.search.music_phases?.length > 1 ? 'route_aware_dp' : 'duration_dp'
      : selection.song_ids?.length ? 'planner' : 'top_candidates_fallback';
    if (selection.use_dp) {
      if (dpTask) {
        const result = await dpTask;
        if (result.error) throw result.error;
        songIds = result.songIds;
      } else {
        songIds = await measure('dp_ms', () => runner.call('dp_solver', { songs: candidates, target_seconds: routeProfile.total_duration_sec, strategy: decision.search }));
      }
      dpUsed = dpUsed || songIds.length > 0;
    }
    if (!songIds?.length) songIds = selection.song_ids?.filter((id) => candidates.some((song) => String(song.song_id) === String(id))) ?? [];
    if (!songIds.length) songIds = candidates.slice(0, selection.max_songs ?? decision.max_songs ?? 8).map((song) => song.song_id);

    const duration = await measure('duration_ms', () => runner.call('calculate_duration', { song_ids: songIds, songs: candidates }));
    evaluation = evaluateDraft(duration.total_seconds, routeProfile.total_duration_sec);
    draft = {
      song_ids: songIds,
      songs: candidates,
      total_seconds: duration.total_seconds,
      music_phases: decision.search.music_phases ?? [],
      phase_ordered: selection.use_dp && decision.search.music_phases?.length > 1,
      selection_method: selectionMethod,
    };
    publish('反思', evaluation.summary);
    if (evaluation.acceptable) break;
    if (iteration < maxIterations) publish('修正', decision.revision_hint ?? '下一轮将调整筛选范围和歌曲组合。');
  }

  if (!draft) throw new Error('Agent 在三轮内未能生成任何候选歌单。');
  const output = await measure('finalize_ms', () => runner.call('finalize_output', { input, route_profile: routeProfile, draft, evaluation, iterations, dp_used: dpUsed, generation_id: generationId }));
  timings.total_ms = Math.round(performance.now() - totalStartedAt);
  return {
    ...output,
    generation_id: generationId,
    introduction: introduction || output.announcement,
    route_poem: routePoem,
    route_interpretation: routeInterpretation,
    music_strategy: musicStrategy,
    agent_iterations: iterations,
    dp_used: dpUsed,
    timings_ms: timings,
    thinking_traces: traces,
  };
}

function evaluateDraft(total, target) {
  const delta = total - target;
  const durationOk = delta >= -60 && delta <= 30;
  return {
    acceptable: durationOk,
    duration_ok: durationOk,
    delta_seconds: delta,
    summary: durationOk ? `总时长 ${total} 秒，已进入允许误差。` : `总时长 ${total} 秒，与目标相差 ${delta} 秒。`,
  };
}
