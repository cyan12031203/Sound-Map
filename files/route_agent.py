"""
Route Agent V1 —— 「路线 → Claude 生成歌单」核心逻辑
不接 Spotify，先跑通最关键的一环：
    1. 用 Google Maps Directions API 拿到一条真实路线的"骨架"数据
    2. 把路线信息 + 你的口味档案 + 当下时间 交给 Claude
    3. Claude 理解这条路线的"性格"，并配出一份带能量曲线的歌单
    4. 打印结果，同时存一份 Markdown 文件方便你回看

使用方法：
    python route_agent.py
"""

import os
import json
import datetime
import requests
from dotenv import load_dotenv
from anthropic import Anthropic

load_dotenv()

GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

CLAUDE_MODEL = "claude-sonnet-5"


# ---------- 1. Route Geometry：拿路线原始数据 ----------

def get_route(origin: str, destination: str, mode: str = "walking") -> dict:
    """
    调用 Google Maps Directions API，返回这条路线的基础事实：
    距离、时长、途经的街道/地标名称（Route Geometry 这一层，只是事实，不做任何"理解"）
    """
    if not GOOGLE_MAPS_API_KEY:
        raise RuntimeError("没有找到 GOOGLE_MAPS_API_KEY，请检查 .env 文件")

    url = "https://maps.googleapis.com/maps/api/directions/json"
    params = {
        "origin": origin,
        "destination": destination,
        "mode": mode,
        "language": "ja",  # 街道名用日语更准确，Claude 读得懂
        "key": GOOGLE_MAPS_API_KEY,
    }
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != "OK":
        raise RuntimeError(f"路线请求失败：{data.get('status')} - {data.get('error_message', '')}")

    leg = data["routes"][0]["legs"][0]

    # 把每一段 step 的说明文字提取出来（去掉 HTML 标签），
    # 这就是 Claude 用来"感受"这条路的原材料
    steps = []
    for step in leg["steps"]:
        instruction = step["html_instructions"]
        # 简单去除 html 标签
        import re
        clean = re.sub("<[^<]+?>", " ", instruction).strip()
        steps.append({
            "instruction": clean,
            "distance": step["distance"]["text"],
            "duration": step["duration"]["text"],
        })

    return {
        "origin": leg["start_address"],
        "destination": leg["end_address"],
        "distance": leg["distance"]["text"],
        "duration": leg["duration"]["text"],
        "mode": mode,
        "steps": steps,
    }


# ---------- 2. 读取你的口味档案 ----------

def load_taste(path: str = "taste.md") -> str:
    if not os.path.exists(path):
        return "（用户还没有填写 taste.md，先用通用口味判断）"
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# ---------- 3. Route Character + Narrative + 选歌：全部交给 Claude 一次性完成 ----------

SYSTEM_PROMPT = """你是一个「移动音乐体验设计师」。你的任务不是根据交通方式推荐音乐，
而是理解用户正在经历的这一段具体路线，为这条路线本身配一份有起承转合的原声带。

你需要完成三层理解，再给出结果：

1. Route Character（路线性格）：根据途经的地名、街道描述、区域气质，判断这条路从"什么感觉"
   走向"什么感觉"（例如：从高密度商业区 走向 安静住宅区；或者：始终是日常生活感，没有明显转折）。
   不要瞎编具体数据（不要编"商业指数 8.5"这种假精确的数字），用定性描述就好。

2. Route Narrative（路线叙事）：把上面的判断，写成 2-3 句话的"这段旅程是什么感觉"的描述。

3. Soundtrack（配乐）：设计一份歌单，歌曲数量根据总时长估算（大约每首歌 3-4 分钟）。
   歌单要有能量曲线，呼应路线性格的变化（比如从热闹到平静，音乐也应该有对应的起伏）。
   优先从用户的口味档案里选歌/选相似风格的歌；如果口味档案信息不够，可以合理推荐符合
   这条路线氛围、且和用户已知口味相近的歌曲，但要在 reason 里说明为什么适合。

只输出一个 JSON 对象，不要有任何 JSON 之外的文字、不要用 markdown 代码块包裹。JSON 结构如下：

{
  "route_character": {
    "start_feel": "起点区域给人的感觉",
    "end_feel": "终点区域给人的感觉",
    "arc_type": "用一个短语概括这条路的性格转变类型"
  },
  "narrative": "2-3句话的路线叙事",
  "playlist": [
    {
      "order": 1,
      "title": "歌名",
      "artist": "艺人",
      "segment": "start / middle / end 三选一，表示这首歌对应路线的哪一段",
      "energy": 1到10的整数,
      "reason": "为什么这首歌适合放在这个位置，一句话"
    }
  ]
}
"""


