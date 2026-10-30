import { ProxyAgent } from 'undici';
import { z } from 'zod';
import { buildMusicPhaseSkeleton } from '../services/music-phases.js';

const GENRE_HINTS = ['high_energy', 'pop', 'acoustic', 'ambient', 'unknown'];
const displayText = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().slice(0, 200) : value),
  z.string().min(1).max(200),
);

const planSchema = z.object({
  summary: displayText,
  introduction: displayText,
  route_interpretation: z.object({
    core_image_ids: z.array(z.string().max(40)).max(4),
    movement_arc: displayText,
  }),
  music_strategy: z.object({
    overall_arc: displayText,
    sampling_roles: z.array(z.object({
      anchor_id: z.string().max(32),
      role: z.enum(['opening', 'development', 'transition', 'ending']),
    })).max(4),
  }),
  route_poem: z.object({
    ja: z.tuple([displayText, displayText, displayText]),
    zh: z.tuple([displayText, displayText, displayText]),
  }),
  search: z.object({
    energy_range: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    max_duration: z.number().int().min(60).max(900),
    pace_range: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
    sound_hints: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
    // 模型偶尔会把字段说明原样填入；未知值按“不限定风格”安全降级。
    genre_hint: z.preprocess(
      (value) => (GENRE_HINTS.includes(value) ? value : null),
      z.enum(GENRE_HINTS).nullable(),
    ).optional(),
    music_phases: z.array(z.object({
      phase_id: z.string().min(1).max(32),
      start_ratio: z.number().min(0).max(1),
      end_ratio: z.number().min(0).max(1),
      midpoint_ratio: z.number().min(0).max(1),
      evidence: z.object({
        areas: z.array(z.string()).max(3),
        imagery: z.array(z.string()).max(6),
        transitions: z.array(z.string()).max(6),
        environment: z.array(z.string()).max(6),
      }),
      energy_range: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
      pace_range: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
      genre_hint: z.preprocess((value) => (GENRE_HINTS.includes(value) ? value : null), z.enum(GENRE_HINTS).nullable()).optional(),
      sound_hints: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
    })).max(5).optional(),
  }),
  use_dp: z.boolean(),
  max_songs: z.number().int().min(1).max(20).optional(),
  revision_hint: displayText,
});

const selectionSchema = z.object({
  summary: displayText,
  use_dp: z.boolean(),
  song_ids: z.array(z.union([z.string(), z.number()])).max(20).default([]),
  max_songs: z.number().int().min(1).max(20).optional(),
});

const SYSTEM_PROMPT = `你是路线音乐策展 Agent。只从用户“我喜欢的音乐”候选中选歌，总时长目标为路线时长[-60,+30]秒。可以使用DP。不要输出隐藏思维过程；只返回要求的结构化 JSON。

在一次请求中按顺序完成两项工作：
1. 路线解读：从 imagery_candidates 中挑选2到4个最有辨识度、可产生联想的具体意象，只返回其 image_id。总结路线的移动方式与场景变化。街区意象是创作素材，不是诗中需要介绍的地名。transition_segments 只表达连接、节奏和场景变化，不得从中创造具体地点或物件；environment evidence 只可用于描述其真实采样到的环境。
2. 音乐策略与中日俳句：先使用路线移动、阶段长度和场景变化规划各阶段的音乐能量与节奏，再将歌曲元数据中的风格和声音特征作为辅助匹配条件。意象可以给音乐提供颜色，但不能成为选歌的唯一依据。sampling anchors 是整条音乐叙事线上的锚点，不是互相独立的推荐点。然后写日语俳句风格的三行短诗，并创作逐行对应的中文现代自由诗式译文。日语原作追求凝练、意象并置、切分与余韵；只有输入证据明确提供季节信息时才使用季语。中文应自然、简洁，有现代诗的节奏和留白；允许调整语序、压缩或展开语义，不逐词硬译，但须保留日语该行的核心意象、动作和情绪转折。译文不能增加路线证据之外的新地点、天气、人物或景物，不模仿某一位具体诗人。`;

let proxyAgent;

