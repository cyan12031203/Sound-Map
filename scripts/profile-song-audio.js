import 'dotenv/config';
import { getLikedSongs, getSongAudioUrl } from '../src/services/netease.js';
import { precomputeAudioFeatures } from '../src/services/song-audio-features.js';

const limitArg = process.argv.find((argument) => argument.startsWith('--limit='));
const limit = Math.max(1, Math.min(1000, Number(limitArg?.split('=')[1] ?? 50) || 50));
const { songs } = await getLikedSongs();
console.log(`开始抽样分析 ${Math.min(limit, songs.length)} / ${songs.length} 首收藏歌曲；音频只在内存中处理。`);
const result = await precomputeAudioFeatures(songs, {
  getAudioUrl: getSongAudioUrl,
  limit,
  onProgress({ completed, total, song, cached, error }) {
    const status = error ? `失败：${error}` : cached ? '已缓存' : '完成';
    console.log(`[${completed}/${total}] ${song.name} — ${song.artists}: ${status}`);
  },
});
console.log(`分析结束。抽样 ${result.selected} 首，本次处理 ${result.completed} 首，特征缓存共 ${result.cached} 首。`);
if (result.stoppedReason) console.log(`为避免继续触发网络限制，批次已停止：${result.stoppedReason}`);
