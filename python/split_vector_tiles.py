#!/usr/bin/env python3
"""Split rhombic vector tiles into triangular half-face shards."""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from typing import Any, Sequence

from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon

from qscsvg.svg import _face_local_to_world


SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
COMMAND_RE = re.compile(r"[MmLlHhVvCcQqZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
CURVE_STEPS = 16

FACE_VERTEX_LOCAL = (
    (-1.0, 1.0),
    (1.0, 1.0),
    (1.0, -1.0),
    (-1.0, -1.0),
)
FACE_EDGE_BY_VERTICES = {
    (0, 1): "top",
    (1, 2): "right",
    (2, 3): "bottom",
    (3, 0): "left",
}


def qname(name: str) -> str:
    return f"{{{SVG_NS}}}{name}"


def rounded(value: float, digits: int = 3) -> float:
    return round(float(value), digits)


def point_meta(point: Sequence[float]) -> list[float]:
    return [rounded(point[0]), rounded(point[1])]


def vector_meta(point: Sequence[float]) -> list[float]:
    return [rounded(point[0]), rounded(point[1]), rounded(point[2])]


def edge_meta(a: Sequence[float], b: Sequence[float]) -> dict[str, Any]:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    return {
        "from": point_meta(a),
        "to": point_meta(b),
        "vector": point_meta((dx, dy)),
        "midpoint": point_meta(((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)),
        "length": rounded(math.hypot(dx, dy)),
        "angle_deg": rounded(math.degrees(math.atan2(dy, dx))),
    }


def point_key(point: Sequence[float]) -> str:
    return ",".join(f"{v:.3f}" for v in point)


def edge_key(a: Sequence[float], b: Sequence[float]) -> str:
    return "|".join(sorted((point_key(a), point_key(b))))


def polygon_points(asset: dict[str, Any]) -> list[list[float]]:
    return [[float(v["point"][0]), float(v["point"][1])] for v in asset["polygon"]]


def short_diagonal(points: Sequence[Sequence[float]]) -> tuple[int, int]:
    side = math.dist(points[0], points[1])
    d02 = math.dist(points[0], points[2])
    d13 = math.dist(points[1], points[3])
    return (0, 2) if abs(d02 - side) <= abs(d13 - side) else (1, 3)


def triangle_specs(diagonal: tuple[int, int]) -> list[tuple[str, list[int]]]:
    if diagonal == (0, 2):
        return [("tri0", [0, 1, 2]), ("tri1", [2, 3, 0])]
    if diagonal == (1, 3):
        return [("tri0", [1, 2, 3]), ("tri1", [3, 0, 1])]
    raise ValueError(f"unsupported split diagonal {diagonal}")


def edge_name_for_vertices(a: int, b: int) -> str:
    return FACE_EDGE_BY_VERTICES.get((a, b), "split")


def asset_svg_path(asset: dict[str, Any], source_dir: Path) -> Path:
    svg_file = asset.get("files", {}).get("svg")
    if svg_file:
        return source_dir / svg_file
    candidates = [
        source_dir / f"iso_{asset['id']}.svg",
        source_dir.parent / "old_vector_tiles" / f"iso_{asset['id']}.svg",
        source_dir / f"iso_{asset['id']}_tri0.svg",
        source_dir / f"iso_{asset['id']}_tri1.svg",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def parse_translate(value: str | None) -> tuple[float, float]:
    if not value:
        return (0.0, 0.0)
    match = re.search(r"translate\(\s*([-+0-9.eE]+)(?:[,\s]+([-+0-9.eE]+))?\s*\)", value)
    if not match:
        return (0.0, 0.0)
    return (float(match.group(1)), float(match.group(2) or 0.0))


def add_point(p: tuple[float, float], offset: tuple[float, float]) -> tuple[float, float]:
    return (p[0] + offset[0], p[1] + offset[1])


def cubic_point(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    u = 1.0 - t
    return (
        u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1],
    )


def quad_point(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    t: float,
) -> tuple[float, float]:
    u = 1.0 - t
    return (
        u**2 * p0[0] + 2 * u * t * p1[0] + t**2 * p2[0],
        u**2 * p0[1] + 2 * u * t * p1[1] + t**2 * p2[1],
    )


def path_subpaths(d: str, offset: tuple[float, float]) -> list[tuple[list[tuple[float, float]], bool]]:
    tokens = COMMAND_RE.findall(d)
    subpaths: list[tuple[list[tuple[float, float]], bool]] = []
    current: tuple[float, float] = (0.0, 0.0)
    start: tuple[float, float] = (0.0, 0.0)
    points: list[tuple[float, float]] = []
    closed = False
    index = 0
    command = ""

    def is_command(token: str) -> bool:
        return len(token) == 1 and token.isalpha()

    def read_float() -> float:
        nonlocal index
        value = float(tokens[index])
        index += 1
        return value

    def finish() -> None:
        nonlocal points, closed
        if len(points) >= 2:
            subpaths.append((points, closed))
        points = []
        closed = False

    while index < len(tokens):
        if is_command(tokens[index]):
            command = tokens[index]
            index += 1
        if not command:
            break

        relative = command.islower()
        op = command.upper()
        if op == "M":
            first = True
            while index + 1 < len(tokens) and not is_command(tokens[index]):
                x, y = read_float(), read_float()
                if relative:
                    x += current[0]
                    y += current[1]
                current = (x, y)
                if first:
                    finish()
                    start = current
                    points = [add_point(current, offset)]
                    first = False
                else:
                    points.append(add_point(current, offset))
            command = "l" if relative else "L"
        elif op == "L":
            while index + 1 < len(tokens) and not is_command(tokens[index]):
                x, y = read_float(), read_float()
                if relative:
                    x += current[0]
                    y += current[1]
                current = (x, y)
                points.append(add_point(current, offset))
        elif op == "H":
            while index < len(tokens) and not is_command(tokens[index]):
                x = read_float()
                if relative:
                    x += current[0]
                current = (x, current[1])
                points.append(add_point(current, offset))
        elif op == "V":
            while index < len(tokens) and not is_command(tokens[index]):
                y = read_float()
                if relative:
                    y += current[1]
                current = (current[0], y)
                points.append(add_point(current, offset))
        elif op == "C":
            while index + 5 < len(tokens) and not is_command(tokens[index]):
                vals = [read_float() for _ in range(6)]
                p1 = (vals[0], vals[1])
                p2 = (vals[2], vals[3])
                p3 = (vals[4], vals[5])
                if relative:
                    p1 = (p1[0] + current[0], p1[1] + current[1])
                    p2 = (p2[0] + current[0], p2[1] + current[1])
                    p3 = (p3[0] + current[0], p3[1] + current[1])
                p0 = current
                for step in range(1, CURVE_STEPS + 1):
                    points.append(add_point(cubic_point(p0, p1, p2, p3, step / CURVE_STEPS), offset))
                current = p3
        elif op == "Q":
            while index + 3 < len(tokens) and not is_command(tokens[index]):
                vals = [read_float() for _ in range(4)]
                p1 = (vals[0], vals[1])
                p2 = (vals[2], vals[3])
                if relative:
                    p1 = (p1[0] + current[0], p1[1] + current[1])
                    p2 = (p2[0] + current[0], p2[1] + current[1])
                p0 = current
                for step in range(1, CURVE_STEPS + 1):
                    points.append(add_point(quad_point(p0, p1, p2, step / CURVE_STEPS), offset))
                current = p2
        elif op == "Z":
            if points and points[-1] != add_point(start, offset):
                points.append(add_point(start, offset))
            current = start
            closed = True
            finish()
        else:
            break
    finish()
    return subpaths


def path_from_ring(points: Sequence[Sequence[float]], close: bool) -> str:
    if not points:
        return ""
    command = "M" + "L".join(f"{rounded(x)},{rounded(y)}" for x, y in points)
    return command + ("Z" if close else "")


def iter_polygons(geom):
    if geom.is_empty:
        return
    if isinstance(geom, Polygon):
        yield geom
    elif isinstance(geom, MultiPolygon):
        yield from geom.geoms
    elif hasattr(geom, "geoms"):
        for item in geom.geoms:
            yield from iter_polygons(item)


def iter_lines(geom):
    if geom.is_empty:
        return
    if isinstance(geom, LineString):
        yield geom
    elif isinstance(geom, MultiLineString):
        yield from geom.geoms
    elif hasattr(geom, "geoms"):
        for item in geom.geoms:
            yield from iter_lines(item)


def inherited_attr(attrs: dict[str, str], name: str, default: str = "") -> str:
    value = attrs.get(name)
    return default if value is None else value


def collect_clipped_paths(
    element: ET.Element,
    *,
    triangle: Polygon,
    parent_attrs: dict[str, str],
    parent_offset: tuple[float, float],
    out_root: ET.Element,
) -> None:
    tag = element.tag.split("}")[-1]
    if tag in {"defs", "clipPath"}:
        return
    if element.attrib.get("id") in {"rhomb-boundary", "triangle-boundary"}:
        return

    attrs = dict(parent_attrs)
    for name in ("fill", "stroke", "stroke-width", "opacity", "fill-rule", "stroke-linecap", "stroke-linejoin"):
        if name in element.attrib:
            attrs[name] = element.attrib[name]
    tx, ty = parse_translate(element.attrib.get("transform"))
    offset = (parent_offset[0] + tx, parent_offset[1] + ty)

    if tag == "path" and element.attrib.get("d"):
        fill = inherited_attr(attrs, "fill", "none")
        stroke = inherited_attr(attrs, "stroke", "none")
        stroke_width = inherited_attr(attrs, "stroke-width", "1")
        opacity = inherited_attr(attrs, "opacity", "1")
        for points, closed in path_subpaths(element.attrib["d"], offset):
            if len(points) < 2:
                continue
            if closed and fill != "none" and len(points) >= 4:
                poly = Polygon(points)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                clipped = poly.intersection(triangle)
                for part in iter_polygons(clipped):
                    exterior = list(part.exterior.coords)
                    if len(exterior) < 4:
                        continue
                    ET.SubElement(
                        out_root,
                        qname("path"),
                        {
                            "d": path_from_ring(exterior, True),
                            "fill": fill,
                            "stroke": stroke,
                            "stroke-width": stroke_width,
                            "opacity": opacity,
                        },
                    )
            elif stroke != "none":
                clipped = LineString(points).intersection(triangle)
                for line in iter_lines(clipped):
                    coords = list(line.coords)
                    if len(coords) < 2:
                        continue
                    ET.SubElement(
                        out_root,
                        qname("path"),
                        {
                            "d": path_from_ring(coords, False),
                            "fill": "none",
                            "stroke": stroke,
                            "stroke-width": stroke_width,
                            "opacity": opacity,
                        },
                    )

    for child in list(element):
        collect_clipped_paths(
            child,
            triangle=triangle,
            parent_attrs=attrs,
            parent_offset=offset,
            out_root=out_root,
        )


def write_triangle_svg(
    *,
    source_root: ET.Element,
    out_svg: Path,
    points: Sequence[Sequence[float]],
) -> None:
    attrs = dict(source_root.attrib)
    root = ET.Element(qname("svg"), attrs)
    triangle = Polygon(points)
    content = ET.SubElement(root, qname("g"), {"id": "triangle-content"})
    collect_clipped_paths(
        source_root,
        triangle=triangle,
        parent_attrs={},
        parent_offset=(0.0, 0.0),
        out_root=content,
    )

    boundary = ET.SubElement(
        root,
        qname("g"),
        {
            "id": "triangle-boundary",
            "fill": "none",
            "stroke": "#000000",
            "stroke-width": "1.5",
            "opacity": "0.8",
        },
    )
    d = "M" + "L".join(f"{rounded(x)},{rounded(y)}" for x, y in points) + "Z"
    ET.SubElement(boundary, qname("path"), {"d": d})

    out_svg.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(out_svg, encoding="utf-8", xml_declaration=False)


def build_shard_asset(
    source_asset: dict[str, Any],
    shard_name: str,
    vertices: Sequence[int],
    all_points: Sequence[Sequence[float]],
    out_svg_name: str,
) -> dict[str, Any]:
    asset = deepcopy(source_asset)
    source_id = source_asset["id"]
    shard_id = f"{source_id}_{shard_name}"
    asset["id"] = shard_id
    asset["source"] = source_id
    asset["shard"] = {
        "kind": "half_face",
        "source_asset": source_id,
        "id": shard_name,
        "split_edge": "split",
    }
    asset["variant"] = "normal"
    asset.pop("variants", None)
    asset["files"] = {**source_asset.get("files", {}), "svg": out_svg_name}

    triangle = [all_points[index] for index in vertices]
    asset["polygon"] = [
        {
            "name": source_asset["polygon"][index]["name"],
            "source_vertex": index,
            "point": point_meta(point),
        }
        for index, point in zip(vertices, triangle)
    ]

    edge_order: list[str] = []
    edges: dict[str, Any] = {}
    indexed_edges: list[dict[str, Any]] = []
    face = int(source_asset["face"])
    for index, (va, vb) in enumerate(zip(vertices, [*vertices[1:], vertices[0]])):
        name = edge_name_for_vertices(va, vb)
        edge_order.append(name)
        if name == "split":
            local_from = FACE_VERTEX_LOCAL[va]
            local_to = FACE_VERTEX_LOCAL[vb]
            world_from = _face_local_to_world(face, local_from[0], local_from[1])
            world_to = _face_local_to_world(face, local_to[0], local_to[1])
            edge = {
                "index": index,
                "edgeKey": f"split:{source_id}:{edge_key(world_from, world_to)}",
                "worldFrom": vector_meta(world_from),
                "worldTo": vector_meta(world_to),
                "image": edge_meta(all_points[va], all_points[vb]),
                "kind": "split",
            }
        else:
            edge = deepcopy(source_asset["edges"][name])
            edge["index"] = index
            edge["kind"] = "face"
            edge["image"] = edge_meta(all_points[va], all_points[vb])
        edges[name] = edge
        indexed_edges.append({"index": index, "semantic_edge": name, **edge})

    asset["primary_edge"] = edge_order[0]
    asset["edge_order"] = edge_order
    asset["edges"] = edges
    asset["indexed_edges"] = indexed_edges
    return asset


def add_bond(
    bonds: list[dict[str, Any]],
    *,
    bond_type: str,
    from_asset: dict[str, Any],
    from_edge: str,
    to_asset: dict[str, Any],
    to_edge: str,
    orientation: str,
    placement: str,
) -> None:
    bonds.append(
        {
            "type": bond_type,
            "from": {
                "asset": from_asset["id"],
                "face": from_asset["face"],
                "edge": from_edge,
                "shard": from_asset.get("shard", {}).get("id"),
            },
            "to": {
                "asset": to_asset["id"],
                "face": to_asset["face"],
                "edge": to_edge,
                "shard": to_asset.get("shard", {}).get("id"),
            },
            "edgeKey": from_asset["edges"][from_edge]["edgeKey"],
            "orientation": orientation,
            "placement": placement,
        }
    )


def build_topology(
    source_manifest: dict[str, Any],
    shard_assets: Sequence[dict[str, Any]],
    pair_by_asset: dict[str, str],
) -> dict[str, Any]:
    by_face_edge: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for asset in shard_assets:
        for edge in asset["edge_order"]:
            if edge == "split":
                continue
            by_face_edge.setdefault((int(asset["face"]), edge), []).append(asset)

    source_natural = source_manifest["topology"]["bonds"].get("natural", [])
    natural_by_face_edge: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for bond in source_natural:
        key = (int(bond["from"]["face"]), bond["from"]["edge"])
        natural_by_face_edge.setdefault(key, []).append(bond)

    shard_by_id = {asset["id"]: asset for asset in shard_assets}
    natural: list[dict[str, Any]] = []
    mirror: list[dict[str, Any]] = []

    for asset in shard_assets:
        for edge in asset["edge_order"]:
            if edge == "split":
                pair = shard_by_id[pair_by_asset[asset["id"]]]
                add_bond(
                    natural,
                    bond_type="natural",
                    from_asset=asset,
                    from_edge=edge,
                    to_asset=pair,
                    to_edge="split",
                    orientation="reversed",
                    placement="rotate_translate",
                )
                add_bond(
                    mirror,
                    bond_type="mirror",
                    from_asset=asset,
                    from_edge=edge,
                    to_asset=asset,
                    to_edge=edge,
                    orientation="same",
                    placement="reflect_across_edge",
                )
                continue

            for source_bond in natural_by_face_edge.get((int(asset["face"]), edge), []):
                to_face = int(source_bond["to"]["face"])
                to_edge = source_bond["to"]["edge"]
                for target in by_face_edge.get((to_face, to_edge), []):
                    add_bond(
                        natural,
                        bond_type="natural",
                        from_asset=asset,
                        from_edge=edge,
                        to_asset=target,
                        to_edge=to_edge,
                        orientation="reversed",
                        placement="rotate_translate",
                    )

            for target in by_face_edge.get((int(asset["face"]), edge), []):
                add_bond(
                    mirror,
                    bond_type="mirror",
                    from_asset=asset,
                    from_edge=edge,
                    to_asset=target,
                    to_edge=edge,
                    orientation="same",
                    placement="reflect_across_edge",
                )

    topology = deepcopy(source_manifest["topology"])
    topology["edge_order"] = ["top", "right", "bottom", "left", "split"]
    topology["shard_edge_count"] = 3
    topology["bonds"] = {"natural": natural, "mirror": mirror}
    return topology


def split_manifest(source_dir: Path, out_dir: Path) -> None:
    source_manifest_path = source_dir / "manifest.json"
    manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    backup_manifest_path = source_dir / "manifest.rhomb_source.json"
    if manifest.get("export", {}).get("kind") == "triangular_half_face_vector_tiles":
        if not backup_manifest_path.exists():
            raise SystemExit(
                f"{source_manifest_path} is already triangular and no rhomb source backup exists"
            )
        manifest = json.loads(backup_manifest_path.read_text(encoding="utf-8"))
    assets: list[dict[str, Any]] = []
    pair_by_asset: dict[str, str] = {}

    for source_asset in manifest.get("assets", []):
        points = polygon_points(source_asset)
        specs = triangle_specs(short_diagonal(points))
        source_svg = asset_svg_path(source_asset, source_dir)
        if not source_svg.exists():
            raise FileNotFoundError(f"missing source SVG for {source_asset['id']}: {source_svg}")
        source_root = ET.parse(source_svg).getroot()
        created: list[dict[str, Any]] = []
        for shard_name, vertices in specs:
            shard_id = f"{source_asset['id']}_{shard_name}"
            svg_name = f"iso_{shard_id}.svg"
            triangle = [points[index] for index in vertices]
            write_triangle_svg(
                source_root=source_root,
                out_svg=out_dir / svg_name,
                points=triangle,
            )
            asset = build_shard_asset(source_asset, shard_name, vertices, points, svg_name)
            created.append(asset)
            assets.append(asset)
        pair_by_asset[created[0]["id"]] = created[1]["id"]
        pair_by_asset[created[1]["id"]] = created[0]["id"]
        created[0]["shard"]["paired_asset"] = created[1]["id"]
        created[1]["shard"]["paired_asset"] = created[0]["id"]

    out_manifest = deepcopy(manifest)
    out_manifest["version"] = max(2, int(out_manifest.get("version", 1)))
    out_manifest["generated_at"] = datetime.now(timezone.utc).isoformat()
    out_manifest["export"] = {
        **manifest.get("export", {}),
        "kind": "triangular_half_face_vector_tiles",
        "source_kind": manifest.get("export", {}).get("kind"),
        "source_asset_count": len(manifest.get("assets", [])),
        "asset_count": len(assets),
        "shard_policy": "each rhombic face asset is split along its equilateral diagonal into two triangular half-face shards",
    }
    out_manifest["assets"] = assets
    out_manifest["topology"] = build_topology(manifest, assets, pair_by_asset)

    out_dir.mkdir(parents=True, exist_ok=True)
    if source_dir.resolve() == out_dir.resolve() and not backup_manifest_path.exists():
        backup_manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out_dir / "manifest.json").write_text(json.dumps(out_manifest, indent=2), encoding="utf-8")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path("ornament/export/vector_tiles"))
    parser.add_argument("--out-dir", type=Path, default=Path("ornament/export/vector_tiles"))
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    split_manifest(args.source_dir, args.out_dir)
    print(f"wrote triangular shards to {args.out_dir}")


if __name__ == "__main__":
    main()
