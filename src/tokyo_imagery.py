"""Queries and lightweight graph search for Tokyo poetic imagery.

The module is deliberately independent from the existing route/music pipeline.
The JSON file is the only storage layer; the graph scorer can be replaced later.
"""

import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path


DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "tokyo_imagery.json"


def _normalize(value):
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return re.sub(r"\s+", "", value)


def _load_data(path=None):
    data_path = Path(path) if path else DATA_PATH
    with data_path.open("r", encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, list):
        raise ValueError("Tokyo imagery data must be a list of areas.")
    return value


def _resolve_area(dataset, area_name):
    query = _normalize(area_name)
    if not query:
        return None
    exact = []
    partial = []
    for area in dataset:
        names = [area.get("area", ""), *area.get("aliases", [])]
        normalized_names = [_normalize(name) for name in names if name]
        if query in normalized_names:
            exact.append(area)
        elif any(query in name or name in query for name in normalized_names):
            partial.append(area)
    if exact:
        return exact[0]
    return partial[0] if len(partial) == 1 else None


def get_area_imagery(area_name):
    """Return one area's record by canonical name or alias, or None."""
    return _resolve_area(_load_data(), area_name)


def get_image_associations(area_name):
    """Return concrete image records and their association terms for an area."""
    area = get_area_imagery(area_name)
    if not area:
        return []
    return [
        {"term": image["term"], "type": image.get("type", "object"), "associations": list(image.get("associations", []))}
        for image in area.get("images", [])
    ]


def search_imagery(query):
    """Search concrete terms and associations; exact matches rank before substrings."""
    needle = _normalize(query)
    if not needle:
        return []
    results = []
    for area in _load_data():
        for image in area.get("images", []):
            terms = [image.get("term", ""), *image.get("associations", [])]
            matched = [term for term in terms if needle == _normalize(term)]
            rank = 0 if matched else 1
            if not matched:
                matched = [term for term in terms if needle in _normalize(term) or _normalize(term) in needle]
            if matched:
                results.append({
                    "area": area["area"],
                    "image": image["term"],
                    "type": image.get("type", "object"),
                    "associations": list(image.get("associations", [])),
                    "matched_terms": list(dict.fromkeys(matched)),
                    "rank": rank,
                })
    return sorted(results, key=lambda row: (row["rank"], row["area"], row["image"]))


def search_route_imagery(areas):
    """Aggregate selected areas, exact-deduping terms while retaining provenance.

    Near terms such as 夜 and 夜の街 are intentionally distinct.
    """
    dataset = _load_data()
    selected = []
    unmatched = []
    selected_keys = set()
    for requested in areas:
        area = _resolve_area(dataset, requested)
        if not area:
            unmatched.append(requested)
            continue
        key = _normalize(area["area"])
        if key not in selected_keys:
            selected.append(area)
            selected_keys.add(key)

    image_index = {}
    association_index = {}
    for area in selected:
        area_name = area["area"]
        for image in area.get("images", []):
            term = str(image.get("term", "")).strip()
            term_key = _normalize(term)
            if not term_key:
                continue
            if term_key not in image_index:
                image_index[term_key] = {
                    "term": term,
                    "type": image.get("type", "object"),
                    "areas": [],
                    "associations": [],
                }
            record = image_index[term_key]
            if area_name not in record["areas"]:
                record["areas"].append(area_name)
            assoc_keys = {_normalize(value) for value in record["associations"]}
            for value in image.get("associations", []):
                clean = str(value).strip()
                clean_key = _normalize(clean)
                if clean_key and clean_key not in assoc_keys:
                    record["associations"].append(clean)
                    assoc_keys.add(clean_key)
                if not clean_key:
                    continue
                if clean_key not in association_index:
                    association_index[clean_key] = {"term": clean, "from": []}
                provenance = {"area": area_name, "image": term}
                if provenance not in association_index[clean_key]["from"]:
                    association_index[clean_key]["from"].append(provenance)

    return {
        "areas": selected,
        "images": list(image_index.values()),
        "associations": list(association_index.values()),
        "unmatched_areas": unmatched,
    }


