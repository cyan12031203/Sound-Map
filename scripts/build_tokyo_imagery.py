#!/usr/bin/env python3
"""Generate association links for the curated Tokyo imagery seed JSON."""

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "tokyo_imagery.json"
NEIGHBORHOOD_INDEX_PATH = ROOT / "data" / "tokyo_neighborhood_index.json"
AREA_GEOMETRY_PATH = ROOT / "data" / "tokyo_area_index.json"
DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-flash"
ALLOWED_TYPES = {"object", "place", "activity", "nature", "architecture", "people", "sound", "movement", "food", "history"}
BLOCKED_ASSOCIATIONS = {
    "文艺", "高雅", "浪漫", "安静", "青春", "回忆", "美", "漂亮", "时尚", "有生活气息",
    "ロマンチック", "静けさ", "おしゃれ", "青春", "思い出", "美しさ", "高雅", "素敵",
}


def read_project_env(path=ROOT / ".env"):
    """Read only the named configuration values; never print secret contents."""
    values = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def get_config(name, fallback, env_file):
    return os.environ.get(name) or read_project_env(env_file).get(name) or fallback


def normalize(value):
    return re.sub(r"\s+", "", str(value or "")).casefold()


def load_dataset(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("tokyo_imagery.json 顶层必须是区域数组。")
    return data


def find_area(dataset, requested):
    key = normalize(requested)
    for area in dataset:
        names = [area.get("area", ""), *area.get("aliases", [])]
        if any(normalize(name) == key for name in names):
            return area
    return None


def build_prompt(area, images, seed):
    terms = [{"term": item["term"], "type": item["type"]} for item in images]
    return {
        "task": "为东京区域的具体意象建立克制、可用于诗歌联想的 association links",
        "area": area["area"],
        "seed": seed,
        "images": terms,
        "rules": [
            "只返回 JSON 对象，格式为 {associations:[{term:string, items:[string,string,string]}]}。",
            "每个输入 term 必须恰好出现一次，并为它提供 3 到 5 个不同的日语联想词。",
            "联想必须能从具体意象自然抵达，可为物件、动作、声音、时间或概念。",
            "优先选择有触感、有形状、能进入诗句的词，避免旅游宣传和情绪标签。",
            "不要使用浪漫、安静、文艺、时尚、青春、回忆、美好等泛化评价。",
            "同一个 area 内避免反复用完全相同的联想词；允许跨 area 有意重复以形成图谱连接。",
            "不要虚构该区域的具体事实；关联是诗性联想，不要声称是当地真实设施。",
        ],
    }


def build_expansion_prompt(areas, seed):
    return {
        "task": "为东京散步路线意象图谱补充街区级 concrete images 与联想边",
        "seed": seed,
        "areas": [{
            "area": area["name"],
            "wards": area.get("ward", []),
            "aliases": area.get("aliases", []),
            "map_anchors": area.get("anchors", []),
        } for area in areas],
        "output": {
            "areas": [{
                "area": "必须与输入名称完全一致",
                "images": [{"term": "具体日语意象", "type": "object/place/activity/nature/architecture/people/sound/movement/food/history", "associations": ["联想词一", "联想词二", "联想词三"]}],
            }],
        },
        "rules": [
            "每个 area 输出 8 个 images，每个 image 恰好 3 个 associations。",
            "term 应尽量是可感知的具体事物、地点构件、人物、动作或声音；不要把文艺、宁静、时尚、浪漫等 mood 当作 term。",
            "结合区域名、所属区和地图锚点，优先选真实且有辨识度的东京日常意象；map_anchors 是检索线索，不代表可任意扩写为未验证设施。",
            "不要虚构特定店铺、活动或设施；不确定的具体地标宁可不用。association 可以自然延伸到动作、声音、时间或抽象概念，但避免旅游宣传语。",
            "每条联想都必须具体、自然、彼此不同，且不能与自己的 term 相同；不要在 associations 中使用安静、浪漫、时尚、青春、回忆、静けさ、おしゃれ等泛化情绪词。",
            "同一街区内避免重复；跨街区可复用能形成图谱连接的意象。",
            "所有 term 和 associations 使用日语；只返回 JSON，不带 Markdown 或说明。",
        ],
    }


def validate_expansion_response(response, requested_areas):
    rows = response.get("areas")
    if not isinstance(rows, list):
        raise ValueError("DeepSeek 扩区响应缺少 areas 数组。")
    by_area = {normalize(row.get("area")): row for row in rows if isinstance(row, dict)}
    validated = []
    for area in requested_areas:
        row = by_area.get(normalize(area["name"]))
        images = row.get("images") if row else None
        if not isinstance(images, list) or not 8 <= len(images) <= 10:
            raise ValueError("区域「{}」的 images 数量不是 8–10。".format(area["name"]))
        seen_terms = set()
        clean_images = []
        for image in images:
            if not isinstance(image, dict):
                raise ValueError("区域「{}」包含无效 image。".format(area["name"]))
            term = str(image.get("term", "")).strip()
            key = normalize(term)
            image_type = image.get("type")
            associations = image.get("associations")
            if not term or key in seen_terms or image_type not in ALLOWED_TYPES:
                raise ValueError("区域「{}」包含重复 term 或无效 type。".format(area["name"]))
            if key in {normalize(value) for value in BLOCKED_ASSOCIATIONS}:
                raise ValueError("区域「{}」把泛化情绪词当作具体意象。".format(area["name"]))
            if not isinstance(associations, list) or len(associations) != 3:
                raise ValueError("意象「{}」必须恰好有 3 个 associations。".format(term))
            cleaned = []
            for association in associations:
                value = str(association).strip()
                association_key = normalize(value)
                if (not value or association_key == key
                        or association_key in {normalize(item) for item in cleaned}
                        or association_key in {normalize(blocked) for blocked in BLOCKED_ASSOCIATIONS}):
                    continue
                cleaned.append(value)
            if len(cleaned) < 3:
                raise ValueError("意象「{}」去重或过滤后有效联想少于 3 个。".format(term))
            seen_terms.add(key)
            clean_images.append({"term": term, "type": image_type, "associations": cleaned})
        validated.append({
            "area": area["name"],
            "aliases": list(dict.fromkeys([*area.get("aliases", []), *area.get("anchors", [])])),
            "images": clean_images,
            "image_source": "deepseek_grounded_in_candidate_names_and_anchors",
            "association_source": "deepseek",
        })
    return validated


def call_deepseek(payload, api_key, base_url, model, seed, timeout):
    endpoint = base_url.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是谨慎的日语意象编辑。遵守 JSON schema 和输入 term，不输出解释或 Markdown。",
            },
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "max_tokens": 3000,
        "temperature": 0,
        "seed": seed,
        "thinking": {"type": "disabled"},
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
        method="POST",
    )

    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            if isinstance(content, list):
                content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
            content = str(content).strip()
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.IGNORECASE)
            if not content:
                raise ValueError("DeepSeek 返回空内容。")
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                raise ValueError("DeepSeek 返回内容不是 JSON 对象。")
            return parsed
        except urllib.error.HTTPError as error:
            # Avoid echoing request headers or the API key in diagnostics.
            detail = error.read().decode("utf-8", errors="replace")[:500]
            if attempt == 1 or error.code < 500 and error.code != 429:
                raise RuntimeError("DeepSeek HTTP 错误 {}：{}".format(error.code, detail)) from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
            if attempt == 1:
                raise RuntimeError("DeepSeek 请求或 JSON 校验失败：{}".format(error)) from None
        time.sleep(1 + attempt)
    raise RuntimeError("DeepSeek 请求失败。")