def generate_soundtrack(route_info: dict, taste: str, time_context: str) -> dict:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("没有找到 ANTHROPIC_API_KEY，请检查 .env 文件")

    client = Anthropic(api_key=ANTHROPIC_API_KEY)

    steps_text = "\n".join(
        f"- {s['instruction']}（{s['distance']}, {s['duration']}）" for s in route_info["steps"]
    )

    user_prompt = f"""这是我接下来要走的一段路，请为它配乐。

【路线事实】
起点：{route_info['origin']}
终点：{route_info['destination']}
出行方式：{route_info['mode']}
总距离：{route_info['distance']}
总时长：{route_info['duration']}

途经：
{steps_text}

【当下时间】
{time_context}

【我的口味档案】
{taste}

请按系统提示的格式输出 JSON。"""

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=3000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )

    raw_text = response.content[0].text.strip()

    # 稳妥起见，去掉可能出现的代码块围栏
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]

    return json.loads(raw_text)


# ---------- 4. 展示结果 ----------

def render_result(route_info: dict, result: dict) -> str:
    lines = []
    lines.append(f"# {route_info['origin']} → {route_info['destination']}")
    lines.append(f"\n{route_info['distance']} · {route_info['duration']} · {route_info['mode']}\n")

    rc = result["route_character"]
    lines.append("## 路线性格")
    lines.append(f"起点感觉：{rc['start_feel']}")
    lines.append(f"终点感觉：{rc['end_feel']}")
    lines.append(f"转变类型：{rc['arc_type']}\n")

    lines.append("## 路线叙事")
    lines.append(result["narrative"] + "\n")

    lines.append("## 原声带")
    for song in result["playlist"]:
        bar = "█" * song["energy"] + "░" * (10 - song["energy"])
        lines.append(
            f"{song['order']:>2}. [{song['segment']:>6}] {bar} "
            f"{song['title']} — {song['artist']}"
        )
        lines.append(f"       └ {song['reason']}")

    return "\n".join(lines)


# ---------- 主流程 ----------

def main():
    print("=== Route Agent V1 ===")
    origin = input("起点（例如：涩谷站）：").strip()
    destination = input("终点（例如：代官山站）：").strip()
    mode = input("出行方式 walking / transit / bicycling（默认 walking）：").strip() or "walking"

    print("\n正在获取路线...")
    route_info = get_route(origin, destination, mode)

    print("正在读取口味档案...")
    taste = load_taste()

    now = datetime.datetime.now()
    weekday_cn = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][now.weekday()]
    time_context = now.strftime(f"%Y-%m-%d {weekday_cn} %H:%M")

    print("正在生成原声带（调用 Claude）...\n")
    result = generate_soundtrack(route_info, taste, time_context)

    output = render_result(route_info, result)
    print(output)

    # 存一份记录，方便你回看，也是未来做"反馈闭环"的数据基础
    os.makedirs("history", exist_ok=True)
    filename = f"history/{now.strftime('%Y%m%d_%H%M')}_{origin}_{destination}.md".replace(" ", "")
    with open(filename, "w", encoding="utf-8") as f:
        f.write(output)
    print(f"\n（已保存到 {filename}）")


if __name__ == "__main__":
    main()
