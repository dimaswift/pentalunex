#!/usr/bin/env python3
"""Vectorize exported PNG map tiles and merge them with optimized graticules.

The browser tile export writes matching files such as:

    export/tiles/iso_corner0_face5_map.png
    export/tiles/iso_corner0_face5_graticule.svg

This script turns every ``*_map.png`` into editable SVG land/coastline shapes
with VTracer, flattens and de-duplicates the matching graticule SVG, and adds an
explicit rhomb boundary from ``export/manifest.json``.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Iterable, Sequence

from PIL import Image
import vtracer


SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)

COMMAND_OR_NUMBER_RE = re.compile(
    r"[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
)
TRANSFORM_RE = re.compile(r"([a-zA-Z]+)\(([^)]*)\)")


Affine = tuple[float, float, float, float, float, float]
Point = tuple[float, float]


def identity() -> Affine:
    return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def compose(a: Affine, b: Affine) -> Affine:
    """Return a matrix that applies b, then a."""

    return (
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    )


def apply_matrix(m: Affine, p: Point) -> Point:
    return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def parse_float_list(text: str) -> list[float]:
    return [float(v) for v in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?", text)]


def parse_transform(text: str | None) -> Affine:
    if not text:
        return identity()

    matrix = identity()
    for name, args_text in TRANSFORM_RE.findall(text):
        args = parse_float_list(args_text)
        name = name.lower()
        local = identity()
        if name == "matrix" and len(args) >= 6:
            local = tuple(args[:6])  # type: ignore[assignment]
        elif name == "translate":
            tx = args[0] if args else 0.0
            ty = args[1] if len(args) > 1 else 0.0
            local = (1.0, 0.0, 0.0, 1.0, tx, ty)
        elif name == "scale":
            sx = args[0] if args else 1.0
            sy = args[1] if len(args) > 1 else sx
            local = (sx, 0.0, 0.0, sy, 0.0, 0.0)
        elif name == "rotate" and args:
            angle = math.radians(args[0])
            c = math.cos(angle)
            s = math.sin(angle)
            rot = (c, s, -s, c, 0.0, 0.0)
            if len(args) >= 3:
                cx, cy = args[1], args[2]
                local = compose(compose((1.0, 0.0, 0.0, 1.0, cx, cy), rot), (1.0, 0.0, 0.0, 1.0, -cx, -cy))
            else:
                local = rot
        elif name == "skewx" and args:
            local = (1.0, 0.0, math.tan(math.radians(args[0])), 1.0, 0.0, 0.0)
        elif name == "skewy" and args:
            local = (1.0, math.tan(math.radians(args[0])), 0.0, 1.0, 0.0, 0.0)
        matrix = compose(matrix, local)
    return matrix


def fmt(value: float, precision: int = 3) -> str:
    text = f"{value:.{precision}f}".rstrip("0").rstrip(".")
    return "0" if text == "-0" else text


def point_key(p: Point, precision: int) -> tuple[float, float]:
    return (round(p[0], precision), round(p[1], precision))


def segment_key(a: Point, b: Point, precision: int) -> tuple[tuple[float, float], tuple[float, float]]:
    ka = point_key(a, precision)
    kb = point_key(b, precision)
    return (ka, kb) if ka <= kb else (kb, ka)


def parse_path_points(d: str) -> list[Point]:
    """Extract M/L polyline points from a path.

    Exported graticule paths use M/L commands. Curves from other SVGs are not
    flattened here because we only run this on graticule/boundary overlays.
    """

    tokens = COMMAND_OR_NUMBER_RE.findall(d)
    points: list[Point] = []
    command = ""
    i = 0
    current = (0.0, 0.0)
    start = (0.0, 0.0)
    while i < len(tokens):
        token = tokens[i]
        if re.match(r"^[A-Za-z]$", token):
            command = token
            i += 1
            if command in "Zz":
                points.append(start)
            continue

        if command in "MmLl":
            if i + 1 >= len(tokens):
                break
            x = float(tokens[i])
            y = float(tokens[i + 1])
            if command in "ml":
                x += current[0]
                y += current[1]
            current = (x, y)
            if command in "Mm":
                start = current
                command = "l" if command == "m" else "L"
            points.append(current)
            i += 2
        elif command in "Hh":
            x = float(tokens[i])
            if command == "h":
                x += current[0]
            current = (x, current[1])
            points.append(current)
            i += 1
        elif command in "Vv":
            y = float(tokens[i])
            if command == "v":
                y += current[1]
            current = (current[0], y)
            points.append(current)
            i += 1
        else:
            i += 1
    return points


def simplify_polyline(points: Sequence[Point], precision: int, min_length: float) -> list[Point]:
    out: list[Point] = []
    for p in points:
        if not out or point_key(out[-1], precision) != point_key(p, precision):
            out.append(p)

    changed = True
    while changed and len(out) >= 3:
        changed = False
        simplified = [out[0]]
        for a, b, c in zip(out, out[1:], out[2:]):
            ab = (b[0] - a[0], b[1] - a[1])
            bc = (c[0] - b[0], c[1] - b[1])
            cross = abs(ab[0] * bc[1] - ab[1] * bc[0])
            scale = max(math.hypot(*ab) + math.hypot(*bc), 1.0)
            if cross / scale > 0.02:
                simplified.append(b)
            else:
                changed = True
        simplified.append(out[-1])
        out = simplified

    if len(out) == 2 and math.dist(out[0], out[1]) < min_length:
        return []
    return out


def polyline_path(points: Sequence[Point], precision: int = 2, close: bool = False) -> str:
    if not points:
        return ""
    chunks = [f"M{fmt(points[0][0], precision)},{fmt(points[0][1], precision)}"]
    chunks.extend(f"L{fmt(x, precision)},{fmt(y, precision)}" for x, y in points[1:])
    if close:
        chunks.append("Z")
    return "".join(chunks)


def iter_svg_paths(element: ET.Element, inherited: Affine | None = None) -> Iterable[tuple[ET.Element, Affine]]:
    inherited = identity() if inherited is None else inherited
    local = parse_transform(element.attrib.get("transform"))
    matrix = compose(inherited, local)
    if element.tag.endswith("path"):
        yield element, matrix
    for child in list(element):
        yield from iter_svg_paths(child, matrix)


def optimized_graticule_paths(
    svg_path: Path,
    *,
    precision: int = 2,
    dedupe_precision: int = 2,
    min_segment_length: float = 0.5,
) -> list[str]:
    if not svg_path.exists():
        return []

    root = ET.parse(svg_path).getroot()
    seen_segments: set[tuple[tuple[float, float], tuple[float, float]]] = set()
    paths: list[str] = []
    for element, matrix in iter_svg_paths(root):
        points = [apply_matrix(matrix, p) for p in parse_path_points(element.attrib.get("d", ""))]
        points = simplify_polyline(points, dedupe_precision, min_segment_length)
        if len(points) < 2:
            continue

        current: list[Point] = [points[0]]
        for a, b in zip(points, points[1:]):
            if math.dist(a, b) < min_segment_length:
                continue
            key = segment_key(a, b, dedupe_precision)
            if key in seen_segments:
                if len(current) > 1:
                    paths.append(polyline_path(current, precision))
                current = [b]
                continue
            seen_segments.add(key)
            if not current or point_key(current[-1], dedupe_precision) != point_key(a, dedupe_precision):
                if len(current) > 1:
                    paths.append(polyline_path(current, precision))
                current = [a]
            current.append(b)
        if len(current) > 1:
            paths.append(polyline_path(current, precision))
    return paths


def make_land_mask(
    image_path: Path,
    out_path: Path,
    *,
    land_threshold: int,
    alpha_threshold: int,
    invert: bool,
) -> None:
    source = Image.open(image_path).convert("RGBA")
    mask = Image.new("RGB", source.size, (255, 255, 255))
    src = source.load()
    dst = mask.load()
    for y in range(source.height):
        for x in range(source.width):
            r, g, b, a = src[x, y]
            dark = a >= alpha_threshold and (r + g + b) / 3 <= land_threshold
            land = not dark if invert and a >= alpha_threshold else dark
            if land:
                dst[x, y] = (0, 0, 0)
    mask.save(out_path)


def vectorize_mask(mask_path: Path, svg_path: Path, args: argparse.Namespace) -> None:
    vtracer.convert_image_to_svg_py(
        str(mask_path),
        str(svg_path),
        colormode=args.colormode,
        hierarchical=args.hierarchical,
        mode=args.mode,
        filter_speckle=args.filter_speckle,
        color_precision=args.color_precision,
        layer_difference=args.layer_difference,
        corner_threshold=args.corner_threshold,
        length_threshold=args.length_threshold,
        max_iterations=args.max_iterations,
        splice_threshold=args.splice_threshold,
        path_precision=args.path_precision,
    )


def closed_path_d(d: str) -> str:
    stripped = d.strip()
    if not stripped:
        return ""
    return stripped if stripped[-1] in "Zz" else stripped + "Z"


def coastline_paths(vtracer_svg_path: Path) -> list[str]:
    root = ET.parse(vtracer_svg_path).getroot()
    paths: list[str] = []
    for element, _matrix in iter_svg_paths(root):
        fill = element.attrib.get("fill", "").lower()
        if fill and fill not in ("#000", "#000000", "black", "rgb(0,0,0)"):
            continue
        d = closed_path_d(element.attrib.get("d", ""))
        transform = element.attrib.get("transform")
        if not d:
            continue
        if transform:
            paths.append(f'<path d="{html.escape(d)}" transform="{html.escape(transform)}"/>')
        else:
            paths.append(f'<path d="{html.escape(d)}"/>')
    return paths


def load_manifest(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.exists():
        return {"assets": []}
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def asset_by_map_path(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out = {}
    for asset in manifest.get("assets", []):
        map_path = asset.get("files", {}).get("map")
        if map_path:
            out[Path(map_path).name] = asset
    return out


def boundary_from_asset(asset: dict[str, Any] | None, width: int, height: int, precision: int) -> str:
    if asset and asset.get("polygon"):
        points = [(float(item["point"][0]), float(item["point"][1])) for item in asset["polygon"]]
    else:
        points = [(0.0, 0.0), (float(width), 0.0), (float(width), float(height)), (0.0, float(height))]
    return polyline_path(points, precision=precision, close=True)


def merged_svg(
    *,
    width: int,
    height: int,
    boundary_d: str,
    coast_paths: Sequence[str],
    graticule_paths: Sequence[str],
    args: argparse.Namespace,
) -> str:
    parts = [
        f'<svg xmlns="{SVG_NS}" viewBox="0 0 {width} {height}" width="{width}" height="{height}">',
        f'<g id="coastlines" fill="{args.land_fill}" stroke="{args.land_stroke}" '
        f'stroke-width="{args.land_stroke_width}" opacity="{args.land_opacity}">',
        *coast_paths,
        "</g>",
        f'<g id="graticule" fill="none" stroke="{args.graticule_stroke}" '
        f'stroke-width="{args.graticule_width}" opacity="{args.graticule_opacity}">',
    ]
    parts.extend(f'<path d="{d}"/>' for d in graticule_paths)
    parts.extend([
        "</g>",
        f'<g id="rhomb-boundary" fill="none" stroke="{args.boundary_stroke}" '
        f'stroke-width="{args.boundary_width}" opacity="{args.boundary_opacity}">',
        f'<path d="{boundary_d}"/>',
        "</g>",
        "</svg>",
    ])
    return "\n".join(parts) + "\n"


def output_name_for_map(map_path: Path) -> str:
    return map_path.name.replace("_map.png", ".svg")


def convert_tile(map_path: Path, asset: dict[str, Any] | None, out_dir: Path, args: argparse.Namespace) -> Path:
    graticule_path = map_path.with_name(map_path.name.replace("_map.png", "_graticule.svg"))
    out_path = out_dir / output_name_for_map(map_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    with Image.open(map_path) as image:
        width, height = image.size

    with tempfile.TemporaryDirectory(prefix="pentalunex_vector_") as tmp:
        tmp_dir = Path(tmp)
        mask_path = tmp_dir / "land_mask.png"
        traced_path = tmp_dir / "land.svg"
        make_land_mask(
            map_path,
            mask_path,
            land_threshold=args.land_threshold,
            alpha_threshold=args.alpha_threshold,
            invert=args.invert_land_mask,
        )
        vectorize_mask(mask_path, traced_path, args)
        coast = coastline_paths(traced_path)

    graticule = optimized_graticule_paths(
        graticule_path,
        precision=args.svg_precision,
        dedupe_precision=args.dedupe_precision,
        min_segment_length=args.min_segment_length,
    )
    boundary = boundary_from_asset(asset, width, height, args.svg_precision)
    out_path.write_text(
        merged_svg(
            width=width,
            height=height,
            boundary_d=boundary,
            coast_paths=coast,
            graticule_paths=graticule,
            args=args,
        ),
        encoding="utf-8",
    )
    return out_path


def write_vector_manifest(
    source_manifest: dict[str, Any],
    out_dir: Path,
    converted: Sequence[tuple[Path, Path]],
) -> None:
    manifest = dict(source_manifest)
    manifest["vectorized"] = {
        "kind": "vtracer_layered_svg_tiles",
        "tile_count": len(converted),
        "files": [
            {
                "source": str(source),
                "svg": str(svg.relative_to(out_dir.parent)),
            }
            for source, svg in converted
        ],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tiles-dir", type=Path, default=Path("export/tiles"))
    parser.add_argument("--manifest", type=Path, default=Path("export/manifest.json"))
    parser.add_argument("--out-dir", type=Path, default=Path("export/vector_tiles"))
    parser.add_argument("--glob", default="*_map.png")
    parser.add_argument("--limit", type=int, default=0)

    parser.add_argument("--land-threshold", type=int, default=128)
    parser.add_argument("--alpha-threshold", type=int, default=16)
    parser.add_argument("--invert-land-mask", action="store_true")

    parser.add_argument("--land-fill", default="#555555")
    parser.add_argument("--land-stroke", default="none")
    parser.add_argument("--land-stroke-width", default="0")
    parser.add_argument("--land-opacity", default="1")
    parser.add_argument("--graticule-stroke", default="#000000")
    parser.add_argument("--graticule-width", default="1")
    parser.add_argument("--graticule-opacity", default="0.35")
    parser.add_argument("--boundary-stroke", default="#000000")
    parser.add_argument("--boundary-width", default="1.5")
    parser.add_argument("--boundary-opacity", default="0.8")

    parser.add_argument("--svg-precision", type=int, default=2)
    parser.add_argument("--dedupe-precision", type=int, default=2)
    parser.add_argument("--min-segment-length", type=float, default=0.5)

    parser.add_argument("--colormode", default="binary")
    parser.add_argument("--hierarchical", default="stacked")
    parser.add_argument("--mode", default="spline")
    parser.add_argument("--filter-speckle", type=int, default=16)
    parser.add_argument("--color-precision", type=int, default=6)
    parser.add_argument("--layer-difference", type=int, default=16)
    parser.add_argument("--corner-threshold", type=int, default=60)
    parser.add_argument("--length-threshold", type=float, default=4.0)
    parser.add_argument("--max-iterations", type=int, default=10)
    parser.add_argument("--splice-threshold", type=int, default=45)
    parser.add_argument("--path-precision", type=int, default=2)
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    manifest = load_manifest(args.manifest)
    assets = asset_by_map_path(manifest)
    maps = sorted(args.tiles_dir.glob(args.glob))
    if args.limit:
        maps = maps[: args.limit]
    if not maps:
        raise SystemExit(f"no tiles matched {args.tiles_dir / args.glob}")

    converted: list[tuple[Path, Path]] = []
    for index, map_path in enumerate(maps, start=1):
        print(f"[{index}/{len(maps)}] vectorizing {map_path.name}")
        out_path = convert_tile(map_path, assets.get(map_path.name), args.out_dir, args)
        converted.append((map_path, out_path))

    write_vector_manifest(manifest, args.out_dir, converted)
    print(f"wrote {len(converted)} layered SVG tiles to {args.out_dir}")


if __name__ == "__main__":
    main()