def build_imagery_chain(areas, max_images=12):
    """Return a scored, area-diverse path through the directed association graph.

    Edges are stored in both directions for the MVP search. Beam search keeps the
    algorithm bounded; replace `_best_graph_path` later without changing the API.
    """
    try:
        limit = max(1, int(max_images))
    except (TypeError, ValueError):
        limit = 12
    route = search_route_imagery(areas)
    if not route["areas"]:
        return []

    records = []
    area_order = {area["area"]: index for index, area in enumerate(route["areas"])}
    for area in route["areas"]:
        for image in area.get("images", []):
            if image.get("term"):
                records.append({"term": image["term"], "type": image.get("type", "object"), "area": area["area"], "associations": image.get("associations", [])})

    graph = defaultdict(set)
    node_areas = defaultdict(set)
    association_areas = defaultdict(set)
    node_types = defaultdict(set)
    display = {}
    for image in records:
        source = image["term"]
        source_key = _normalize(source)
        display.setdefault(source_key, source)
        node_areas[source_key].add(image["area"])
        node_types[source_key].add(image["type"])
        for association in image["associations"]:
            target = str(association).strip()
            target_key = _normalize(target)
            if not target_key or target_key == source_key:
                continue
            display.setdefault(target_key, target)
            graph[source_key].add(target_key)
            graph[target_key].add(source_key)
            association_areas[target_key].add(image["area"])
    for node, source_areas in association_areas.items():
        node_areas[node].update(source_areas)

    if not any(graph.values()):
        return _fallback_chain(records, limit)

    return _best_graph_path(graph, display, node_areas, association_areas, node_types, area_order, records, limit)


def _best_graph_path(graph, display, node_areas, association_areas, node_types, area_order, records, limit):
    starts = []
    first_area = records[0]["area"]
    for record in records:
        key = _normalize(record["term"])
        if graph.get(key):
            starts.append((key, first_area == record["area"]))
    if not starts:
        return _fallback_chain(records, limit)

    # state: (path node keys, covered route areas, score)
    beam = []
    for key, starts_in_first in starts:
        covered = set(node_areas[key])
        beam.append(([key], covered, 1.4 if starts_in_first else 0.0))
    best = max(beam, key=lambda state: _terminal_score(state, association_areas, area_order))
    beam_width = 160

    for depth in range(1, limit):
        candidates = []
        for path, covered, score in beam:
            current = path[-1]
            for neighbor in graph.get(current, ()):
                if neighbor in path:
                    continue
                new_areas = set(node_areas[neighbor]) - covered
                new_covered = covered | node_areas[neighbor]
                bridge_bonus = 1.8 if len(association_areas.get(neighbor, ())) >= 2 else 0.0
                concrete_bonus = 0.5 if node_types.get(neighbor) else 0.0
                diversity_bonus = 0.35 if node_types.get(neighbor) and not (node_types[neighbor] & set().union(*(node_types.get(node, set()) for node in path))) else 0.0
                new_score = score + len(new_areas) * 3.4 + bridge_bonus + concrete_bonus + diversity_bonus - 0.08
                candidates.append((path + [neighbor], new_covered, new_score))
        if not candidates:
            break
        candidates.sort(key=lambda state: _terminal_score(state, association_areas, area_order), reverse=True)
        seen = set()
        beam = []
        for candidate in candidates:
            signature = tuple(candidate[0])
            if signature in seen:
                continue
            seen.add(signature)
            beam.append(candidate)
            if len(beam) >= beam_width:
                break
        winner = max(beam, key=lambda state: _terminal_score(state, association_areas, area_order))
        if _terminal_score(winner, association_areas, area_order) > _terminal_score(best, association_areas, area_order):
            best = winner

    terms = [display[key] for key in best[0]]
    return terms if len(terms) > 1 else _fallback_chain(records, limit)


def _terminal_score(state, association_areas, area_order):
    path, covered, score = state
    route_ordered_coverage = len(covered)
    shared_bridges = sum(1 for node in path if len(association_areas.get(node, ())) >= 2)
    useful_length = min(len(path), 9)
    return score + route_ordered_coverage * 2.2 + shared_bridges * 1.4 + useful_length * 0.45


def _fallback_chain(records, limit):
    """Interleave exact unique concrete images if there are no usable edges."""
    output = []
    seen = set()
    by_area = defaultdict(list)
    for record in records:
        key = _normalize(record["term"])
        if key and key not in seen:
            seen.add(key)
            by_area[record["area"]].append(record["term"])
    areas = list(by_area)
    round_index = 0
    while len(output) < limit:
        found = False
        for area in areas:
            if round_index < len(by_area[area]):
                output.append(by_area[area][round_index])
                found = True
                if len(output) >= limit:
                    break
        if not found:
            break
        round_index += 1
    return output