export class DeepSeekPlanner {
  async plan({ iteration, input, routeProfile, previousDraft, previousEvaluation, previousCreativeOutput }) {
    const phaseSkeleton = buildMusicPhaseSkeleton(routeProfile);
    const imageryCandidates = buildRouteImageryCandidates(routeProfile);
    const samplingAnchors = buildSamplingAnchors(routeProfile);
    const reuseCreative = iteration > 1
      && previousCreativeOutput?.route_poem
      && previousCreativeOutput?.route_interpretation;
    const outputSchema = {
      summary: '给用户看的简短规划摘要',
      route_interpretation: { core_image_ids: ['从 imagery_candidates 中选2到4个 image_id；无可靠意象时返回空数组'], movement_arc: '路线移动方式与场景变化的简短概括' },
      music_strategy: {
        overall_arc: '整条路线的能量与节奏走向；兼顾时长、风格和歌曲标签',
        sampling_roles: samplingAnchors.map((anchor) => ({ anchor_id: anchor.anchor_id, role: 'opening | development | transition | ending' })),
      },
      route_poem: {
        ja: ['日本語俳句の一行目', '二行目', '三行目'],
        zh: ['对应的一行中文译文', '对应的中文译文', '对应的中文译文'],
      },
      search: {
        energy_range: [0.3, 0.8], pace_range: [0.3, 0.7], max_duration: 420, genre_hint: null, sound_hints: [],
        music_phases: phaseSkeleton.map((phase) => ({
          ...phase, energy_range: [0.3, 0.8], pace_range: [0.3, 0.7], genre_hint: null, sound_hints: [],
        })),
      },
      use_dp: true,
      max_songs: 8,
      revision_hint: '若本轮不合格，下一轮准备如何修正',
    };
    if (reuseCreative) {
      delete outputSchema.route_interpretation;
      delete outputSchema.route_poem;
    }
    const prompt = {
      task: '制定本轮搜索和组合策略', iteration,
      route: compactRouteProfile(routeProfile),
      music_phase_templates: phaseSkeleton,
      imagery_candidates: imageryCandidates,
      sampling_anchors: samplingAnchors,
      travel_input: input,
      previous_result: previousDraft ? {
        total_seconds: previousDraft.total_seconds,
        song_ids: previousDraft.song_ids,
        evaluation: previousEvaluation,
      } : null,
      output_schema: outputSchema,
      allowed_genre_hint_values: [...GENRE_HINTS, null],
      label_guidance: 'energy_range和pace_range分别描述声音强度与节奏；sound_hints最多5个简短听感词，可为空。路线证据不足时留空；自动关键词标签只作弱参考。',
      phase_guidance: '为music_phase_templates中的每段提供对应音乐策略，phase_id、边界和evidence必须原样保留，不能改边界或增删阶段。音乐策略综合阶段节奏、路线移动、场景、风格与歌曲标签，意象只是辅助。相邻阶段可平滑变化；genre_hint可为空。',
      poem_guidance: reuseCreative ? undefined : 'route_poem必须恰好包含日语和中文各三行，逐行对照。日语采用俳句的凝练与留白，尝试5-7-5音拍但不要为了凑音拍添加无依据内容。只从route_interpretation.core_image_ids对应的意象中取材；意象可以转化，不要直白介绍地点。中文写成自然的现代自由诗式意译：可重组句法，保留该行核心意象与情绪变化，避免翻译腔、解释口吻和华丽套语，不添加原诗及路线证据之外的新意象。两种语言都不要标签前缀。',
      revision_guidance: reuseCreative ? '路线解读和中日诗歌沿用前一轮结果；仅重新规划音乐策略、能量范围、风格提示和歌曲组合。不要重新生成诗歌或路线解读。' : undefined,
    };
    return parseDeepSeekPlan(await callDeepSeek(prompt), phaseSkeleton, imageryCandidates, samplingAnchors, reuseCreative ? previousCreativeOutput : undefined);
  }

