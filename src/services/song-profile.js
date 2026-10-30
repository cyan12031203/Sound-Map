import { createHash } from 'node:crypto';

export const PROFILE_VERSION = 4;
const RULES = [
  ['rock', /\brock\b|摇滚/i, 'high_energy'],
  ['metal', /\bmetal\b|金属/i, 'high_energy'],
  ['electronic', /\b(?:electronic|electronica|edm)\b|电子/i, 'high_energy'],
  ['dance', /\bdance\b|舞曲/i, 'high_energy'],
  ['pop', /\bpop\b|流行/i, 'pop'],
  ['rnb', /\br&b\b|节奏布鲁斯/i, 'pop'],
  ['soul', /\bsoul\b|灵魂乐/i, 'pop'],
  ['hip_hop', /\bhip[ -]?hop\b|嘻哈/i, 'pop'],
  ['folk', /\bfolk\b|民谣/i, 'acoustic'],
  ['acoustic', /\bacoustic\b|原声/i, 'acoustic'],
  ['indie', /\bindie\b|独立音乐/i, null],
  ['classical', /\bclassical\b|古典/i, 'ambient'],
  ['ambient', /\bambient\b|氛围/i, 'ambient'],
  ['soundtrack', /\bsoundtrack\b|配乐/i, null],
];
export const GENRES = [...RULES.map(([genre]) => genre), 'chorus', 'shoegaze'];
export function profileFingerprint(song) {
  return createHash('sha256').update(JSON.stringify([song.name, song.artists, song.album, Math.round(Number(song.durationMs) / 1000)])).digest('hex');
}
export function profileSong(song) {
  // Artists identify performers, not sound characteristics. Album evidence is stronger than title evidence.
  const fields = [['album', song.album ?? '', 0.35], ['title', song.name ?? '', 0.15]];
  const matches = RULES.flatMap(([genre, pattern, style]) => {
    const evidence = fields.filter(([, text]) => pattern.test(text));
    return evidence.length ? [{ genre, style, evidence: evidence.map(([field]) => field), confidence: Math.max(...evidence.map(([, , confidence]) => confidence)) }] : [];
  });
  const styles = [...new Set(matches.map((match) => match.style).filter(Boolean))];
  const text = `${song.album ?? ''} ${song.name ?? ''}`;
  const strong = /\b(?:high[ -]energy|aggressive|intense)\b|高能量|激烈/i.test(text);
  const soft = /\b(?:gentle|calm|soft|relaxing)\b|舒缓|轻柔/i.test(text);
  const energy = strong === soft ? null : strong ? 0.8 : 0.3;
  const profile = {
    song_id: String(song.id), title: song.name, artist: song.artists, album: song.album,
    duration_sec: Math.max(1, Math.round(Number(song.durationMs) / 1000) || 1),
    genres: matches.map((match) => match.genre), styles, style: styles.length === 1 ? styles[0] : 'unknown',
    energy, pace: null, valence: null,
    texture: /\bacoustic\b|原声/i.test(text) ? ['acoustic'] : [],
    vocal: /\binstrumental\b|纯音乐|无人声/i.test(text) ? 'instrumental' : 'unknown',
    label_meta: {
      genres: { source: matches.length ? 'metadata_keywords' : 'unknown', confidence: Math.max(0, ...matches.map((match) => match.confidence)), evidence: matches },
      energy: { source: energy == null ? 'unknown' : 'metadata_keywords', confidence: energy == null ? 0 : 0.15 },
      pace: { source: 'unknown', confidence: 0 }, valence: { source: 'unknown', confidence: 0 },
      texture: { source: /\bacoustic\b|原声/i.test(text) ? 'metadata_keywords' : 'unknown', confidence: /\bacoustic\b|原声/i.test(text) ? 0.15 : 0 },
      descriptors: { source: 'unknown', confidence: 0 },
      vocal: { source: /\binstrumental\b|纯音乐|无人声/i.test(text) ? 'metadata_keywords' : 'unknown', confidence: /\binstrumental\b|纯音乐|无人声/i.test(text) ? 0.15 : 0 },
    },
  };
  return profile;
}
