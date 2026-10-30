import { profileCatalog } from '../services/song-profile-cache.js';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDiagnosticsPath = new URL('../../data/selection-diagnostics.jsonl', import.meta.url);

export function createAgentTools({ calculateRoute, getLikedSongs, profileSongs = profileCatalog, diagnosticsPath = defaultDiagnosticsPath }) {
  let songCatalog = [];
  let songCatalogPromise;
  let routeSeed = 'sound-map';
  const loadSongCatalog = () => {
    if (songCatalog.length) return Promise.resolve(songCatalog);
    if (!songCatalogPromise) {
      songCatalogPromise = getLikedSongs()
        .then((liked) => profileSongs(liked.songs))
        .then((catalog) => {
          songCatalog = catalog;
          return songCatalog;
        })
        .catch((error) => {
          songCatalogPromise = null;
          throw error;
        });
    }
    return songCatalogPromise;
  };
  return {
    async get_route_profile(input) {
      const [route] = await Promise.all([calculateRoute(input), loadSongCatalog()]);
      routeSeed = createRouteSeed(input, route.features);
      return route.features;
    },

    async search_songs({ energy_range = [0, 1], max_duration = Infinity, genre_hint, music_phases = [] } = {}) {
      await loadSongCatalog();
      const strategies = music_phases.length ? music_phases : [{ energy_range, genre_hint }];
      const eligible = songCatalog.filter((song) => song.duration_sec <= max_duration);
      const measuredCoverage = eligible.length
        ? eligible.filter((song) => Number.isFinite(song.audio_features?.energy) && Number.isFinite(song.audio_features?.pace)).length / eligible.length
        : 0;
      const useAudioFeatures = measuredCoverage >= 0.65;
      const comparable = useAudioFeatures
        ? eligible.map((song) => {
          const audioFeatures = song.audio_features;
          if (!Number.isFinite(audioFeatures?.energy) || !Number.isFinite(audioFeatures?.pace)) return song;
          const confidence = audioFeatures.confidence ?? 0.75;
          return {
            ...song,
            energy: audioFeatures.energy,
            pace: audioFeatures.pace,
            label_meta: {
              ...song.label_meta,
              energy: { source: 'audio_analysis', confidence },
              pace: { source: 'audio_analysis', confidence },
            },
          };
        })
        : eligible;
      const recentPenalties = await loadRecentSelectionPenalties(diagnosticsPath);
      const withRecentPenalty = comparable.map((song) => ({
        ...song,
        selection_recency_penalty: recentPenalties.get(String(song.song_id)) ?? 0,
        artist_recency_penalty: recentPenalties.get(`artist:${normalizeArtist(song.artist)}`) ?? 0,
      }));
      const diversified = diversifyCandidates(withRecentPenalty, routeSeed);

      // 小样本覆盖不足时，对整个候选池关闭音频特征排序，避免已测歌曲占优。
      // The route score defines relevance; a small per-request jitter only changes
      // the order of near-ties so the planner's 80-song view does not repeat the
      // same catalog prefix on every generation of the same route.
      return shuffleNearScoreTies(diversified, strategies);
    },

    async dp_solver({ songs, target_seconds, strategy = {} }) {
      return solveDuration(songs, target_seconds, strategy);
    },

    async calculate_duration({ song_ids, songs = songCatalog }) {
      const uniqueIds = new Set(song_ids.map(String));
      const total = songs.filter((song) => uniqueIds.has(String(song.song_id)))
        .reduce((sum, song) => sum + song.duration_sec, 0);
      return { total_seconds: total };
    },

    async finalize_output({ input, route_profile: route, draft, evaluation, generation_id, iterations }) {
      const selected = draft.song_ids.map((id) => draft.songs.find((song) => String(song.song_id) === String(id))).filter(Boolean);
      const arranged = draft.phase_ordered
        ? assignPhasesInOrder(selected, draft.music_phases ?? [], draft.total_seconds)
        : arrangePlaylist(selected, draft.music_phases ?? [], draft.total_seconds);
      const ordered = arranged.songs;
      const suffix = evaluation?.acceptable ? '已经踩准路线长度。' : '经过三轮微调，已尽力接近路线长度。';
      const output = {
        announcement: `从 ${input.origin} 到 ${input.destination}，为这段 ${Math.round(route.total_duration_sec / 60)} 分钟的旅程选好了音乐，${suffix}`,
        playlist: ordered.map((song, index) => ({
          song_id: song.song_id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          duration_sec: song.duration_sec,
          energy: song.energy, pace: song.pace, descriptors: song.descriptors, texture: song.texture, vocal: song.vocal,
          genres: song.genres, styles: song.styles, label_meta: song.label_meta,
          phase_id: arranged.phaseBySong.get(String(song.song_id))?.phase_id ?? null,
          phase_label: arranged.phaseBySong.get(String(song.song_id))?.label ?? null,
          role: index === 0 ? 'opener' : index === ordered.length - 1 ? 'outro' : 'mid',
          recommendation: index === 0 ? '为旅程安排开场。' : index === ordered.length - 1 ? '为旅程安排收尾。' : '维持途中情绪的流动。',
        })),
        total_duration_sec: draft.total_seconds,
        playlist_duration_sec: draft.total_seconds,
        route_duration_sec: route.total_duration_sec,
        duration_delta_sec: evaluation?.delta_seconds ?? null,
      };
      if (diagnosticsPath) {
        const record = createSelectionDiagnostic({
          generationId: generation_id,
          input,
          route,
          draft,
          evaluation,
          iterations,
          playlist: output.playlist,
        });
        try {
          await writeSelectionDiagnostic(record, diagnosticsPath);
        } catch (error) {
          // Diagnostics must never make a playlist generation fail.
          console.warn(`选歌诊断日志写入失败：${error.message}`);
        }
      }
      return output;
    },
  };
}