  async select({ decision, candidates, routeProfile }) {
    const compactCandidates = candidates.slice(0, 80).map((song) => ({
      song_id: song.song_id, title: song.title, artist: song.artist,
      duration_sec: song.duration_sec, energy: song.energy, pace: song.pace, genres: song.genres, styles: song.styles,
      descriptors: song.descriptors, texture: song.texture, vocal: song.vocal,
      energy_confidence: song.label_meta?.energy?.confidence ?? 0,
      genre_confidence: song.label_meta?.genres?.confidence ?? 0,
      pace_confidence: song.label_meta?.pace?.confidence ?? 0,
      descriptor_confidence: song.label_meta?.descriptors?.confidence ?? song.label_meta?.texture?.confidence ?? 0,
      recent_use_penalty: song.selection_recency_penalty ?? 0,
      recent_artist_penalty: song.artist_recency_penalty ?? 0,
    }));
    const prompt = {
      task: '查看候选歌曲并决定使用DP还是手动给出song_ids',
      route_target_seconds: routeProfile.total_duration_sec,
      strategy: decision,
      candidates: compactCandidates,
      instruction: '所有收藏歌曲都可进入候选。不得因为某首歌已预计算、存在audio_features或置信度较高就额外加分；缓存状态本身不是推荐信号。只根据可用的energy和pace数值与当前路线阶段的匹配程度评分，未分析歌曲的未知值保持中性，不因此过滤或惩罚。energy和pace优先来自本地音频分析；genre与声音标签来自自动元数据关键词，只作弱参考。recent_use_penalty表示歌曲在最近歌单中的重复情况，recent_artist_penalty表示歌手近期重复情况；当路线匹配和时长接近时，应明显优先近期较少出现的歌曲与歌手，但不要为了避重牺牲明显更好的路线匹配。相同路线应保持相近的阶段能量、节奏与风格走向，但不要求复现曲目；若多组组合匹配度和时长接近，应在这些组合间积极变化，避免固定选择熟悉曲目、同一歌手或列表前部歌曲。候选很多或难以手算时使用DP；只有确信手动组合更符合品味时才填写song_ids。song_ids只能来自候选列表。',
      output_schema: { summary: '给用户看的简短行动摘要', use_dp: true, song_ids: [], max_songs: 8 },
    };
    return parseDeepSeekSelection(await callDeepSeek(prompt));
  }
}

function compactRouteProfile(routeProfile) {
  const { segments = [], route_context: routeContext = {}, ...features } = routeProfile;
  const environmentSegments = routeContext.environment_segments ?? segments;
  return {
    ...features,
    route_context: {
      areas: (routeContext.areas ?? []).map((area) => ({
        name: area.name,
        start_ratio: area.start_ratio,
        end_ratio: area.end_ratio,
        match_source: area.match_source,
        confidence: area.confidence,
        imagery: area.imagery,
      })),
      transition_segments: (routeContext.transition_segments ?? []).map((segment) => ({
        start_ratio: segment.start_ratio,
        end_ratio: segment.end_ratio,
        distance_m: segment.distance_m,
        evidence_sample_count: segment.evidence_sample_count,
        labels: segment.labels,
        traits: segment.traits,
      })),
      environment_segments: environmentSegments,
      coverage: routeContext.coverage ? {
        places_sample_ratios: routeContext.coverage.places_sample_ratios,
        places_sample_count: routeContext.coverage.places_sample_count,
      } : undefined,
    },
  };
}

function buildRouteImageryCandidates(routeProfile) {
  const candidates = [];
  for (const area of routeProfile.route_context?.areas ?? []) {
    for (const image of area.imagery?.images ?? []) {
      for (const text of [image.term, ...(image.associations ?? [])]) {
        if (!text || candidates.some((candidate) => candidate.text === text && candidate.area === area.name)) continue;
        candidates.push({
          image_id: `image_${candidates.length + 1}`,
          text,
          area: area.name,
          start_ratio: area.start_ratio,
          end_ratio: area.end_ratio,
          confidence: area.confidence,
        });
        if (candidates.length >= 24) return candidates;
      }
    }
  }
  return candidates;
}

