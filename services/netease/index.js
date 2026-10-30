const express = require('express');
const netease = require('NeteaseCloudMusicApi');

const app = express();

const routes = new Map([
  ['/login/status', 'login_status'],
  ['/user/playlist', 'user_playlist'],
  ['/playlist/track/all', 'playlist_track_all'],
  ['/song/url/v1', 'song_url_v1'],
  ['/lyric', 'lyric'],
]);

app.get('/_service/health', (_request, response) => {
  response.json({ ok: true, service: 'netease-private' });
});

for (const [route, method] of routes) {
  app.get(route, async (request, response) => {
    try {
      const result = await netease[method]({ ...request.query });
      if (Array.isArray(result.cookie) && result.cookie.length > 0) {
        response.append('Set-Cookie', result.cookie);
      }
      return response.status(result.status ?? 200).json(result.body);
    } catch (error) {
      const status = Number(error?.status);
      if (error?.body) {
        return response.status(Number.isInteger(status) ? status : 502).json(error.body);
      }
      console.error(`NetEase handler failed for ${route}:`, error?.message ?? 'unknown error');
      return response.status(502).json({ code: 502, msg: '网易云音乐服务请求失败。' });
    }
  });
}

app.use((_request, response) => {
  response.status(404).json({ code: 404, msg: 'Not Found' });
});

module.exports = app;
