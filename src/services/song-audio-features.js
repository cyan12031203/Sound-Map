import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MPEGDecoderWebWorker } from 'mpg123-decoder';
import { ProxyAgent } from 'undici';
import { profileFingerprint } from './song-profile.js';

const defaultCache = new URL('../../data/song-audio-features.json', import.meta.url);
const FEATURE_METHOD = 'mp3-composite-energy-v2';

async function readCache(path = defaultCache) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return [1, 2].includes(parsed.version)
      ? { entries: parsed.entries ?? {}, calibration: parsed.calibration ?? null }
      : { entries: {}, calibration: null };
  } catch { return { entries: {}, calibration: null }; }
}

export async function enrichWithAudioFeatures(songs, { cachePath = defaultCache } = {}) {
  const cache = await readCache(cachePath);
  return songs.map((song) => {
    const entry = cache.entries[String(song.song_id ?? song.id)];
    if (!entry || entry.method !== FEATURE_METHOD || entry.fingerprint !== profileFingerprint({
      id: song.song_id ?? song.id, name: song.title ?? song.name,
      artists: song.artist ?? song.artists, album: song.album,
      durationMs: Number(song.duration_sec ?? 0) * 1000,
    })) return song;
    return {
      ...song,
      // Keep measurements separate until coverage is broad enough for fair comparison.
      audio_features: { energy: entry.energy, pace: entry.pace, confidence: entry.confidence, analyzed_at: entry.analyzed_at, method: entry.method },
    };
  });
}

export function extractAudioFeatures(channelData, sampleRate) {
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.05));
  const frames = Math.min(...channelData.map((channel) => Math.floor(channel.length / frameSize)));
  if (frames < 100) throw new Error('音频长度不足，无法稳定估算能量和节奏。');
  const rms = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const start = frame * frameSize;
    for (let channel = 0; channel < channelData.length; channel += 1) {
      const pcm = channelData[channel];
      for (let i = start; i < start + frameSize; i += 1) sum += pcm[i] * pcm[i];
    }
    rms[frame] = Math.sqrt(sum / (frameSize * channelData.length));
  }

  const rmsDb = Array.from(rms, (value) => 20 * Math.log10(Math.max(1e-5, value)));
  const medianDb = percentile(rmsDb, 0.5);
  const dynamicRangeDb = Math.max(0, percentile(rmsDb, 0.9) - medianDb);
  const noiseFloorDb = percentile(rmsDb, 0.1);
  const activeRatio = rmsDb.filter((value) => value > noiseFloorDb + 8).length / frames;

  // Positive RMS changes capture attacks such as drum hits, plucks, and accents.
  const novelty = new Float32Array(frames);
  for (let i = 1; i < frames; i += 1) novelty[i] = Math.max(0, rms[i] - rms[i - 1]);
  const noveltyValues = Array.from(novelty);
  const noveltyMedian = median(noveltyValues);
  const noveltyMad = median(noveltyValues.map((value) => Math.abs(value - noveltyMedian)));
  const onsetThreshold = noveltyMedian + Math.max(1e-5, 2.5 * noveltyMad);
  let onsetCount = 0;
  for (let i = 1; i < frames - 1; i += 1) {
    if (novelty[i] >= onsetThreshold && novelty[i] >= novelty[i - 1] && novelty[i] > novelty[i + 1]) onsetCount += 1;
  }
  const frameRate = sampleRate / frameSize;
  const onsetsPerMinute = onsetCount / (frames / frameRate) * 60;

  // Autocorrelation estimates recurring beat intervals; constrain the search to 60–180 BPM.
  const minLag = Math.max(1, Math.ceil(frameRate * 60 / 180));
  const maxLag = Math.min(Math.floor(frames / 2), Math.floor(frameRate * 60 / 60));
  let bestLag = null, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0, a = 0, b = 0;
    for (let i = lag; i < frames; i += 1) {
      dot += novelty[i] * novelty[i - lag];
      a += novelty[i] ** 2; b += novelty[i - lag] ** 2;
    }
    const score = dot / Math.sqrt(Math.max(1e-12, a * b));
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const bpm = bestLag ? 60 * frameRate / bestLag : null;
  return {
    energy: null,
    energy_components: {
      loudness_db: medianDb,
      onsets_per_minute: onsetsPerMinute,
      active_ratio: activeRatio,
      dynamic_range_db: dynamicRangeDb,
    },
    pace: bpm ? Number(clamp((bpm - 60) / 120).toFixed(3)) : null,
    bpm: bpm ? Number(bpm.toFixed(1)) : null,
    confidence: Number(clamp((bestScore - 0.02) / 0.28, 0.35, 0.85).toFixed(2)),
  };
}