def validate_associations(response, images):
    rows = response.get("associations")
    if not isinstance(rows, list):
        raise ValueError("响应缺少 associations 数组。")
    by_term = {normalize(row.get("term")): row for row in rows if isinstance(row, dict)}
    validated = {}
    for image in images:
        row = by_term.get(normalize(image["term"]))
        values = row.get("items", row.get("associations", [])) if row else []
        if not isinstance(values, list):
            raise ValueError("意象「{}」的 associations 格式无效。".format(image["term"]))
        clean = []
        seen = set()
        for value in values:
            if not isinstance(value, str):
                continue
            term = re.sub(r"\s+", " ", value.strip()).strip("，,。.;；")
            key = normalize(term)
            if not term or key in seen or key in {normalize(item) for item in BLOCKED_ASSOCIATIONS}:
                continue
            if key == normalize(image["term"]):
                continue
            seen.add(key)
            clean.append(term)
            if len(clean) == 5:
                break
        if len(clean) < 3:
            raise ValueError("意象「{}」有效联想少于 3 个；原数据保持不变。".format(image["term"]))
        validated[image["term"]] = clean
    return validated


def atomic_save(path, dataset):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(path.parent), suffix=".tmp", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(dataset, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(str(temporary_path), str(path))
    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="生成东京意象图谱的 associations。")
    parser.add_argument("--area", help="只处理指定区域，也接受该区域 aliases 中的名称。")
    parser.add_argument("--expand-index", action="store_true", help="从 100 街区候选索引生成缺失区域的意象与联想；每批默认 4 个区域。")
    parser.add_argument("--batch-size", type=int, default=4, help="扩区时每次 DeepSeek 请求处理的区域数（默认：4，范围 1–6）。")
    parser.add_argument("--force", action="store_true", help="重新生成已存在的 associations。")
    parser.add_argument("--seed", type=int, default=42, help="尽可能稳定输出的随机种子（默认：42）。")
    parser.add_argument("--timeout", type=int, default=45, help="单次 API 请求超时秒数（默认：45）。")
    parser.add_argument("--data", type=Path, default=DATA_PATH, help=argparse.SUPPRESS)
    parser.add_argument("--limit", type=int, help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        dataset = load_dataset(args.data)
        selected = [find_area(dataset, args.area)] if args.area else dataset
        if args.area and not selected[0]:
            raise ValueError("找不到区域「{}」。".format(args.area))

        env_file = ROOT / ".env"
        api_key = get_config("DEEPSEEK_API_KEY", "", env_file).strip()
        if not api_key:
            raise RuntimeError("缺少 DEEPSEEK_API_KEY。请在项目根目录 .env 或系统环境变量中配置。")
        base_url = get_config("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL, env_file).strip()
        model = get_config("DEEPSEEK_MODEL", DEFAULT_MODEL, env_file).strip()

        if args.expand_index:
            if not 1 <= args.batch_size <= 6:
                raise ValueError("--batch-size 必须在 1–6 之间。")
            candidate_data = json.loads(NEIGHBORHOOD_INDEX_PATH.read_text(encoding="utf-8"))
            candidate_areas = candidate_data.get("areas", [])
            if args.area:
                key = normalize(args.area)
                candidate_areas = [area for area in candidate_areas if key in {normalize(area.get("name")), *(normalize(alias) for alias in area.get("aliases", []))}]
                if not candidate_areas:
                    raise ValueError("候选街区表中找不到区域「{}」。".format(args.area))
            existing_names = {normalize(area.get("area")) for area in dataset}
            pending_areas = [area for area in candidate_areas if normalize(area.get("imagery_area") or area["name"]) not in existing_names]
            if args.limit is not None:
                pending_areas = pending_areas[:max(0, args.limit)]
            if not pending_areas:
                print("没有缺失的候选区域需要扩充。")
                return 0

            geometry_index = json.loads(AREA_GEOMETRY_PATH.read_text(encoding="utf-8"))
            total_areas = 0
            for batch_number, offset in enumerate(range(0, len(pending_areas), args.batch_size)):
                batch = pending_areas[offset:offset + args.batch_size]
                seed = args.seed + batch_number
                payload = build_expansion_prompt(batch, seed)
                for attempt in range(2):
                    response = call_deepseek(payload, api_key, base_url, model, seed + attempt * 10000, args.timeout)
                    try:
                        additions = validate_expansion_response(response, batch)
                        break
                    except ValueError as error:
                        if attempt:
                            raise
                        payload["correction"] = "上次响应未通过校验：{}。请重新生成本批所有区域，严格满足每区8个意象、每个意象3条不重复且不含禁用词的联想。".format(error)
                next_dataset = [*dataset, *additions]
                next_candidate_data = dict(candidate_data)
                next_candidate_data["areas"] = [
                    {**area, "imagery_area": area.get("imagery_area") or area["name"]}
                    if any(area["id"] == candidate["id"] for candidate in batch) else area
                    for area in candidate_data["areas"]
                ]
                next_geometry_index = dict(geometry_index)
                next_geometry_index["areas"] = [
                    {**area, "imagery_area": area.get("imagery_area") or area["name"]}
                    if area.get("id") in {candidate["id"] for candidate in batch} else area
                    for area in geometry_index["areas"]
                ]
                atomic_save(args.data, next_dataset)
                atomic_save(NEIGHBORHOOD_INDEX_PATH, next_candidate_data)
                atomic_save(AREA_GEOMETRY_PATH, next_geometry_index)
                dataset, candidate_data, geometry_index = next_dataset, next_candidate_data, next_geometry_index
                total_areas += len(additions)
                print("已完成批次 {}：{} 个区域，{} 个意象。".format(batch_number + 1, len(additions), sum(len(area["images"]) for area in additions)))
            print("扩区完成：新增 {} 个区域，保存至 {}。".format(total_areas, args.data))
            return 0

        total_generated = 0
        for index, area in enumerate(selected):
            pending = [
                image for image in area.get("images", [])
                if args.force or len(image.get("associations", [])) < 3
            ]
            if not pending:
                print("跳过 {}：数据已存在（使用 --force 重生成）。".format(area["area"]))
                continue

            payload = build_prompt(area, pending, args.seed + index)
            response = call_deepseek(payload, api_key, base_url, model, args.seed + index, args.timeout)
            associations = validate_associations(response, pending)
            # Only mutate/save after every image in this area has passed validation.
            for image in pending:
                image["associations"] = associations[image["term"]]
            atomic_save(args.data, dataset)
            total_generated += len(pending)
            print("已生成 {}：{} 个意象。".format(area["area"], len(pending)))

        if total_generated == 0:
            print("没有需要生成的数据。")
        else:
            print("完成：更新 {} 个意象，保存至 {}。".format(total_generated, args.data))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print("生成失败：{}".format(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
