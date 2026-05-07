"""Polygon-to-cell intersection helpers."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

MultiPolygon = None
Polygon = None
box = None
unary_union = None
make_valid = None

from .cells import CellId, all_cells, cell_at_lonlat, cell_ring_face_xy, cell_ring_lonlat, cells_for_face
from .cgrcs import project_lonlat_ring_to_face_xy, reference_frame_from_offset
from .geometry import (
    ProjectionOffset,
    densify_lonlat_segment,
    pixel_to_face_xy,
    unwrap_ring,
)


def _require_shapely() -> None:
    global MultiPolygon, Polygon, box, unary_union, make_valid
    if Polygon is None:
        try:
            from shapely.geometry import MultiPolygon as shapely_multipolygon
            from shapely.geometry import Polygon as shapely_polygon
            from shapely.geometry import box as shapely_box
            from shapely.ops import unary_union as shapely_unary_union
            from shapely.validation import make_valid as shapely_make_valid
        except Exception as exc:  # pragma: no cover - depends on optional dependency.
            raise RuntimeError("qscsvg.paths requires shapely for polygon intersections") from exc
        MultiPolygon = shapely_multipolygon
        Polygon = shapely_polygon
        box = shapely_box
        unary_union = shapely_unary_union
        make_valid = shapely_make_valid


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


def _project_lonlat_ring_to_face(
    face: int,
    ring: Sequence[Sequence[float]],
    max_step_deg: float,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> list[tuple[float, float]]:
    frame = reference_frame_from_offset(projection_offset)
    out = project_lonlat_ring_to_face_xy(
        face,
        ring,
        frame,
        max_step_deg=max_step_deg,
        clip_to_face=False,
    )
    if len(out) >= 2 and out[0] != out[-1]:
        out.append(out[0])
    return out


def _face_polygons_from_geojson(
    geometry: dict[str, Any],
    face: int,
    *,
    max_step_deg: float,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
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
        shell = _project_lonlat_ring_to_face(face, poly[0], max_step_deg, projection_offset)
        holes = [
            hole for ring in poly[1:]
            if len(hole := _project_lonlat_ring_to_face(face, ring, max_step_deg, projection_offset)) >= 4
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


def _ordered_boundary_cells(
    geometry: dict[str, Any],
    allowed: set[CellId],
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> list[CellId]:
    seen: set[CellId] = set()
    ordered: list[CellId] = []

    def add_ring(ring: Sequence[Sequence[float]]) -> None:
        for a, b in zip(ring, ring[1:]):
            samples = densify_lonlat_segment(a, b, max_step_deg=1.0)
            for lon, lat in samples:
                cell = cell_at_lonlat(lon, lat, projection_offset=projection_offset)
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
    lon_offset: float = 0,
    lat_offset: float = 0,
    roll_offset: float = 0,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> list[CellId]:
    """Return cells whose face-local polygons overlap a GeoJSON polygon."""

    offset = projection_offset or ProjectionOffset(lon_offset, lat_offset, roll_offset)
    hits: set[CellId] = set()
    for face in range(6):
        face_polys = _face_polygons_from_geojson(
            geometry,
            face,
            max_step_deg=max_step_deg,
            projection_offset=offset,
        )
        if not face_polys:
            continue
        for cell in cells_for_face(face):
            cell_poly = Polygon(_closed_ring(cell_ring_face_xy(cell, samples_per_edge)))
            area = sum(poly.intersection(cell_poly).area for poly in face_polys if not poly.is_empty)
            if area > min_area:
                hits.add(cell)

    if not ordered:
        return sorted(hits)

    out = _ordered_boundary_cells(geometry, hits, projection_offset=offset)
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