export async function precomputeAudioFeatures(songs, { getAudioUrl, cachePath = defaultCache, limit = 50, requestIntervalMs = 2000, onProgress = () => {} } = {}) {
  const cache = await readCache(cachePath);
  const { entries } = cache;
  const sampleCount = Math.min(songs.length, Math.max(1, Math.floor(limit)));
  const sampled = sampleCount === 1
    ? songs.slice(0, 1)
    : Array.from({ length: sampleCount }, (_, index) => songs[
      Math.round(index * (songs.length - 1) / (sampleCount - 1))
    ]);
  const decoder = new MPEGDecoderWebWorker();
  await decoder.ready;
  const proxyUrl = process.env.HTTPS_PROXY?.trim();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  let completed = 0;
  let stoppedReason = null;
  let lastRequestAt = 0;
  try {
    for (const song of sampled) {
      const id = String(song.id ?? song.song_id);
      const fingerprint = profileFingerprint(song);
      if (entries[id]?.fingerprint === fingerprint && entries[id]?.method === FEATURE_METHOD) {
        completed += 1;
        onProgress({ completed, total: sampled.length, song, cached: true });
        continue;
      }
      let songError = null;
      try {
        const waitMs = Math.max(0, requestIntervalMs - (Date.now() - lastRequestAt));
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        lastRequestAt = Date.now();
        const url = await getAudioUrl(id);
        const response = await fetch(url, dispatcher ? { dispatcher } : undefined);
        if (!response.ok) throw new Error(`音频下载返回 HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const decoded = await decoder.decode(bytes);
        const features = extractAudioFeatures(decoded.channelData, decoded.sampleRate);
        entries[id] = { fingerprint, ...features, method: FEATURE_METHOD, analyzed_at: new Date().toISOString() };
        cache.calibration = calibrateEnergy(entries);
        applyEnergyCalibration(entries, cache.calibration);
      } catch (error) {
        songError = error.message;
        if (isBatchStopError(error)) {
          stoppedReason = songError;
        }
      }
      completed += 1;
      if (entries[id]?.method === FEATURE_METHOD) await saveCache(cache, cachePath);
      onProgress({ completed, total: sampled.length, song, cached: false, error: songError });
      if (stoppedReason) break;
    }
  } finally {
    decoder.free();
    await dispatcher?.close();
  }
  return { selected: sampled.length, completed, cached: Object.keys(entries).length, stoppedReason };
}

function isBatchStopError(error) {
  const code = error?.cause?.code ?? error?.code;
  if (['EACCES', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code)) return true;
  return /\b429\b|\b5\d\d\b|rate.?limit|too many requests/i.test(error?.message ?? '');
}

function calibrateEnergy(entries) {
  const rows = Object.values(entries).filter((entry) => entry.method === FEATURE_METHOD && entry.energy_components);
  const keys = ['loudness_db', 'onsets_per_minute', 'active_ratio', 'dynamic_range_db'];
  return Object.fromEntries(keys.map((key) => {
    const values = rows.map((entry) => entry.energy_components[key]).filter(Number.isFinite);
    return [key, values.length ? { low: percentile(values, 0.1), high: percentile(values, 0.9) } : { low: 0, high: 1 }];
  }));
}

function applyEnergyCalibration(entries, calibration) {
  const weights = { loudness_db: 0.3, onsets_per_minute: 0.35, active_ratio: 0.25, dynamic_range_db: 0.1 };
  for (const entry of Object.values(entries)) {
    if (entry.method !== FEATURE_METHOD || !entry.energy_components) continue;
    const score = Object.entries(weights).reduce((sum, [key, weight]) => {
      const { low, high } = calibration[key];
      const range = high - low;
      const normalized = range < 1e-9 ? 0.5 : clamp((entry.energy_components[key] - low) / range);
      return sum + normalized * weight;
    }, 0);
    entry.energy = Number(score.toFixed(3));
  }
}

async function saveCache(cache, path) {
  const target = path instanceof URL ? (await import('node:url')).fileURLToPath(path) : path;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 2, entries: cache.entries, calibration: cache.calibration }, null, 2));
  await rename(temporary, target);
}

function median(values) { return percentile(values, 0.5); }
function percentile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
function clamp(value, low = 0, high = 1) { return Math.max(low, Math.min(high, value)); }