export async function writeSelectionDiagnostic(record, filePath = defaultDiagnosticsPath) {
  const resolvedPath = filePath instanceof URL ? fileURLToPath(filePath) : path.resolve(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await appendFile(resolvedPath, `${JSON.stringify(record)}\n`, 'utf8');
  return resolvedPath;
}

function createSelectionDiagnostic({ generationId, input, route, draft, evaluation, iterations, playlist }) {
  const strategies = draft.music_phases?.length ? draft.music_phases : [{}];
  const byId = new Map(draft.songs.map((song) => [String(song.song_id), song]));
  const selectedIds = new Set(draft.song_ids.map(String));
  const ranked = draft.songs.map((song, index) => ({
    song,
    search_rank: index + 1,
    sort_score: roundScore(adjustedCandidateScore(song, strategies)),
    solver_score: roundScore(adjustedCandidateScore(song, strategies)),
  }));
  const topCandidates = ranked.slice(0, 50);
  const included = new Map(topCandidates.map((item) => [String(item.song.song_id), item]));
  for (const id of selectedIds) {
    if (!included.has(id)) {
      const item = ranked.find((candidate) => String(candidate.song.song_id) === id);
      if (item) included.set(id, item);
    }
  }
  const candidateDetails = [...included.values()].map(({ song, search_rank, sort_score, solver_score }) => ({
    song_id: song.song_id,
    title: song.title,
    artist: song.artist,
    duration_sec: song.duration_sec,
    vocal: song.vocal ?? 'unknown',
    energy: song.energy ?? null,
    pace: song.pace ?? null,
    genres: song.genres ?? [],
    styles: song.styles ?? [],
    descriptors: song.descriptors ?? [],
    texture: song.texture ?? [],
    label_meta: song.label_meta ?? {},
    recent_use_penalty: song.selection_recency_penalty ?? 0,
    recent_artist_penalty: song.artist_recency_penalty ?? 0,
    search_rank,
    sort_score,
    solver_score,
    phase_scores: strategies.map((phase, index) => ({
      phase_id: phase.phase_id ?? `phase-${index + 1}`,
      score: roundScore(songStrategyScore(song, phase)),
    })),
    selected: selectedIds.has(String(song.song_id)),
  }));
  const selected = playlist.map((song, index) => {
    const candidate = byId.get(String(song.song_id));
    return {
      order: index + 1,
      song_id: song.song_id,
      title: song.title,
      artist: song.artist,
      duration_sec: song.duration_sec,
      phase_id: song.phase_id,
      phase_label: song.phase_label,
      search_rank: ranked.find((item) => String(item.song.song_id) === String(song.song_id))?.search_rank ?? null,
      phase_score: candidate ? roundScore(songStrategyScore(candidate, strategies.find((phase) => phase.phase_id === song.phase_id) ?? {})) : null,
    };
  });
  return {
    schema_version: 1,
    generation_id: generationId ?? null,
    generated_at: new Date().toISOString(),
    route: {
      origin: input.origin,
      destination: input.destination,
      mode: input.mode,
      duration_sec: route.total_duration_sec,
      dominant_scene: route.dominant_scene,
      route_pace: route.route_pace,
      route_complexity: route.route_complexity,
    },
    iterations: iterations ?? null,
    selection_method: draft.selection_method ?? 'unknown',
    strategy: strategies.map((phase, index) => ({
      phase_id: phase.phase_id ?? `phase-${index + 1}`,
      start_ratio: phase.start_ratio ?? null,
      end_ratio: phase.end_ratio ?? null,
      energy_range: phase.energy_range ?? null,
      pace_range: phase.pace_range ?? null,
      genre_hint: phase.genre_hint ?? null,
      sound_hints: phase.sound_hints ?? [],
      evidence: phase.evidence ?? null,
    })),
    candidate_count: draft.songs.length,
    logged_candidate_count: candidateDetails.length,
    candidates: candidateDetails,
    selected,
    result: {
      total_duration_sec: draft.total_seconds,
      target_duration_sec: route.total_duration_sec,
      delta_sec: evaluation?.delta_seconds ?? null,
    },
  };
}

function roundScore(value) {
  return Number(Number(value ?? 0).toFixed(4));
}

function createRouteSeed(input, route) {
  const origin = input.originLocation
    ? `${input.originLocation.latitude},${input.originLocation.longitude}`
    : input.origin;
  const destination = input.destinationLocation
    ? `${input.destinationLocation.latitude},${input.destinationLocation.longitude}`
    : input.destination;
  // Keep route characteristics in the seed, while rotating candidate order for
  // every generation so identical routes don't always start from one artist.
  return [origin, destination, route.total_duration_sec, route.dominant_scene, route.mode, randomUUID()].join('|');
}

// 网易云按最近收藏顺序返回歌曲，列表头部可能被同一艺术家集中占据。
// 每次生成重新轮转艺术家与其曲目，再按阶段匹配分重排，避免 DP 固定从
// 列表前部开始并重复命中同一批候选。
export function diversifyCandidates(songs, routeSeed) {
  const buckets = new Map();
  for (const song of songs) {
    const artist = String(song.artist || '未知艺人').trim().toLocaleLowerCase();
    if (!buckets.has(artist)) buckets.set(artist, []);
    buckets.get(artist).push(song);
  }
  for (const [artist, artistSongs] of buckets) {
    artistSongs.sort((a, b) => seededRank(routeSeed, `${artist}|${a.song_id}`)
      - seededRank(routeSeed, `${artist}|${b.song_id}`));
  }
  const artists = [...buckets.keys()].sort((a, b) => seededRank(routeSeed, a) - seededRank(routeSeed, b));
  const result = [];
  let remaining = true;
  for (let round = 0; remaining; round += 1) {
    remaining = false;
    for (const artist of artists) {
      const song = buckets.get(artist)[round];
      if (!song) continue;
      result.push(song);
      remaining = true;
    }
  }
  return result;
}

function seededRank(seed, value) {
  let hash = 2166136261;
  for (const character of `${seed}|${value}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const CANDIDATE_TIE_WINDOW = 0.24;
const SELECTION_JITTER = 0.15;

function shuffleNearScoreTies(songs, strategies) {
  const ranked = songs
    .map((song) => ({ song, score: adjustedCandidateScore(song, strategies) }))
    .sort((a, b) => b.score - a.score);
  const result = [];
  for (let start = 0; start < ranked.length;) {
    let end = start + 1;
    while (end < ranked.length && ranked[start].score - ranked[end].score <= CANDIDATE_TIE_WINDOW) end += 1;
    const group = ranked.slice(start, end).map(({ song }) => song);
    for (let index = group.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [group[index], group[swap]] = [group[swap], group[index]];
    }
    result.push(...group);
    start = end;
  }
  return result;
}

function randomSelectionJitter() {
  return (Math.random() * 2 - 1) * SELECTION_JITTER;
}

function jitterForNearMatches(scores) {
  const best = Math.max(0, ...scores);
  return scores.map((score) => score >= best - CANDIDATE_TIE_WINDOW ? randomSelectionJitter() : 0);
}

// 0/1 背包只负责提供时长建议；真实 LLM 仍可在下一轮否决它。
export function solveDuration(songs, target, strategy = {}) {
  if (strategy.music_phases?.length > 1) {
    return solveRouteAwareDuration(songs, target, strategy.music_phases);
  }
  const upper = target + 30;
  const strategies = strategy.music_phases?.length ? strategy.music_phases : [strategy];
  const candidateScores = songs.map((song) => adjustedCandidateScore(song, strategies));
  const scoreJitters = jitterForNearMatches(candidateScores);
  const reachable = new Array(upper + 1).fill(null);
  reachable[0] = { ids: [], score: 0 };
  for (let songIndex = 0; songIndex < songs.length; songIndex += 1) {
    const song = songs[songIndex];
    for (let seconds = upper; seconds >= song.duration_sec; seconds -= 1) {
      const previous = reachable[seconds - song.duration_sec];
      if (!previous) continue;
      const candidate = { ids: [...previous.ids, song.song_id], score: previous.score + candidateScores[songIndex] + scoreJitters[songIndex] };
      if (!reachable[seconds] || candidate.score > reachable[seconds].score) reachable[seconds] = candidate;
    }
  }
  let best = null;
  for (let seconds = Math.max(1, target - 60); seconds <= upper; seconds += 1) {
    if (!reachable[seconds]) continue;
    if (!best || Math.abs(seconds - target) < Math.abs(best.seconds - target) || (Math.abs(seconds - target) === Math.abs(best.seconds - target) && reachable[seconds].score > best.score)) best = { seconds, ids: reachable[seconds].ids, score: reachable[seconds].score };
  }
  if (!best) {
    for (let seconds = 1; seconds <= upper; seconds += 1) {
      if (!reachable[seconds]) continue;
      if (!best || Math.abs(seconds - target) < Math.abs(best.seconds - target) || (Math.abs(seconds - target) === Math.abs(best.seconds - target) && reachable[seconds].score > best.score)) best = { seconds, ids: reachable[seconds].ids, score: reachable[seconds].score };
    }
  }
  return best?.ids ?? [];
}

// Select and order songs together. The previous subset DP scored every song
// against its *best* phase, then arrangePlaylist assigned phases afterward;
// that let one strong phase match dominate a whole route's selection. This
// bounded beam search scores each track at its actual position in the route.
function solveRouteAwareDuration(songs, target, phases) {
  const upper = target + 30;
  const lower = Math.max(1, target - 60);
  const usableSongs = songs
    .filter((song) => song.duration_sec > 0 && song.duration_sec <= upper)
    .map((song) => ({
      ...song,
      _id: String(song.song_id),
      _artist: String(song.artist || '未知艺人').trim().toLocaleLowerCase(),
      _phaseScores: phases.map((phase) => songStrategyScore(song, phase)),
    }));
  const bestPerPhase = phases.map((_, index) => Math.max(0, ...usableSongs.map((song) => song._phaseScores[index])));
  for (const song of usableSongs) {
    song._phaseJitters = song._phaseScores.map((score, index) => score >= bestPerPhase[index] - CANDIDATE_TIE_WINDOW ? randomSelectionJitter() : 0);
  }
  const beamWidth = 96;
  const perDurationBucket = 3;
  let beam = [{ ids: [], seconds: 0, score: 0, artists: [] }];
  let best = null;

  for (let depth = 0; depth < 24 && beam.length; depth += 1) {
    const expandedByDuration = new Map();
    for (const state of beam) {
      for (const song of usableSongs) {
        if (state.ids.includes(song._id)) continue;
        const seconds = state.seconds + song.duration_sec;
        if (seconds > upper) continue;
        const midpoint = state.seconds + song.duration_sec / 2;
        const phaseIndex = phaseIndexAtTime(phases, midpoint / target);
        const repeatArtistCost = state.artists.includes(song._artist) ? 0.65 : 0;
        const songScore = song._phaseScores[phaseIndex]
          - Number(song.selection_recency_penalty ?? 0)
          - Number(song.artist_recency_penalty ?? 0)
          - repeatArtistCost
          + song._phaseJitters[phaseIndex];
        const candidate = {
          ids: [...state.ids, song._id],
          seconds,
          score: state.score + songScore,
          artists: state.artists.includes(song._artist) ? state.artists : [...state.artists, song._artist],
        };
        if (seconds >= lower && (!best || isBetterRouteChoice(candidate, best, target))) best = candidate;
        if (seconds < lower) retainRouteCandidate(expandedByDuration, candidate, perDurationBucket);
      }
    }
    if (!expandedByDuration.size) break;
    beam = pruneRouteBeam(expandedByDuration, beamWidth, target);
  }
  if (best) return best.ids;

  // Preserve the old duration fallback if the bounded search cannot land in
  // the normal tolerance window (for example, with an unusually short route).
  return solveDuration(songs, target, {});
}

function phaseAtTime(phases, ratio) {
  return phases[phaseIndexAtTime(phases, ratio)] ?? {};
}

function phaseIndexAtTime(phases, ratio) {
  const index = phases.findIndex((phase) => ratio >= (phase.start_ratio ?? 0) && ratio < (phase.end_ratio ?? 1));
  return index >= 0 ? index : phases.length - 1;
}

function isBetterRouteChoice(candidate, current, target) {
  const candidateDelta = Math.abs(candidate.seconds - target);
  const currentDelta = Math.abs(current.seconds - target);
  return candidateDelta < currentDelta || (candidateDelta === currentDelta && candidate.score > current.score);
}

function retainRouteCandidate(groups, candidate, perBucket) {
  const bucket = Math.floor(candidate.seconds / 30);
  const group = groups.get(bucket) ?? [];
  if (group.length < perBucket) group.push(candidate);
  else {
    let worstIndex = 0;
    for (let index = 1; index < group.length; index += 1) {
      if (group[index].score < group[worstIndex].score) worstIndex = index;
    }
    if (candidate.score > group[worstIndex].score) group[worstIndex] = candidate;
  }
  groups.set(bucket, group);
}

function pruneRouteBeam(groups, beamWidth, target) {
  return [...groups.values()].flat()
    .sort((a, b) => {
      const aPotential = a.score - Math.max(0, target - a.seconds) * 0.0005;
      const bPotential = b.score - Math.max(0, target - b.seconds) * 0.0005;
      return bPotential - aPotential;
    })
    .slice(0, beamWidth);
}

function orderPlaylist(songs) {
  if (songs.length < 2) return songs;
  const opener = [...songs].sort((a, b) => (b.energy ?? 0.5) - (a.energy ?? 0.5))[0];
  const rest = songs.filter((song) => song !== opener);
  const outro = [...rest].sort((a, b) => (a.energy ?? 0.5) - (b.energy ?? 0.5) || a.duration_sec - b.duration_sec)[0];
  return [opener, ...rest.filter((song) => song !== outro), outro];
}

export function songStrategyScore(song, strategy = {}) {
  let score = 0;
  const confidence = key => Number(song.label_meta?.[key]?.confidence ?? 0);
  const rangeScore = (value, range, key, weight) => {
    if (value == null || !Array.isArray(range)) return 0;
    const [low, high] = [...range].sort((a,b)=>a-b);
    return (value >= low && value <= high ? 1 : -Math.min(1, Math.min(Math.abs(value-low),Math.abs(value-high))*2)) * weight * confidence(key);
  };
  score += rangeScore(song.energy, strategy.energy_range, 'energy', 1.5);
  score += rangeScore(song.pace, strategy.pace_range, 'pace', 1.0);
  if (strategy.genre_hint) {
    const known = song.styles?.length || song.style && song.style !== 'unknown';
    const match = song.style === strategy.genre_hint || song.styles?.includes(strategy.genre_hint);
    if (match) score += 1.2 * confidence('genres');
    else if (known) score -= 0.2 * confidence('genres');
  }
  const descriptors = [...(song.descriptors ?? []), ...(song.texture ?? []), ...(song.genres ?? [])].map(value=>String(value).toLocaleLowerCase());
  const hints = (strategy.sound_hints ?? []).map(value=>String(value).trim().toLocaleLowerCase()).filter(Boolean);
  const matched = hints.filter(hint=>descriptors.some(item=>item.includes(hint)||hint.includes(item)));
  score += Math.min(2, matched.length * 0.5) * confidence('descriptors');
  return score;
}

function bestPhaseScore(song, phases = []) {
  if (!phases.length) return 0;
  return Math.max(...phases.map((phase) => songStrategyScore(song, phase)));
}

function adjustedCandidateScore(song, phases) {
  return bestPhaseScore(song, phases)
    - Number(song.selection_recency_penalty ?? 0)
    - Number(song.artist_recency_penalty ?? 0);
}

async function loadRecentSelectionPenalties(filePath, windowSize = 16) {
  if (!filePath) return new Map();
  try {
    const text = await readFile(filePath, 'utf8');
    const records = text.split(/\r?\n/).filter(Boolean).slice(-windowSize).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    return computeRecentSelectionPenalties(records, windowSize);
  } catch { return new Map(); }
}

export function computeRecentSelectionPenalties(records, windowSize = 16) {
  const penalties = new Map();
  records.slice(-windowSize).reverse().forEach((record, age) => {
    const trackWeight = 1.8 * (0.8 ** age);
    const artistWeight = 0.75 * (0.82 ** age);
    const artistsInPlaylist = new Set();
    for (const song of record.selected ?? []) {
      const id = String(song.song_id ?? '');
      if (!id) continue;
      penalties.set(id, Math.min(3.5, (penalties.get(id) ?? 0) + trackWeight));
      const artist = normalizeArtist(song.artist);
      if (artist) artistsInPlaylist.add(artist);
    }
    for (const artist of artistsInPlaylist) {
      const key = `artist:${artist}`;
      penalties.set(key, Math.min(1.8, (penalties.get(key) ?? 0) + artistWeight));
    }
  });
  return penalties;
}

function normalizeArtist(artist) {
  return String(artist ?? '').trim().toLocaleLowerCase();
}

function arrangePlaylist(songs, phases, totalSeconds) {
  if (!phases.length || songs.length < 2) return { songs: orderPlaylist(songs), phaseBySong: new Map() };
  const remaining = [...songs];
  const ordered = [];
  const phaseBySong = new Map();
  let elapsed = 0;
  for (const phase of phases) {
    const phaseEnd = phase.end_ratio * totalSeconds;
    while (remaining.length && (elapsed < phaseEnd || phase === phases.at(-1))) {
      const secondsLeft = Math.max(0, phaseEnd - elapsed);
      const index = remaining.reduce((best, song, candidateIndex) => {
        const score = songStrategyScore(song, phase) - Math.min(1, Math.abs(song.duration_sec - secondsLeft) / 600);
        return score > best.score ? { index: candidateIndex, score } : best;
      }, { index: 0, score: -Infinity }).index;
      const [song] = remaining.splice(index, 1);
      ordered.push(song);
      phaseBySong.set(String(song.song_id), { phase_id: phase.phase_id, label: phase.evidence?.areas?.join(' · ') || `路线第${orderedPhaseIndex(phases, phase) + 1}段` });
      elapsed += song.duration_sec;
    }
  }
  for (const song of remaining) ordered.push(song);
  return { songs: ordered, phaseBySong };
}

function assignPhasesInOrder(songs, phases, totalSeconds) {
  const phaseBySong = new Map();
  let elapsed = 0;
  for (const song of songs) {
    const midpointRatio = (elapsed + song.duration_sec / 2) / Math.max(1, totalSeconds);
    const phase = phaseAtTime(phases, midpointRatio);
    phaseBySong.set(String(song.song_id), {
      phase_id: phase.phase_id,
      label: phase.evidence?.areas?.join(' · ') || `路线第${phases.indexOf(phase) + 1}段`,
    });
    elapsed += song.duration_sec;
  }
  return { songs, phaseBySong };
}

function orderedPhaseIndex(phases, phase) { return phases.indexOf(phase); }
