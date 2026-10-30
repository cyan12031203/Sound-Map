import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { profileSong, profileFingerprint, PROFILE_VERSION } from './song-profile.js';
import { enrichWithAudioFeatures } from './song-audio-features.js';
const defaultCache = new URL('../../data/song-profile-cache.json', import.meta.url);
async function readJson(path) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn('歌曲标签文件不可用，使用本次计算结果。'); return {}; }
}
export async function profileCatalog(songs, { cachePath = defaultCache } = {}) {
  const cache = await readJson(cachePath);
  const entries = {};
  const result = songs.map((song) => {
    const id = String(song.id), fingerprint = profileFingerprint(song);
    const entry = cache.version === PROFILE_VERSION ? cache.entries?.[id] : null;
    const base = entry?.fingerprint === fingerprint ? entry.profile : profileSong(song);
    entries[id] = { fingerprint, profile: base };
    return base;
  });
  let temporary;
  try {
    const path = cachePath instanceof URL ? (await import('node:url')).fileURLToPath(cachePath) : cachePath;
    await mkdir(dirname(path), { recursive: true });
    temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: PROFILE_VERSION, entries }, null, 2));
    try { await rename(temporary, path); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      await writeFile(path, JSON.stringify({ version: PROFILE_VERSION, entries }, null, 2));
      await unlink(temporary).catch(() => {});
    }
  } catch (error) { if (temporary) await unlink(temporary).catch(() => {}); console.warn('歌曲标签缓存无法保存，本次选歌仍可继续。'); }
  return enrichWithAudioFeatures(result);
}


