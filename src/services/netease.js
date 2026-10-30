function getBaseUrl() {
  return process.env.NETEASE_PRIVATE_URL?.replace(/\/$/, '')
    || process.env.NETEASE_API_BASE_URL?.replace(/\/$/, '')
    || 'http://127.0.0.1:3000';
}

async function neteaseGet(path, params = {}) {
  const url = new URL(path, `${getBaseUrl()}/`);
  for (const [key, value] of Object.entries({ ...params, cookie: process.env.NETEASE_COOKIE })) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  const data = await response.json();
  // 不同版本的 NeteaseCloudMusicApi 对 /login/status 的 code 放置不同：
  // 有的在最外层，有的位于 data.code。
  const responseCode = data.code ?? data.data?.code;
  if (!response.ok || responseCode !== 200) {
    const reason = data.message ?? data.msg ?? `返回状态 ${responseCode ?? response.status}`;
    throw new Error(`网易云 API ${path} 请求失败：${reason}`);
  }
  return data;
}

export async function getLikedSongs() {
  const loginStatus = await neteaseGet('/login/status');
  const userId = loginStatus?.data?.profile?.userId;
  if (!userId) throw new Error('网易云 Cookie 无效或已过期，请重新扫码登录并更新 .env。');

  const playlists = await neteaseGet('/user/playlist', { uid: userId, limit: 1000 });
  const likedPlaylist = playlists.playlist?.find((playlist) => playlist.specialType === 5)
    ?? playlists.playlist?.find((playlist) => playlist.name === '我喜欢的音乐');
  if (!likedPlaylist) throw new Error('没有找到“我喜欢的音乐”歌单。');

  const tracks = await neteaseGet('/playlist/track/all', {
    id: likedPlaylist.id,
    limit: 1000,
    offset: 0,
  });

  return {
    playlist: { id: likedPlaylist.id, name: likedPlaylist.name },
    songs: (tracks.songs ?? []).map((song) => ({
      id: song.id,
      name: song.name,
      artists: song.ar?.map((artist) => artist.name).join(' / ') ?? '未知歌手',
      album: song.al?.name ?? '未知专辑',
      durationMs: song.dt,
    })),
  };
}

async function getSongAudioInfo(songId) {
  const source = await neteaseGet('/song/url/v1', { id: songId, level: 'standard' });
  const audio = source.data?.[0];
  if (!audio?.url) throw new Error('这首歌受版权或会员权限限制，暂时无法播放。');

  let audioUrl;
  try {
    const parsed = new URL(audio.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    audioUrl = parsed.href;
  } catch {
    throw new Error('网易云返回了无效的音频地址。');
  }
  return { audioUrl, type: audio.type ?? null, level: audio.level ?? 'standard' };
}

export async function getSongAudioUrl(songId) {
  return (await getSongAudioInfo(songId)).audioUrl;
}

export async function getSongPlayback(songId) {
  const [audio, lyric] = await Promise.all([
    getSongAudioInfo(songId),
    neteaseGet('/lyric', { id: songId }),
  ]);

  return {
    songId: String(songId),
    ...audio,
    lyric: lyric.lrc?.lyric ?? '',
    translatedLyric: lyric.tlyric?.lyric ?? '',
  };
}
