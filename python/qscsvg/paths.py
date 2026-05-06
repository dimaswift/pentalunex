"""Polygon-to-cell intersection helpers."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
import math
from typing import Any

try:
    from shapely.geometry import MultiPolygon, Polygon, box
    from shapely.ops import unary_union
    from shapely.validation import make_valid
except Exception:  # pragma: no cover - handled at runtime.
    MultiPolygon = None
    Polygon = None
    box = None
    unary_union = None
    make_valid = None

from .cells import CellId, all_cells, cell_at_lonlat, cell_ring_face_xy, cell_ring_lonlat, cells_for_face
from .geometry import densify_lonlat_segment, lonlat_to_vec3, pixel_to_face_xy, to_face_xyz, unwrap_ring


FACE_CLIP_EPS = 1e-8


def _require_shapely() -> None:
    if Polygon is None:
        raise RuntimeError("qscsvg.paths requires shapely for polygon intersections")


def _closed_ring(points: Iterable[Sequence[float]]) -> list[tuple[float, float]]:
    pts = [(float(p[0]), float(p[1])) for p in points]
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def _ring_reference(ring: Sequence[Sequence[float]]) -> float:
    if not ring:
        return 0.0
    return float(ring[0][0])


def _polygon_from_lonlat_rings(rings: Sequence[Sequence[Sequence[float]]], reference: float):
    shell = _closed_ring(unwrap_ring(rings[0], reference))
    holes = [_closed_ring(unwrap_ring(r, reference)) for r in rings[1:]]
    return _make_valid(Polygon(shell, holes))


def _make_valid(geom):
    if geom.is_valid:
        return geom
    if make_valid is not None:
        return make_valid(geom)
    return geom.buffer(0)


def _iter_polygons(geom) -> Iterable:
    if geom is None or geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif geom.geom_type == "MultiPolygon":
        yield from geom.geoms
    elif geom.geom_type == "GeometryCollection":
        for part in geom.geoms:
            yield from _iter_polygons(part)


def _densify_ring(ring: Sequence[Sequence[float]], max_step_deg: float) -> list[tuple[float, float]]:
    pts = [(float(p[0]), float(p[1])) for p in ring]
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    out: list[tuple[float, float]] = []
    for a, b in zip(pts, pts[1:]):
        segment = densify_lonlat_segment(a, b, max_step_deg=max_step_deg)
        if out:
            segment = segment[1:]
        out.extend(segment)
    return out


def _project_lonlat_ring_to_face(
    face: int,
    ring: Sequence[Sequence[float]],
    max_step_deg: float,
) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for lon, lat in _densify_ring(ring, max_step_deg):
        p = to_face_xyz(face, lonlat_to_vec3(lon, lat))
        if p[2] <= FACE_CLIP_EPS:
            continue
        x = p[0] / p[2]
        y = p[1] / p[2]
        if math.isfinite(x) and math.isfinite(y):
            out.append((x, y))
    if len(out) >= 2 and out[0] != out[-1]:
        out.append(out[0])
    return out


def _face_polygons_from_geojson(
    geometry: dict[str, Any],
    face: int,
    *,
    max_step_deg: float,
):
    _require_shapely()
    if box is None:
        raise RuntimeError("qscsvg.paths requires shapely for face clipping")

    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    else:
        raise ValueError(f"expected Polygon or MultiPolygon, got {gtype!r}")

    face_square = box(-1.0, -1.0, 1.0, 1.0)
    projected = []
    for poly in polygons:
        if not poly:
            continue
        shell = _project_lonlat_ring_to_face(face, poly[0], max_step_deg)
        holes = [
            hole for ring in poly[1:]
            if len(hole := _project_lonlat_ring_to_face(face, ring, max_step_deg)) >= 4
        ]
        if len(shell) < 4:
            continue
        geom = _make_valid(Polygon(shell, holes))
        clipped = _make_valid(geom.intersection(face_square))
        projected.extend(_iter_polygons(clipped))
    return projected


def _geojson_to_shapely(geometry: dict[str, Any], reference: float):
    _require_shapely()
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        return _polygon_from_lonlat_rings(coords, reference)
    if gtype == "MultiPolygon":
        parts = [_polygon_from_lonlat_rings(poly, reference) for poly in coords]
        return _make_valid(unary_union(parts))
    raise ValueError(f"expected Polygon or MultiPolygon, got {gtype!r}")


def _cell_polygon_lonlat(cell: CellId, reference: float, samples_per_edge: int):
    ring = cell_ring_lonlat(cell, samples_per_edge=samples_per_edge)
    return _make_valid(Polygon(_closed_ring(unwrap_ring(ring, reference))))


def _cell_center_reference(cell: CellId) -> float:
    ring = cell_ring_lonlat(cell, samples_per_edge=2)
    return _ring_reference(ring)


def _ordered_boundary_cells(geometry: dict[str, Any], allowed: set[CellId]) -> list[CellId]:
    seen: set[CellId] = set()
    ordered: list[CellId] = []

    def add_ring(ring: Sequence[Sequence[float]]) -> None:
        for a, b in zip(ring, ring[1:]):
            samples = densify_lonlat_segment(a, b, max_step_deg=1.0)
            for lon, lat in samples:
                cell = cell_at_lonlat(lon, lat)
                if cell in allowed and cell not in seen:
                    seen.add(cell)
                    ordered.append(cell)

    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        add_ring(coords[0])
    elif gtype == "MultiPolygon":
        for poly in coords:
            add_ring(poly[0])
    return ordered


def cells_intersecting_geojson(
    geometry: dict[str, Any],
    *,
    samples_per_edge: int = 10,
    max_step_deg: float = 0.5,
    min_area: float = 1e-9,
    ordered: bool = True,
) -> list[CellId]:
    """Return cells whose face-local polygons overlap a GeoJSON polygon."""

    hits: set[CellId] = set()
    for face in range(6):
        face_polys = _face_polygons_from_geojson(geometry, face, max_step_deg=max_step_deg)
        if not face_polys:
            continue
        for cell in cells_for_face(face):
            cell_poly = Polygon(_closed_ring(cell_ring_face_xy(cell, samples_per_edge)))
            area = sum(poly.intersection(cell_poly).area for poly in face_polys if not poly.is_empty)
            if area > min_area:
                hits.add(cell)

    if not ordered:
        return sorted(hits)

    out = _ordered_boundary_cells(geometry, hits)
    seen = set(out)
    out.extend(cell for cell in sorted(hits) if cell not in seen)
    return out


def cells_intersecting_face_polygon(
    face: int,
    points: Sequence[Sequence[float]],
    *,
    pixel_size: float | None = None,
    samples_per_edge: int = 10,
    min_area: float = 1e-9,
) -> list[CellId]:
    """Return face cells intersecting a filled polygon in face x/y or pixels."""

    _require_shapely()
    if pixel_size is None:
        xy = [(float(p[0]), float(p[1])) for p in points]
    else:
        xy = [pixel_to_face_xy(float(p[0]), float(p[1]), pixel_size) for p in points]

    poly = Polygon(_closed_ring(xy))
    hits = []
    for cell in cells_for_face(face):
        cell_poly = Polygon(_closed_ring(cell_ring_face_xy(cell, samples_per_edge)))
        if poly.intersection(cell_poly).area > min_area:
            hits.append(cell)
    return hits
