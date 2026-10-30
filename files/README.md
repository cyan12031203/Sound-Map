# Route Agent V1

「路线 → Claude 理解 → 生成配乐歌单」的最小可行版本。不连 Spotify，先跑通核心体验：
输入一段路，Claude 读懂这条路的性格，给你一份带能量曲线的歌单。

## 这一版做了什么 / 没做什么

做了：
- 用 Google Maps 拿到真实路线数据（距离、时长、途经街道）
- Claude 一次性完成「路线性格判断 → 叙事 → 配乐」三件事
- 结果打印出来，同时存成 Markdown 存档在 `history/` 文件夹

还没做（后面几个版本再加）：
- 不会自动在 Spotify 建播放列表，你需要照着歌单自己去搜/加歌
- 不会根据你的反馈（跳过/单曲循环）学习和迭代
- 不会中途根据实时位置动态调整

## 准备工作（大约 10 分钟，只需要做一次）

### 1. 安装 Python 依赖

打开终端，进入这个文件夹，执行：

```bash
pip install -r requirements.txt
```

### 2. 拿两把 API Key

**Anthropic API Key（用来调用 Claude）**
1. 打开 https://console.anthropic.com/
2. 左侧找到 "API Keys"，点 "Create Key"，复制生成的 key

**Google Maps API Key（用来拿路线数据）**
1. 打开 https://console.cloud.google.com/
2. 新建一个项目（随便起名）
3. 左侧菜单找到 "API 和服务" → "库"，搜索 "Directions API"，点启用
4. 左侧 "凭据" → "创建凭据" → "API 密钥"，复制生成的 key
5. 新用户 Google Cloud 有免费额度，个人项目这点调用量基本用不完，但建议在"凭据"里给这个 key 加一个限制（只允许调用 Directions API），避免泄露后被滥用

### 3. 配置 Key

把 `.env.example` 复制一份，改名为 `.env`，把两把 key 填进去：

```
ANTHROPIC_API_KEY=sk-ant-xxxxxx
GOOGLE_MAPS_API_KEY=AIzaxxxxxx
```

`.env` 这个文件不要上传到任何地方（如果之后你把这个项目放到 GitHub，记得把 `.env` 加进 `.gitignore`）。

### 4. 填一份口味档案

打开 `taste.md`，花几分钟写几个你喜欢的艺人/歌曲/风格偏好。这一步决定了 Claude 生成歌单的准确度，值得认真填一点。之后随时可以回来补充。

## 运行

```bash
python route_agent.py
```

按提示输入起点、终点、出行方式（比如"涩谷站" → "代官山站"，走路），
等几秒，Claude 会给你一份路线叙事 + 能量曲线歌单，同时存一份记录在 `history/` 文件夹里。

## 遇到报错怎么办

- `没有找到 ANTHROPIC_API_KEY` / `GOOGLE_MAPS_API_KEY`：检查 `.env` 文件名有没有拼对（不是 `.env.example`），key 有没有粘贴完整
- `路线请求失败：REQUEST_DENIED`：说明 Google Maps 那把 key 没有启用 Directions API，回第 2 步检查
- `路线请求失败：ZERO_RESULTS`：说明起点终点之间用这个出行方式规划不出路线，换个更明确的地名试试（比如带上"站"、"駅"）
- Claude 返回的内容解析失败（JSON 报错）：概率很低，多是模型输出里混了多余文字，重新跑一次通常就好；如果反复出现，可以把 `route_agent.py` 里的报错信息发给我看

## 下一步（V2 预告）

跑顺了之后，下一步是把 `history/` 里积累的路线记录用起来——记录你在每条路线上跳过/反复听的歌，
让 Claude 在生成新路线歌单时参考"你在类似路线上的历史偏好"，这也是你最初设想里最有意思的
"个性化"那一部分。等这一版你用顺手了，我们再往上加。
