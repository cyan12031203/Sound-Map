# Sound-Map

Sound-Map 根据一段真实路线生成一份可播放的路线歌单，并配上日中双语短诗。它是一个个人项目 / MVP：前端、Node.js API、路线分析和音乐选择逻辑都在本仓库中；网易云音乐 API 作为单独服务运行。

## 功能

- 输入起点、终点和步行、驾车或骑行方式；地点输入提供 Google Places 自动补全。
- 通过 Google Routes API 获取路线及预计时长，再从道路、周边区域和沿途场景构造路线特征。
- PEAR（感知、规划、行动、反思）流程调用 DeepSeek 生成路线解读、音乐策略和日中双语俳句式导语。
- 按路线分段的能量与节奏目标，从“我喜欢的音乐”候选中挑选歌曲，并尽量匹配路线总时长。
- 播放歌曲、显示歌词、切歌，并展示单曲和路线进度。
- 提供东京街区与场景资料，以及基于本地音频分析生成的歌曲特征缓存。

## 技术栈与目录

- Node.js 20+、ES modules、Express 5
- 原生 HTML、CSS 和 JavaScript 前端（`public/`）
- Google Routes API、Google Places API
- DeepSeek API
- NeteaseCloudMusicApi（本地单独运行；Vercel 上作为私有 Service 部署）

```text
public/       前端页面、播放器、歌词与背景效果
src/agent/    PEAR 编排、DeepSeek 规划器、选曲工具
src/services/ 路线、地点、音乐元数据和音频特征服务
services/netease/ 仅供 Sound-Map 私有调用的网易云 API Service
data/         东京区域资料、标签说明和歌曲特征缓存
scripts/      音频特征分析及路线数据辅助脚本
test/         Agent 测试
files/        Python 原型及相关资料（与当前 Node.js 应用分开）
```

## 本地运行

### 前置条件

- Node.js 20 或更新版本
- Google Maps Platform 项目已启用 Places API (New) 和 Routes API，并配置 API Key、账单及适当的 API 限制
- DeepSeek API Key
- 可登录的网易云音乐账号，以及本地运行的 NeteaseCloudMusicApi 服务

### 1. 安装依赖与配置密钥

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，填写自己的密钥和 Cookie：

```dotenv
PORT=4100
GOOGLE_MAPS_API_KEY=你的GoogleMapsApiKey
DEEPSEEK_API_KEY=你的DeepSeekApiKey
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
NETEASE_COOKIE=你的网易云Cookie
# 本地运行时指向本机 NeteaseCloudMusicApi；Vercel 会通过 Service Binding 注入私有地址
NETEASE_API_BASE_URL=http://127.0.0.1:3000

# 仅在访问外部 API 需要代理时填写
# HTTPS_PROXY=http://127.0.0.1:7890
```

`.env` 已加入 `.gitignore`。请勿提交真实 API Key、Cookie 或其他凭据。不要把 `.env` 内容粘贴到 issue、截图或聊天中。

### Vercel 部署

仓库根目录的 `vercel.json` 将主应用和 `services/netease/` 定义为两个 Service。主应用绑定到 `netease` Service，Vercel 在运行时注入 `NETEASE_PRIVATE_URL`；网易云 Service 没有公网 rewrite，只能由绑定它的主应用内部访问。代码优先使用这个注入地址，因此 Vercel 上不需要设置 `NETEASE_API_BASE_URL`。