function buildSamplingAnchors(routeProfile) {
  const context = routeProfile.route_context ?? {};
  const ratios = context.coverage?.places_sample_ratios
    ?? (context.environment_segments ?? routeProfile.segments ?? []).flatMap((segment) => segment.sample_ratios ?? []);
  const unique = [...new Set(ratios.filter((ratio) => Number.isFinite(ratio)))].sort((a, b) => a - b).slice(0, 4);
  const segments = context.environment_segments ?? routeProfile.segments ?? [];
  return unique.map((ratio, index) => {
    const nearby = segments.find((segment) => ratio >= (segment.start_ratio ?? 0) && ratio <= (segment.end_ratio ?? 1));
    return {
      anchor_id: `sample_${index + 1}`,
      ratio,
      evidence: nearby ? [nearby.label, ...(nearby.traits ?? [])].filter(Boolean).slice(0, 4) : [],
    };
  });
}

export function parseDeepSeekPlan(value, phaseSkeleton = [], imageryCandidates = [], samplingAnchors = [], previousCreativeOutput) {
  const raw = value && typeof value === 'object' ? value : {};
  const search = raw.search && typeof raw.search === 'object' ? raw.search : {};
  const energy = Array.isArray(search.energy_range) ? search.energy_range : [0.2, 0.9];
  const rawInterpretation = previousCreativeOutput?.route_interpretation
    ?? (raw.route_interpretation && typeof raw.route_interpretation === 'object' ? raw.route_interpretation : {});
  const selectedImageIds = [...new Set((Array.isArray(rawInterpretation.core_image_ids) ? rawInterpretation.core_image_ids : [])
    .filter((id) => imageryCandidates.some((candidate) => candidate.image_id === id)))].slice(0, 4);
  const rawPoem = previousCreativeOutput?.route_poem
    ?? (raw.route_poem && typeof raw.route_poem === 'object' ? raw.route_poem : {});
  const ja = normalizePoemLines(rawPoem.ja, ['道の曲がり目', '足音つづく', '余白へ']);
  const zh = normalizePoemLines(rawPoem.zh, ['路在转弯', '脚步仍相续', '余白渐深']);
  const rawMusicStrategy = raw.music_strategy && typeof raw.music_strategy === 'object' ? raw.music_strategy : {};
  const allowedRoles = new Set(['opening', 'development', 'transition', 'ending']);
  const samplingRoles = (Array.isArray(rawMusicStrategy.sampling_roles) ? rawMusicStrategy.sampling_roles : [])
    .filter((role) => samplingAnchors.some((anchor) => anchor.anchor_id === role?.anchor_id) && allowedRoles.has(role?.role))
    .slice(0, 4);
  return planSchema.parse({
    summary: textOrFallback(raw.summary, '根据路线环境筛选候选歌曲。'),
    introduction: zh.join('\n'),
    route_interpretation: {
      core_image_ids: selectedImageIds,
      movement_arc: textOrFallback(rawInterpretation.movement_arc, '沿路线移动，并留意真实场景的变化。'),
    },
    music_strategy: {
      overall_arc: textOrFallback(rawMusicStrategy.overall_arc, '随路线阶段调整能量与节奏，兼顾时长和歌曲标签。'),
      sampling_roles: samplingRoles,
    },
    route_poem: { ja, zh },
    search: {
      energy_range: [clampNumber(energy[0], 0, 1, 0.2), clampNumber(energy[1], 0, 1, 0.9)],
      max_duration: Math.round(clampNumber(search.max_duration, 60, 900, 480)),
      genre_hint: search.genre_hint ?? null,
      pace_range: Array.isArray(search.pace_range) ? search.pace_range.map((value) => clampNumber(value, 0, 1, 0.5)) : undefined,
      sound_hints: Array.isArray(search.sound_hints) ? search.sound_hints.filter((value) => typeof value === 'string').slice(0, 5).map((value) => value.trim().slice(0, 32)).filter(Boolean) : [],
      music_phases: phaseSkeleton.map((phase) => {
        const draft = Array.isArray(search.music_phases) ? search.music_phases.find((item) => item?.phase_id === phase.phase_id) : null;
        const energyRange = Array.isArray(draft?.energy_range) ? draft.energy_range : search.energy_range;
        const paceRange = Array.isArray(draft?.pace_range) ? draft.pace_range : search.pace_range;
        return {
          ...phase,
          energy_range: [clampNumber(energyRange?.[0], 0, 1, 0.2), clampNumber(energyRange?.[1], 0, 1, 0.9)],
          pace_range: Array.isArray(paceRange) ? paceRange.map((value) => clampNumber(value, 0, 1, 0.5)) : undefined,
          genre_hint: draft?.genre_hint == null || !GENRE_HINTS.includes(draft.genre_hint) ? (search.genre_hint ?? null) : draft.genre_hint,
          sound_hints: Array.isArray(draft?.sound_hints) ? draft.sound_hints.filter((value) => typeof value === 'string').slice(0, 5).map((value) => value.trim().slice(0, 32)).filter(Boolean) : [],
        };
      }),
    },
    use_dp: booleanOrFallback(raw.use_dp, true),
    max_songs: raw.max_songs == null ? undefined : Math.round(clampNumber(raw.max_songs, 1, 20, 8)),
    revision_hint: textOrFallback(raw.revision_hint, '下一轮将放宽条件并重新配平。'),
  });
}

