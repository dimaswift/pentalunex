"""Tile-sandbox SVG ZIP export helpers."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence
from zipfile import ZIP_DEFLATED, ZipFile

from .cells import CellId
from .cgrcs import UNIQUE_CORNER_FACE_PAIRS, cgrcs_manifest
from .geometry import FACE_NAMES, ProjectionOffset
from .svg import (
    FACE_CORNER_NAMES,
    _face_local_to_world,
    _iso_face_corners,
    _iso_projector,
    _rotation_frame,
    _rotate_point,
    render_iso_face_svg,
)
from .view import visible_faces_for_corner


CORNER_LABELS = (
    "(-X,-Y,-Z)",
    "(+X,-Y,-Z)",
    "(-X,+Y,-Z)",
    "(+X,+Y,-Z)",
    "(-X,-Y,+Z)",
    "(+X,-Y,+Z)",
    "(-X,+Y,+Z)",
    "(+X,+Y,+Z)",
)
FACE_EDGE_DEFS = (
    ("top", (-1.0, 1.0), (1.0, 1.0)),
    ("right", (1.0, 1.0), (1.0, -1.0)),
    ("bottom", (1.0, -1.0), (-1.0, -1.0)),
    ("left", (-1.0, -1.0), (-1.0, 1.0)),
)


def _round(value: float, digits: int = 3) -> float:
    return round(float(value), digits)


def _point_meta(p: Sequence[float]) -> dict[str, float]:
    return {"x": _round(p[0]), "y": _round(p[1])}


def _vector_meta(p: Sequence[float]) -> list[float]:
    return [_round(p[0]), _round(p[1]), _round(p[2])]


def _edge_meta(a: Sequence[float], b: Sequence[float]) -> dict[str, Any]:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    return {
        "from": _point_meta(a),
        "to": _point_meta(b),
        "vector": _point_meta((dx, dy)),
        "midpoint": _point_meta(((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)),
        "length": _round((dx * dx + dy * dy) ** 0.5),
        "angle_deg": _round(math.degrees(math.atan2(dy, dx))),
    }


def _point_key(p: Sequence[float]) -> str:
    return ",".join(f"{v:.3f}" for v in p)


def _edge_key(a: Sequence[float], b: Sequence[float]) -> str:
    return "|".join(sorted((_point_key(a), _point_key(b))))


def _apply_frame(p: Sequence[float], frame: dict[str, Any]) -> tuple[float, float]:
    r = _rotate_point(p, frame["angle_rad"])
    return (
        r[0] + frame["translate"][0] + frame["pad"][0],
        r[1] + frame["translate"][1] + frame["pad"][1],
    )


def _mirror_point(p: Sequence[float], width: float) -> tuple[float, float]:
    return (width - p[0], p[1])


def _asset_metadata(
    *,
    corner: int,
    face: int,
    frame: dict[str, Any],
    svg_path: str,
    mirrored: bool,
    scale: float,
) -> dict[str, Any]:
    project, _ = _iso_projector(corner)
    width = frame["width"]

    source_corners = _iso_face_corners(face, project, scale)
    polygon_points = [_apply_frame(p, frame) for p in source_corners]
    if mirrored:
        polygon_points = [_mirror_point(p, width) for p in polygon_points]

    polygon = [
        {"name": name, "point": _point_meta(point)}
        for name, point in zip(FACE_CORNER_NAMES, polygon_points)
    ]

    edge_order = tuple(frame["edge_order"])
    edges: dict[str, Any] = {}
    indexed_edges: list[dict[str, Any] | None] = [None, None, None, None]
    for name, edge_from, edge_to in FACE_EDGE_DEFS:
        world_from = _face_local_to_world(face, edge_from[0], edge_from[1])
        world_to = _face_local_to_world(face, edge_to[0], edge_to[1])
        image_from = _apply_frame(project(world_from, scale), frame)
        image_to = _apply_frame(project(world_to, scale), frame)
        if mirrored:
            image_from = _mirror_point(image_from, width)
            image_to = _mirror_point(image_to, width)

        index = edge_order.index(name)
        edge = {
            "index": index,
            "edgeKey": _edge_key(world_from, world_to),
            "worldFrom": _vector_meta(world_from),
            "worldTo": _vector_meta(world_to),
            "image": _edge_meta(image_from, image_to),
        }
        edges[name] = edge
        indexed_edges[index] = {"index": index, "semantic_edge": name, **edge}

    base_id = f"corner{corner}_face{face}"
    asset_id = f"{base_id}_mirror" if mirrored else base_id
    return {
        "id": asset_id,
        "corner": corner,
        "corner_label": CORNER_LABELS[corner],
        "face": face,
        "face_name": FACE_NAMES[face],
        "variant": "mirror" if mirrored else "normal",
        "parity": -1 if mirrored else 1,
        "source": base_id if mirrored else None,
        "primary_edge": frame["primary_edge"],
        "edge_order": edge_order,
        "rotation_normalization": {
            "angle_deg": _round(frame["angle_deg"]),
            "tight_width": _round(frame["tight_width"]),
            "tight_height": _round(frame["tight_height"]),
        },
        "files": {"svg": svg_path},
        "image": {"width": _round(frame["width"]), "height": _round(frame["height"])},
        "polygon": polygon,
        "edges": edges,
        "indexed_edges": indexed_edges,
    }


def export_tile_sandbox_zip(
    output_path: str | Path,
    *,
    cells: Iterable[CellId] | None = None,
    eclipse_geometry: dict[str, Any] | None = None,
    scale: float = 1000,
    samples_per_edge: int = 12,
    eclipse_max_step_deg: float = 0.5,
    grid: bool = True,
    grid_stroke: str = "#111111",
    grid_width: float = 1,
    eclipse_fill: str = "#ff5a6d66",
    eclipse_stroke: str = "#ff5a6d",
    eclipse_width: float = 2,
    eclipse_opacity: float = 1,
    selected_fill: str = "none",
    selected_stroke: str = "#d33",
    selected_width: float = 2,
    hatch_density: float = 0,
    hatch_spacing: float | None = None,
    hatch_angle: float = 0,
    hatch_parallel_edge: int | str | None = "left",
    lon_offset: float = 0,
    lat_offset: float = 0,
    roll_offset: float = 0,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
    include_mirrors: bool = True,
    include_duplicate_corner_faces: bool = False,
) -> Path:
    """Write a tile-sandbox ZIP containing 12 canonical rhombs plus mirrors."""

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    offset = projection_offset or ProjectionOffset(lon_offset, lat_offset, roll_offset)

    jobs: list[tuple[int, int]] = []
    target_width = 0.0
    target_height = 0.0
    source_jobs = (
        [
            (corner, face)
            for corner in range(8)
            for face in visible_faces_for_corner(corner)
        ]
        if include_duplicate_corner_faces
        else list(UNIQUE_CORNER_FACE_PAIRS)
    )
    for corner, face in source_jobs:
        project, _ = _iso_projector(corner)
        corners = _iso_face_corners(face, project, scale)
        frame = _rotation_frame(corners)
        jobs.append((corner, face))
        target_width = max(target_width, frame["tight_width"])
        target_height = max(target_height, frame["tight_height"])

    assets: list[dict[str, Any]] = []
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as zip_file:
        for corner, face in jobs:
            frame = _rotation_frame(
                _iso_face_corners(face, _iso_projector(corner)[0], scale),
                target_width,
                target_height,
            )
            for mirrored in ((False, True) if include_mirrors else (False,)):
                suffix = "_mirror" if mirrored else ""
                svg_path = f"tiles/iso_corner{corner}_face{face}{suffix}.svg"
                svg = render_iso_face_svg(
                    face,
                    cells=cells,
                    eclipse_geometry=eclipse_geometry,
                    corner=corner,
                    scale=scale,
                    samples_per_edge=samples_per_edge,
                    eclipse_max_step_deg=eclipse_max_step_deg,
                    grid=grid,
                    grid_stroke=grid_stroke,
                    grid_width=grid_width,
                    eclipse_fill=eclipse_fill,
                    eclipse_stroke=eclipse_stroke,
                    eclipse_width=eclipse_width,
                    eclipse_opacity=eclipse_opacity,
                    selected_fill=selected_fill,
                    selected_stroke=selected_stroke,
                    selected_width=selected_width,
                    hatch_density=hatch_density,
                    hatch_spacing=hatch_spacing,
                    hatch_angle=hatch_angle,
                    hatch_parallel_edge=hatch_parallel_edge,
                    projection_offset=offset,
                    normalize_orientation=True,
                    target_width=target_width,
                    target_height=target_height,
                    mirror=mirrored,
                )
                zip_file.writestr(svg_path, svg)
                assets.append(
                    _asset_metadata(
                        corner=corner,
                        face=face,
                        frame=frame,
                        svg_path=svg_path,
                        mirrored=mirrored,
                        scale=scale,
                    )
                )

        manifest = {
            "version": 1,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "export": {
                "kind": "iso_tile_sandbox_svg",
                "scale": scale,
                "asset_count": len(assets),
                "normal_asset_count": len(jobs),
                "mirror_asset_count": len(jobs) if include_mirrors else 0,
                "include_duplicate_corner_faces": include_duplicate_corner_faces,
                "corner_face_policy": (
                    "deduplicated to 12 canonical rotation classes"
                    if not include_duplicate_corner_faces
                    else "legacy 24 corner/face exports"
                ),
                "corners": [
                    {
                        "index": index,
                        "label": label,
                        "visible_faces": visible_faces_for_corner(index),
                    }
                    for index, label in enumerate(CORNER_LABELS)
                ],
            },
            "projection_offset": {
                "lon": offset.lon,
                "lat": offset.lat,
                "roll": offset.roll,
            },
            "cgrcs": cgrcs_manifest(),
            "canonical_orientation": {
                "primary_edge": "visual left edge after original isometric render",
                "edge_index_order": "starts at primary_edge, then follows top/right/bottom/left clockwise order",
                "edge_0": "bottom-left corner to top-left corner",
                "method": "rotation-only post-process; no affine skew or reprojection",
            },
            "variants": {
                "normal": {"parity": 1, "description": "Rendered shard as exported."},
                "mirror": {
                    "parity": -1,
                    "description": "Horizontally reflected SVG shard with all overlays mirrored together.",
                },
            },
            "graticule": {
                "enabled": grid,
                "stroke": grid_stroke,
                "width": grid_width,
            },
            "assets": assets,
        }
        zip_file.writestr("manifest.json", json.dumps(manifest, indent=2))

    return output