1. 把包含 `vercel.json` 和 `services/netease/` 的提交推送到 GitHub。
2. 在 Vercel 项目 **Settings → Build and Deployment → Framework Preset** 中选择 **Services**，然后重新部署。若当前界面仍显示 Express / Python 应用列表，说明项目还没切换到 Services。
3. 在 Vercel 项目环境变量中设置 `GOOGLE_MAPS_API_KEY`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 和 `NETEASE_COOKIE`，至少选择 Production；需要预览环境时也为 Preview 配置。
4. 不要手动创建 `NETEASE_PRIVATE_URL`，它由 Service Binding 注入；生产环境也不要把 `NETEASE_API_BASE_URL` 设置成 localhost。
5. 如果此前为 npm 配过指向本机目录的 `NPM_CONFIG_CACHE`、`npm_config_cache` 或 `cache-dir`，请从 Vercel 环境变量中移除。Vercel 构建容器不能访问你电脑上的 npm 缓存目录。
6. 部署完成后检查 `/api/health`，再测试路线生成和歌曲播放。网易云 Service 故意没有单独的公网访问地址。

Vercel Services 当前处于 Beta。服务定义、rewrite 和 binding 由 [Vercel Services 文档](https://vercel.com/kb/guide/vercel-services)说明；Services 项目需要在 Vercel 项目设置中选择 Services framework。

### 2. 启动网易云 API 服务

在第一个终端运行：

```powershell
npm run netease
```

该服务默认监听 `http://127.0.0.1:3000`。按 NeteaseCloudMusicApi 的说明在该本地服务完成登录；Sound-Map 会通过 `NETEASE_API_BASE_URL` 请求登录状态、喜欢的音乐、播放地址和歌词。

### 3. 启动 Sound-Map

在第二个终端运行：

```powershell
npm run dev
```

打开 [http://localhost:4100](http://localhost:4100)。生产模式可用 `npm start` 启动同一个 Express 服务。

## API

所有 POST 请求均使用 JSON。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务健康检查 |
| `GET` | `/api/places/autocomplete?q=...&sessionToken=...` | 地点自动补全 |
| `GET` | `/api/places/details?placeId=...&sessionToken=...` | 获取地点坐标与地址 |
| `POST` | `/api/route` | 计算路线与路线特征 |
| `GET` | `/api/music/liked` | 读取网易云“我喜欢的音乐” |
| `GET` | `/api/music/playback/:songId` | 获取歌曲播放地址和歌词 |
| `POST` | `/api/agent/mixtape` | 等待完整结果后返回路线歌单 |
| `POST` | `/api/agent/mixtape/stream` | 以 Server-Sent Events 流式返回生成状态和最终结果 |

路线请求示例：

```json
{
  "origin": "Shibuya Station, Tokyo",
  "destination": "Daikanyama Station, Tokyo",
  "mode": "walking"
}
```

`mode` 可选值：`walking`、`driving`、`bicycling`。也可以附带地点坐标，字段格式为 `originLocation` / `destinationLocation`，每个对象包含 `latitude` 和 `longitude`。

## 测试与辅助脚本

运行自动化测试：

```powershell
npm test
```

分析歌曲音频特征的脚本：

```powershell
npm run audio:profile -- --help
```

音频分析会访问网易云音频地址并写入本地 `data/song-audio-features.json`；请避免短时间内大量请求，以免触发音源限流。分析结果属于运行时数据，不应作为推荐优先级信号。

## 部署说明

当前服务是一个集成式 Express 应用，同时依赖外部 Google 和 DeepSeek API、本地或可访问的 NeteaseCloudMusicApi，以及可写的诊断/特征数据文件。不能只把静态页面放到 CDN 就获得完整功能。正式部署前需要为网易云 API 提供安全可达的服务地址，配置生产环境变量，并确认流式 SSE、网络出口、日志及持久化存储均符合部署平台的运行模型。

不要在公开仓库中保存 `.env`、网易云 Cookie、日志中的路线位置或任何个人凭据。部署环境应通过平台的加密环境变量设置密钥。

## 许可与服务条款

本仓库依赖的第三方 API、音乐目录、歌词、音频及其使用限制分别由对应服务提供方管理。使用前请遵守 Google Maps Platform、DeepSeek、网易云音乐及 NeteaseCloudMusicApi 的条款和版权要求。本项目不随附商业音乐授权。