function normalizePoemLines(value, fallback) {
  const lines = Array.isArray(value) ? value : [];
  return fallback.map((line, index) => textOrFallback(lines[index], line));
}

export function parseDeepSeekSelection(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return selectionSchema.parse({
    summary: textOrFallback(raw.summary, '已检查候选歌曲并选择组合方式。'),
    use_dp: booleanOrFallback(raw.use_dp, true),
    song_ids: Array.isArray(raw.song_ids) ? raw.song_ids : [],
    max_songs: raw.max_songs == null ? undefined : Math.round(clampNumber(raw.max_songs, 1, 20, 8)),
  });
}

function textOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function booleanOrFallback(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase())) return value.toLowerCase() === 'true';
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

async function callDeepSeek(payload) {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，请在本机 .env 中配置。');
  const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash';
  const thinkingEnabled = process.env.DEEPSEEK_THINKING_ENABLED?.trim().toLowerCase() !== 'false';
  const timeoutMs = getDeepSeekTimeoutMs();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const body = buildDeepSeekBody(payload, {
      model,
      thinkingEnabled,
      fallback: attempt === 2,
      reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT?.trim() || 'high',
    });
    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        dispatcher: getDispatcher(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt === 2) {
        const timedOut = error.name === 'TimeoutError' || /timeout/i.test(error.cause?.message ?? error.message);
        throw new Error(timedOut
          ? `DeepSeek 生成超时（已等待 ${Math.round(timeoutMs / 1000)} 秒），请重试。`
          : `无法连接 DeepSeek API：${error.cause?.message ?? error.message}`);
      }
      continue;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(`DeepSeek API 请求失败：${data?.error?.message ?? response.status}`);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (content) {
      try { return JSON.parse(content.replace(/^```json\s*|\s*```$/g, '')); } catch (error) {
        if (attempt === 2) throw new Error(`DeepSeek 返回的 JSON 无法解析：${error.message}`);
      }
    }
    if (attempt === 2) throw new Error('DeepSeek 返回了空内容。');
  }
  throw new Error('DeepSeek 未返回可用结果。');
}

export function buildDeepSeekBody(payload, {
  model = 'deepseek-v4-flash', thinkingEnabled = true, fallback = false, reasoningEffort = 'high',
} = {}) {
  const useThinking = thinkingEnabled && !fallback;
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (fallback) {
    messages.push({
      role: 'system',
      content: '这是空响应后的降级重试。不要进行扩展推理，直接输出紧凑、完整、合法的 JSON；不得输出 Markdown 或 JSON 之外的文字。',
    });
  }
  messages.push({ role: 'user', content: JSON.stringify(payload) });
  const body = {
    model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
    thinking: { type: useThinking ? 'enabled' : 'disabled' },
  };
  if (useThinking) body.reasoning_effort = reasoningEffort;
  return body;
}

function getDeepSeekTimeoutMs() {
  const configured = Number(process.env.DEEPSEEK_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return 60_000;
  return Math.min(120_000, Math.max(10_000, Math.round(configured)));
}

function getDispatcher() {
  const proxyUrl = process.env.HTTPS_PROXY?.trim();
  if (!proxyUrl) return undefined;
  if (!proxyAgent) proxyAgent = new ProxyAgent(proxyUrl);
  return proxyAgent;
}
