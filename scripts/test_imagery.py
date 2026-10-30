"""Small smoke-test/demo for the Tokyo imagery query module."""

from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from tokyo_imagery import (  # noqa: E402
    build_imagery_chain,
    get_area_imagery,
    get_image_associations,
    search_route_imagery,
)


CASES = [
    ["神保町"],
    ["神保町", "御茶ノ水"],
    ["吉祥寺", "井の頭公園"],
    ["下北沢"],
    ["高円寺", "阿佐ヶ谷"],
]


def main():
    for requested_areas in CASES:
        result = search_route_imagery(requested_areas)
        canonical = [area["area"] for area in result["areas"]]
        label = " → ".join(requested_areas)
        print(f"\nAREA: {label}")
        if result["unmatched_areas"]:
            print("UNMATCHED (not in MVP dataset): " + " / ".join(result["unmatched_areas"]))
        if not canonical:
            print("No matching areas found.")
            continue

        images = [image["term"] for image in result["images"]]
        associations = [entry["term"] for entry in result["associations"]]
        print("CONCRETE IMAGES: " + " / ".join(images))
        print("ASSOCIATIONS: " + (" / ".join(associations) if associations else "(not generated yet)"))
        print("IMAGERY CHAIN: " + " → ".join(build_imagery_chain(canonical, max_images=12)))

    # Basic integrity checks: all 10 seed areas and at least 8 concrete images each.
    expected = ["神保町", "御茶ノ水", "吉祥寺", "井の頭公園", "下北沢", "谷中", "根津", "清澄白河", "高円寺", "神楽坂"]
    for area_name in expected:
        area = get_area_imagery(area_name)
        assert area is not None, f"Missing MVP area: {area_name}"
        assert 8 <= len(area.get("images", [])) <= 15, f"Unexpected image count for {area_name}"
        assert len(get_image_associations(area_name)) == len(area["images"])
    assert len(build_imagery_chain(["神保町", "御茶ノ水"], max_images=12)) <= 12
    print("\nSmoke tests passed.")


if __name__ == "__main__":
    main()
