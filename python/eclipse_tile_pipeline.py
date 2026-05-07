#!/usr/bin/env python3
"""Generate and merge eclipse overlay SVGs for vectorized tile folders.

Typical flow:

    python3 python/eclipse_tile_pipeline.py overlay --saros 141:22
    python3 python/eclipse_tile_pipeline.py merge

The overlay command reads ``export/vector_tiles/manifest.json`` and writes a
sparse folder of SVGs only for tiles touched by the eclipse geometry. Each SVG
contains an eclipse polygon layer and an overlapping graticule-cell stroke
layer. The merge command combines those overlays with the corresponding base
vector tile SVGs.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import html
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qscsvg import ProjectionOffset, get_eclipse
from qscsvg.geometry import densify_lonlat_segment, oriented_lonlat_to_vec3, to_face_xyz
from vectorize_tiles import polyline_path


FACE_CLIP_EPS = 0.02
SVG_NS = "http://www.w3.org/2000/svg"


Point = tuple[float, float]


@dataclass(frozen=True)
class EclipseSpec:
    id: str
    label: str
    geometry: dict[str, Any]
    source: dict[str, Any]


@dataclass(frozen=True)
class TileTransform:
    face: int
    corner: int
    width: float
    height: float
    center: Point
    u_axis: Point
    v_axis: Point


@dataclass(frozen=True, order=True)
class GraticuleCell:
    face: int
    lon_idx: int
    lat_idx: int


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def projection_offset_from_manifest(manifest: dict[str, Any]) -> ProjectionOffset:
    data = manifest.get("projection_offset") or {}
    return ProjectionOffset(
        float(data.get("lon", 0.0)),
        float(data.get("lat", 0.0)),
        float(data.get("roll", 0.0)),
    )


def graticule_step_from_manifest(manifest: dict[str, Any]) -> float:
    data = manifest.get("graticule") or {}
    return float(data.get("step_deg", 30.0))


def geometry_from_eclipse(obj: dict[str, Any]) -> dict[str, Any]:
    if obj.get("type") == "Feature":
        return obj["geometry"]
    return obj.get("geometry", obj)


def load_eclipse_json(path: Path) -> list[EclipseSpec]:
    data = load_json(path)
    if isinstance(data, list):
        items = data
    elif data.get("type") == "FeatureCollection":
        items = data.get("features", [])
    else:
        items = [data]

    specs = []
    for index, item in enumerate(items):
        props = item.get("properties", {}) if isinstance(item, dict) else {}
        eclipse_id = str(props.get("id") or item.get("id") or f"{path.stem}_{index}")
        specs.append(EclipseSpec(
            id=safe_id(eclipse_id),
            label=str(props.get("label") or props.get("name") or eclipse_id),
            geometry=geometry_from_eclipse(item),
            source={"kind": "json", "path": str(path), "index": index},
        ))
    return specs


def parse_saros(value: str) -> EclipseSpec:
    if ":" not in value:
        raise ValueError("--saros values must look like 141:22")
    saros_text, pos_text = value.split(":", 1)
    saros = int(saros_text)
    position = int(pos_text)
    eclipse = get_eclipse(saros, position)
    eclipse_id = f"saros{saros}_pos{position}"
    label = f"Saros {saros} #{position}"
    if eclipse.get("datetime_utc"):
        label += f" {eclipse['datetime_utc']}"
    record = {key: val for key, val in eclipse.items() if key != "geometry"}
    return EclipseSpec(
        id=eclipse_id,
        label=label,
        geometry=eclipse["geometry"],
        source={"kind": "saros", "saros": saros, "position": position, "record": record},
    )


def safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", value).strip("_") or "eclipse"


def load_eclipses(args: argparse.Namespace) -> list[EclipseSpec]:
    eclipses: list[EclipseSpec] = []
    for item in args.saros or []:
        eclipses.append(parse_saros(item))
    for path in args.eclipse_json or []:
        eclipses.extend(load_eclipse_json(path))
    if not eclipses:
        raise SystemExit("provide at least one --saros SERIES:POSITION or --eclipse-json file")
    return eclipses


def polygon_rings(geometry: dict[str, Any]) -> Iterable[list[Sequence[Sequence[float]]]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        yield coords
    elif gtype == "MultiPolygon":
        yield from coords
    else:
        raise ValueError(f"expected Polygon or MultiPolygon, got {gtype!r}")


def densify_ring(ring: Sequence[Sequence[float]], max_step_deg: float) -> list[Point]:
    pts = [(float(p[0]), float(p[1])) for p in ring]
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    out: list[Point] = []
    for a, b in zip(pts, pts[1:]):
        segment = densify_lonlat_segment(a, b, max_step_deg=max_step_deg)
        if out:
            segment = segment[1:]
        out.extend(segment)
    return out


def interp_z(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float]:
    t = (FACE_CLIP_EPS - a[2]) / (b[2] - a[2])
    return (
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        FACE_CLIP_EPS,
    )


def clip_ring_z(ring: Sequence[Sequence[float]]) -> list[tuple[float, float, float]]:
    if not ring:
        return []
    out: list[tuple[float, float, float]] = []
    prev = ring[-1]
    prev_in = prev[2] >= FACE_CLIP_EPS
    for cur in ring:
        cur_in = cur[2] >= FACE_CLIP_EPS
        if cur_in:
            if not prev_in:
                out.append(interp_z(prev, cur))
            out.append((cur[0], cur[1], cur[2]))
        elif prev_in:
            out.append(interp_z(prev, cur))
        prev = cur
        prev_in = cur_in
    return out


def project_lonlat_ring_to_face(
    face: int,
    ring: Sequence[Sequence[float]],
    *,
    offset: ProjectionOffset,
    max_step_deg: float,
) -> list[Point]:
    ring3 = [
        to_face_xyz(face, oriented_lonlat_to_vec3(lon, lat, offset))
        for lon, lat in densify_ring(ring, max_step_deg)
    ]
    projected = []
    for p in clip_ring_z(ring3):
        x = p[0] / p[2]
        y = p[1] / p[2]
        if math.isfinite(x) and math.isfinite(y):
            projected.append((x, y))
    return projected


def clip_against_edge(points: Sequence[Point], inside, intersect) -> list[Point]:
    if not points:
        return []
    output: list[Point] = []
    prev = points[-1]
    prev_inside = inside(prev)
    for curr in points:
        curr_inside = inside(curr)
        if curr_inside:
            if not prev_inside:
                output.append(intersect(prev, curr))
            output.append(curr)
        elif prev_inside:
            output.append(intersect(prev, curr))
        prev = curr
        prev_inside = curr_inside
    return output


def clip_polygon_to_face(points: Sequence[Point]) -> list[Point]:
    clipped = list(points)
    clipped = clip_against_edge(
        clipped,
        lambda p: p[0] >= -1.0,
        lambda a, b: (-1.0, a[1] + (b[1] - a[1]) * ((-1.0 - a[0]) / (b[0] - a[0]))),
    )
    clipped = clip_against_edge(
        clipped,
        lambda p: p[0] <= 1.0,
        lambda a, b: (1.0, a[1] + (b[1] - a[1]) * ((1.0 - a[0]) / (b[0] - a[0]))),
    )
    clipped = clip_against_edge(
        clipped,
        lambda p: p[1] >= -1.0,
        lambda a, b: (a[0] + (b[0] - a[0]) * ((-1.0 - a[1]) / (b[1] - a[1])), -1.0),
    )
    clipped = clip_against_edge(
        clipped,
        lambda p: p[1] <= 1.0,
        lambda a, b: (a[0] + (b[0] - a[0]) * ((1.0 - a[1]) / (b[1] - a[1])), 1.0),
    )
    return clipped


def face_polygons(
    geometry: dict[str, Any],
    face: int,
    *,
    offset: ProjectionOffset,
    max_step_deg: float,
) -> list[list[Point]]:
    polygons = []
    for rings in polygon_rings(geometry):
        if not rings:
            continue
        # Eclipse polygons are simple bands in this project; holes are rare and
        # ignored here to keep the overlay path independent from Shapely.
        projected = project_lonlat_ring_to_face(face, rings[0], offset=offset, max_step_deg=max_step_deg)
        clipped = clip_polygon_to_face(projected)
        if len(clipped) >= 3:
            polygons.append(clipped)
    return polygons


def point_in_polygon(point: Point, poly: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    j = len(poly) - 1
    for i, pi in enumerate(poly):
        pj = poly[j]
        denom = pj[1] - pi[1]
        if ((pi[1] > y) != (pj[1] > y)) and abs(denom) > 1e-12:
            x_intersect = (pj[0] - pi[0]) * (y - pi[1]) / denom + pi[0]
            if x < x_intersect:
                inside = not inside
        j = i
    return inside


def orient(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(a: Point, b: Point, c: Point) -> bool:
    return (
        min(a[0], b[0]) - 1e-9 <= c[0] <= max(a[0], b[0]) + 1e-9
        and min(a[1], b[1]) - 1e-9 <= c[1] <= max(a[1], b[1]) + 1e-9
        and abs(orient(a, b, c)) <= 1e-9
    )


def segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool:
    o1 = orient(a, b, c)
    o2 = orient(a, b, d)
    o3 = orient(c, d, a)
    o4 = orient(c, d, b)
    if o1 * o2 < 0 and o3 * o4 < 0:
        return True
    return on_segment(a, b, c) or on_segment(a, b, d) or on_segment(c, d, a) or on_segment(c, d, b)


def polygons_overlap(a: Sequence[Point], b: Sequence[Point]) -> bool:
    if any(point_in_polygon(p, b) for p in a):
        return True
    if any(point_in_polygon(p, a) for p in b):
        return True
    for p0, p1 in zip(a, list(a[1:]) + [a[0]]):
        for q0, q1 in zip(b, list(b[1:]) + [b[0]]):
            if segments_intersect(p0, p1, q0, q1):
                return True
    return False


def graticule_cell_index(lon: float, lat: float, step: float) -> tuple[int, int]:
    lon_count = max(1, int(math.ceil(360.0 / step)))
    lat_count = max(1, int(math.ceil(180.0 / step)))
    lon_idx = math.floor((lon + 180.0) / step)
    lat_idx = math.floor((lat + 90.0) / step)
    return (
        max(0, min(lon_count - 1, lon_idx)),
        max(0, min(lat_count - 1, lat_idx)),
    )


def graticule_cell_lonlat_ring(lon_idx: int, lat_idx: int, step: float) -> list[Point]:
    lon0 = -180.0 + lon_idx * step
    lon1 = lon0 + step
    lat0 = -90.0 + lat_idx * step
    lat1 = lat0 + step
    ring: list[Point] = []

    for i in range(11):
        lon = lon0 + (lon1 - lon0) * i / 10.0
        ring.append((lon, lat0))
    for i in range(1, 11):
        lat = lat0 + (lat1 - lat0) * i / 10.0
        ring.append((lon1, lat))
    for i in range(9, -1, -1):
        lon = lon0 + (lon1 - lon0) * i / 10.0
        ring.append((lon, lat1))
    for i in range(9, 0, -1):
        lat = lat0 + (lat1 - lat0) * i / 10.0
        ring.append((lon0, lat))
    return ring


def graticule_cell_face_xy(
    face: int,
    lon_idx: int,
    lat_idx: int,
    step: float,
    *,
    offset: ProjectionOffset,
) -> list[Point]:
    ring = graticule_cell_lonlat_ring(lon_idx, lat_idx, step)
    projected = project_lonlat_ring_to_face(
        face,
        ring,
        offset=offset,
        max_step_deg=step / 10.0,
    )
    return clip_polygon_to_face(projected)


def overlapping_cells(
    face: int,
    polygons: Sequence[Sequence[Point]],
    *,
    step: float,
    offset: ProjectionOffset,
) -> list[GraticuleCell]:
    hits = []
    lon_count = max(1, int(math.ceil(360.0 / step)))
    lat_count = max(1, int(math.ceil(180.0 / step)))
    for lon_idx in range(lon_count):
        for lat_idx in range(lat_count):
            ring = graticule_cell_face_xy(face, lon_idx, lat_idx, step, offset=offset)
            if len(ring) >= 3 and any(polygons_overlap(ring, poly) for poly in polygons):
                hits.append(GraticuleCell(face, lon_idx, lat_idx))
    return hits


def boundary_cells_from_lonlat(
    geometry: dict[str, Any],
    *,
    offset: ProjectionOffset,
    allowed: set[GraticuleCell],
    max_step_deg: float,
    step: float,
    face: int,
) -> list[GraticuleCell]:
    hits: list[GraticuleCell] = []
    seen: set[GraticuleCell] = set()
    for rings in polygon_rings(geometry):
        if not rings:
            continue
        for lon, lat in densify_ring(rings[0], max_step_deg):
            lon_idx, lat_idx = graticule_cell_index(lon, lat, step)
            cell = GraticuleCell(face, lon_idx, lat_idx)
            if cell in allowed and cell not in seen:
                seen.add(cell)
                hits.append(cell)
    return hits


def tile_transform(asset: dict[str, Any]) -> TileTransform:
    face = int(asset["face"])
    corner = int(asset["corner"])
    width = float(asset["image"]["width"])
    height = float(asset["image"]["height"])
    points_by_name = {
        item["name"]: (float(item["point"][0]), float(item["point"][1]))
        for item in asset.get("polygon", [])
    }
    try:
        top_left = points_by_name["top_left"]
        top_right = points_by_name["top_right"]
        bottom_right = points_by_name["bottom_right"]
        bottom_left = points_by_name["bottom_left"]
    except KeyError as exc:
        raise ValueError(f"asset {asset.get('id', '<unknown>')} is missing polygon corner {exc}") from exc

    center = (
        (top_left[0] + top_right[0] + bottom_right[0] + bottom_left[0]) / 4.0,
        (top_left[1] + top_right[1] + bottom_right[1] + bottom_left[1]) / 4.0,
    )
    u_axis = ((top_right[0] - top_left[0]) / 2.0, (top_right[1] - top_left[1]) / 2.0)
    v_axis = ((top_left[0] - bottom_left[0]) / 2.0, (top_left[1] - bottom_left[1]) / 2.0)
    return TileTransform(face, corner, width, height, center, u_axis, v_axis)


def face_xy_to_tile(point: Point, transform: TileTransform) -> Point:
    x, y = point
    return (
        transform.center[0] + transform.u_axis[0] * x + transform.v_axis[0] * y,
        transform.center[1] + transform.u_axis[1] * x + transform.v_axis[1] * y,
    )


def polygon_to_tile_path(poly: Sequence[Point], transform: TileTransform, precision: int) -> str:
    return polyline_path([face_xy_to_tile(p, transform) for p in poly], precision=precision, close=True)


def cell_to_tile_path(
    cell: GraticuleCell,
    transform: TileTransform,
    *,
    offset: ProjectionOffset,
    step: float,
    precision: int,
) -> str:
    ring = graticule_cell_face_xy(
        cell.face,
        cell.lon_idx,
        cell.lat_idx,
        step,
        offset=offset,
    )
    return polyline_path(
        [face_xy_to_tile(p, transform) for p in ring],
        precision=precision,
        close=True,
    )


def cell_key(cell: GraticuleCell) -> str:
    return f"{cell.face}:{cell.lon_idx}:{cell.lat_idx}"


def overlay_svg(
    *,
    width: int,
    height: int,
    path_groups: Sequence[str],
    cell_paths: Sequence[str],
    args: argparse.Namespace,
) -> str:
    parts = [
        f'<svg xmlns="{SVG_NS}" viewBox="0 0 {width} {height}" width="{width}" height="{height}">',
        '<g id="eclipse-paths">',
        *path_groups,
        "</g>",
        f'<g id="eclipse-cells" fill="none" stroke="{args.cell_stroke}" '
        f'stroke-width="{args.cell_stroke_width}" opacity="{args.cell_opacity}">',
        *cell_paths,
        "</g>",
        "</svg>",
    ]
    return "\n".join(parts) + "\n"


def asset_svg_name(asset: dict[str, Any]) -> str:
    return f"iso_corner{asset['corner']}_face{asset['face']}.svg"


def generate_overlays(args: argparse.Namespace) -> None:
    manifest_path = args.tiles_dir / "manifest.json"
    manifest = load_json(manifest_path)
    offset = projection_offset_from_manifest(manifest)
    graticule_step = graticule_step_from_manifest(manifest)
    eclipses = load_eclipses(args)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    overlay_assets = []
    for asset in manifest.get("assets", []):
        transform = tile_transform(asset)
        path_groups: list[str] = []
        all_cell_paths: list[str] = []
        eclipse_hits = []

        for eclipse in eclipses:
            polys = face_polygons(
                eclipse.geometry,
                transform.face,
                offset=offset,
                max_step_deg=args.max_step_deg,
            )
            if not polys:
                continue

            cells = overlapping_cells(
                transform.face,
                polys,
                step=graticule_step,
                offset=offset,
            )
            allowed = set(cells)
            ordered = boundary_cells_from_lonlat(
                eclipse.geometry,
                offset=offset,
                allowed=allowed,
                max_step_deg=max(args.max_step_deg, 1.0),
                step=graticule_step,
                face=transform.face,
            )
            ordered.extend(cell for cell in cells if cell not in set(ordered))
            if not ordered and not polys:
                continue

            d_paths = [polygon_to_tile_path(poly, transform, args.svg_precision) for poly in polys]
            path_groups.append(
                f'<g id="{html.escape(eclipse.id)}" fill="{args.eclipse_fill}" '
                f'stroke="{args.eclipse_stroke}" stroke-width="{args.eclipse_stroke_width}" '
                f'opacity="{args.eclipse_opacity}">'
                + "".join(f'<path d="{d}" fill-rule="evenodd"/>' for d in d_paths if d)
                + "</g>"
            )
            for cell in ordered:
                all_cell_paths.append(
                    f'<path data-eclipse="{html.escape(eclipse.id)}" data-cell="{cell_key(cell)}" '
                    f'd="{cell_to_tile_path(cell, transform, offset=offset, step=graticule_step, precision=args.svg_precision)}"/>'
                )
            eclipse_hits.append({
                "id": eclipse.id,
                "label": eclipse.label,
                "polygon_count": len(polys),
                "cell_count": len(ordered),
                "cells": [cell_key(cell) for cell in ordered],
            })

        if not path_groups and not all_cell_paths:
            continue

        svg_name = asset_svg_name(asset)
        out_path = args.out_dir / svg_name
        out_path.write_text(
            overlay_svg(
                width=int(round(transform.width)),
                height=int(round(transform.height)),
                path_groups=path_groups,
                cell_paths=all_cell_paths,
                args=args,
            ),
            encoding="utf-8",
        )
        overlay_assets.append({
            "id": asset["id"],
            "corner": asset["corner"],
            "face": asset["face"],
            "base_svg": svg_name,
            "overlay_svg": svg_name,
            "image": asset["image"],
            "eclipses": eclipse_hits,
        })

    overlay_manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kind": "eclipse_tile_overlays",
        "source_tiles": str(args.tiles_dir),
        "projection_offset": {"lon": offset.lon, "lat": offset.lat, "roll": offset.roll},
        "coordinate_system": {
            "tile_mapping": "manifest polygon affine",
            "cell_system": "lonlat graticule",
            "cell_key": "face:lonIdx:latIdx",
            "step_deg": graticule_step,
            "face_clip_eps": FACE_CLIP_EPS,
        },
        "eclipses": [
            {
                "id": eclipse.id,
                "label": eclipse.label,
                "source": eclipse.source,
            }
            for eclipse in eclipses
        ],
        "style": {
            "eclipse_fill": args.eclipse_fill,
            "eclipse_stroke": args.eclipse_stroke,
            "cell_stroke": args.cell_stroke,
        },
        "asset_count": len(overlay_assets),
        "assets": overlay_assets,
    }
    write_json(args.out_dir / "manifest.json", overlay_manifest)
    print(f"wrote {len(overlay_assets)} eclipse overlay SVGs to {args.out_dir}")


def svg_inner(svg: str) -> str:
    match = re.search(r"<svg\b[^>]*>(.*)</svg>\s*$", svg, flags=re.S)
    return match.group(1).strip() if match else svg


def svg_open_tag(svg: str) -> str:
    match = re.search(r"(<svg\b[^>]*>)", svg, flags=re.S)
    if not match:
        raise ValueError("missing <svg> root")
    return match.group(1)


def merge_folders(args: argparse.Namespace) -> None:
    base_manifest = load_json(args.base_dir / "manifest.json")
    overlay_manifest = load_json(args.overlay_dir / "manifest.json")
    args.out_dir.mkdir(parents=True, exist_ok=True)

    merged_assets = []
    for overlay_asset in overlay_manifest.get("assets", []):
        svg_name = overlay_asset["overlay_svg"]
        base_path = args.base_dir / svg_name
        overlay_path = args.overlay_dir / svg_name
        if not base_path.exists() or not overlay_path.exists():
            continue
        base_svg = base_path.read_text(encoding="utf-8")
        overlay_svg_text = overlay_path.read_text(encoding="utf-8")
        merged_svg = (
            svg_open_tag(base_svg)
            + "\n"
            + svg_inner(base_svg)
            + "\n"
            + svg_inner(overlay_svg_text)
            + "\n</svg>\n"
        )
        (args.out_dir / svg_name).write_text(merged_svg, encoding="utf-8")
        merged_assets.append({
            **overlay_asset,
            "merged_svg": svg_name,
        })

    merged_manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kind": "merged_vector_eclipse_tiles",
        "base_tiles": str(args.base_dir),
        "overlay_tiles": str(args.overlay_dir),
        "source_projection_offset": base_manifest.get("projection_offset"),
        "coordinate_system": overlay_manifest.get("coordinate_system"),
        "eclipses": overlay_manifest.get("eclipses", []),
        "asset_count": len(merged_assets),
        "assets": merged_assets,
    }
    write_json(args.out_dir / "manifest.json", merged_manifest)
    print(f"wrote {len(merged_assets)} merged SVGs to {args.out_dir}")


def add_overlay_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--tiles-dir", type=Path, default=Path("export/vector_tiles"))
    parser.add_argument("--out-dir", type=Path, default=Path("export/eclipse_tiles"))
    parser.add_argument("--saros", action="append", default=[])
    parser.add_argument("--eclipse-json", type=Path, action="append", default=[])
    parser.add_argument("--max-step-deg", type=float, default=0.5)
    parser.add_argument("--svg-precision", type=int, default=2)
    parser.add_argument("--eclipse-fill", default="#ff5a6d44")
    parser.add_argument("--eclipse-stroke", default="#ff5a6d")
    parser.add_argument("--eclipse-stroke-width", default="2")
    parser.add_argument("--eclipse-opacity", default="1")
    parser.add_argument("--cell-stroke", default="#111111")
    parser.add_argument("--cell-stroke-width", default="2")
    parser.add_argument("--cell-opacity", default="0.75")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    overlay = sub.add_parser("overlay", help="generate sparse eclipse overlay SVGs")
    add_overlay_args(overlay)
    merge = sub.add_parser("merge", help="merge vector tiles with eclipse overlays")
    merge.add_argument("--base-dir", type=Path, default=Path("export/vector_tiles"))
    merge.add_argument("--overlay-dir", type=Path, default=Path("export/eclipse_tiles"))
    merge.add_argument("--out-dir", type=Path, default=Path("export/merged_eclipse_tiles"))
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "overlay":
        generate_overlays(args)
    elif args.command == "merge":
        merge_folders(args)


if __name__ == "__main__":
    main()
