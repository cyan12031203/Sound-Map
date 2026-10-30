import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { calculateRoute } from './services/google-routes.js';
import { autocompletePlaces, getPlaceDetails } from './services/google-places.js';
import { getLikedSongs, getSongPlayback } from './services/netease.js';
import { runPearAgent } from './agent/pear-agent.js';
import { DeepSeekPlanner } from './agent/deepseek-planner.js';
import { createAgentTools } from './agent/agent-tools.js';

const app = express();
const port = Number(process.env.PORT || 4100);
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

app.use(cors());
app.use(express.json());
app.use(express.static(publicDirectory));

const locationInput = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const routeInput = z.object({
  origin: z.string().trim().min(2, '请填写起点。').max(200),
  destination: z.string().trim().min(2, '请填写终点。').max(200),
  originLocation: locationInput.optional(),
  destinationLocation: locationInput.optional(),
  mode: z.enum(['walking', 'driving', 'bicycling']),
}).refine((value) => value.origin.toLocaleLowerCase() !== value.destination.toLocaleLowerCase(), {
  message: '起点和终点不能相同。',
});

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'route-music-api' });
});

const placeSearchInput = z.object({ q: z.string().trim().min(2).max(120), sessionToken: z.string().uuid() });
app.get('/api/places/autocomplete', async (request, response) => {
  const input = placeSearchInput.safeParse(request.query);
  if (!input.success) return response.status(400).json({ error: '请输入至少 2 个字的地址。' });
  try { return response.json({ suggestions: await autocompletePlaces({ query: input.data.q, sessionToken: input.data.sessionToken }) }); }
  catch (error) { return response.status(502).json({ error: error.message }); }
});

const placeDetailsInput = z.object({ placeId: z.string().trim().min(1).max(300), sessionToken: z.string().uuid() });
app.get('/api/places/details', async (request, response) => {
  const input = placeDetailsInput.safeParse(request.query);
  if (!input.success) return response.status(400).json({ error: '地点参数无效。' });
  try { return response.json(await getPlaceDetails(input.data)); }
  catch (error) { return response.status(502).json({ error: error.message }); }
});

app.post('/api/route', async (request, response) => {
  const input = routeInput.safeParse(request.body);
  if (!input.success) return response.status(400).json({ error: input.error.issues[0].message });

  try {
    return response.json(await calculateRoute(input.data));
  } catch (error) {
    return response.status(502).json({ error: error.message });
  }
});

app.get('/api/music/liked', async (_request, response) => {
  try {
    return response.json(await getLikedSongs());
  } catch (error) {
    return response.status(502).json({ error: error.message });
  }
});

const songIdInput = z.string().regex(/^\d{1,20}$/);
app.get('/api/music/playback/:songId', async (request, response) => {
  const songId = songIdInput.safeParse(request.params.songId);
  if (!songId.success) return response.status(400).json({ error: '歌曲 ID 无效。' });
  try {
    return response.json(await getSongPlayback(songId.data));
  } catch (error) {
    return response.status(502).json({ error: error.message });
  }
});

app.post('/api/agent/mixtape', async (request, response) => {
  const input = routeInput.safeParse(request.body);
  if (!input.success) return response.status(400).json({ error: input.error.issues[0].message });

  try {
    const result = await runPearAgent({
      input: input.data,
      planner: new DeepSeekPlanner(),
      tools: createAgentTools({ calculateRoute, getLikedSongs }),
      toolTimeoutMs: 30_000,
    });
    return response.json(result);
  } catch (error) {
    return response.status(502).json({ error: error.message });
  }
});

app.post('/api/agent/mixtape/stream', async (request, response) => {
  const input = routeInput.safeParse(request.body);
  if (!input.success) return response.status(400).json({ error: input.error.issues[0].message });

  response.status(200);
  response.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();

  let closed = false;
  request.once('aborted', () => { closed = true; });
  response.once('close', () => {
    if (!response.writableEnded) closed = true;
  });
  const sendEvent = (event, data) => {
    if (closed || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runPearAgent({
      input: input.data,
      planner: new DeepSeekPlanner(),
      tools: createAgentTools({ calculateRoute, getLikedSongs }),
      toolTimeoutMs: 30_000,
      emit: ({ stage, message }) => sendEvent('status', { stage, message }),
    });
    sendEvent('result', result);
  } catch (error) {
    sendEvent('error', { error: error.message });
  } finally {
    if (!closed && !response.writableEnded) response.end();
  }
});

export default app;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = app.listen(port, () => {
    console.log(`路线音乐后端已启动：http://localhost:${port}`);
  });

  // Node 的 HTTP server 默认会保持进程存活。这里显式 ref 一次，兼容当前
  // Windows/Node 运行环境中“监听成功后立即 clean exit”的异常行为。
  server.ref();

  // 作为本地开发的兜底保活。不会执行业务逻辑，也不会产生网络请求。
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

  function shutdown(signal) {
    console.log(`收到 ${signal}，正在关闭路线音乐后端。`);
    clearInterval(keepAlive);
    server.close(() => process.exit(0));
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
