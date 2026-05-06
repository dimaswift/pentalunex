"""SVG renderers for direct cube faces and 8-corner isometric views."""

from __future__ import annotations

import html
import math
from typing import Any, Iterable, Sequence

LineString = None
Polygon = None
box = None
make_valid = None

from .cells import CellId, cell_ring_face_xy, cells_for_face, validate_cell
from .geometry import (
    ProjectionOffset,
    densify_lonlat_segment,
    face_xy_to_pixel,
    oriented_lonlat_to_vec3,
    to_face_xyz,
)


FACE_CLIP_EPS = 1e-8
CLASSIC_CROSS_LAYOUT = (
    (None, 0, None, None),
    (4, 1, 2, 3),
    (None, 5, None, None),
)
FACE_EDGE_NAMES = ("top", "right", "bottom", "left")
FACE_CORNER_NAMES = ("top_left", "top_right", "bottom_right", "bottom_left")


def _require_shapely(reason: str) -> None:
    global LineString, Polygon, box, make_valid
    if Polygon is not None and LineString is not None and box is not None:
        return
    try:
        from shapely.geometry import LineString as shapely_linestring
        from shapely.geometry import Polygon as shapely_polygon
        from shapely.geometry import box as shapely_box
        from shapely.validation import make_valid as shapely_make_valid
    except Exception as exc:  # pragma: no cover - depends on optional dependency.
        raise RuntimeError(reason) from exc
    LineString = shapely_linestring
    Polygon = shapely_polygon
    box = shapely_box
    make_valid = shapely_make_valid


def _path(points: Sequence[Sequence[float]], close: bool = True, precision: int = 2) -> str:
    if not points:
        return ""
    fmt = f"{{:.{precision}f}}"
    d = [f"M{fmt.format(points[0][0])},{fmt.format(points[0][1])}"]
    for x, y in points[1:]:
        d.append(f"L{fmt.format(x)},{fmt.format(y)}")
    if close:
        d.append("Z")
    return "".join(d)


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
    if not ring:
        return []
    pts = [(float(p[0]), float(p[1])) for p in ring]
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    out: list[tuple[float, float]] = []
    for a, b in zip(pts, pts[1:]):
        seg = densify_lonlat_segment(a, b, max_step_deg=max_step_deg)
        if out:
            seg = seg[1:]
        out.extend(seg)
    return out


def _project_lonlat_ring_to_face(
    face: int,
    ring: Sequence[Sequence[float]],
    max_step_deg: float,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for lon, lat in _densify_ring(ring, max_step_deg):
        p = to_face_xyz(face, oriented_lonlat_to_vec3(lon, lat, projection_offset))
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
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
):
    _require_shapely("eclipse path SVG rendering requires shapely")

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


def _face_polygon_svg_points(poly, size: float) -> list[list[tuple[float, float]]]:
    rings = []
    exterior = list(poly.exterior.coords)
    rings.append([face_xy_to_pixel(x, y, size) for x, y in exterior])
    for interior in poly.interiors:
        rings.append([face_xy_to_pixel(x, y, size) for x, y in interior.coords])
    return rings


def _face_polygon_iso_points(poly, face: int, project, scale: float) -> list[list[tuple[float, float]]]:
    rings = []
    exterior = list(poly.exterior.coords)
    rings.append([project(_face_local_to_world(face, x, y), scale) for x, y in exterior])
    for interior in poly.interiors:
        rings.append([project(_face_local_to_world(face, x, y), scale) for x, y in interior.coords])
    return rings


def _polygon_paths_from_rings(rings: Sequence[Sequence[Sequence[float]]]) -> str:
    return "".join(_path(ring, close=True) for ring in rings if ring)


def _cell_svg_points(cell: CellId, size: float, samples_per_edge: int) -> list[tuple[float, float]]:
    return [
        face_xy_to_pixel(x, y, size)
        for x, y in cell_ring_face_xy(cell, samples_per_edge=samples_per_edge)
    ]


def _translate_points(
    points: Sequence[Sequence[float]],
    dx: float,
    dy: float,
) -> list[tuple[float, float]]:
    return [(p[0] + dx, p[1] + dy) for p in points]


def _face_edge_index(edge: int | str) -> int:
    if isinstance(edge, str):
        try:
            return FACE_EDGE_NAMES.index(edge)
        except ValueError as exc:
            raise ValueError(f"edge must be one of {FACE_EDGE_NAMES}") from exc
    idx = int(edge)
    if not 0 <= idx <= 3:
        raise ValueError("edge must be 0..3")
    return idx


def _edge_angle_deg(corners: Sequence[Sequence[float]], edge: int | str) -> float:
    idx = _face_edge_index(edge)
    a = corners[idx]
    b = corners[(idx + 1) % 4]
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))


def _flat_face_corners(size: float, dx: float = 0, dy: float = 0) -> list[tuple[float, float]]:
    return [
        (dx, dy),
        (dx + size, dy),
        (dx + size, dy + size),
        (dx, dy + size),
    ]


def _resolve_hatch_angle(
    hatch_angle: float,
    hatch_parallel_edge: int | str | None,
    corners: Sequence[Sequence[float]],
) -> float:
    if hatch_parallel_edge is None:
        return hatch_angle
    return _edge_angle_deg(corners, hatch_parallel_edge)


def _face_grid_parts(
    face: int,
    *,
    size: float,
    samples_per_edge: int,
    grid_stroke: str,
    grid_width: float,
    dx: float = 0,
    dy: float = 0,
) -> list[str]:
    paths = []
    for cell in cells_for_face(face):
        pts = _translate_points(_cell_svg_points(cell, size, samples_per_edge), dx, dy)
        paths.append(f'<path d="{_path(pts)}"/>')
    paths.append(
        f'<rect x="{dx + grid_width / 2}" y="{dy + grid_width / 2}" '
        f'width="{size - grid_width}" height="{size - grid_width}" fill="none"/>'
    )
    return [
        f'<g fill="none" stroke="{grid_stroke}" stroke-width="{grid_width}">'
        + "".join(paths)
        + "</g>"
    ]


def _face_eclipse_parts(
    face: int,
    *,
    eclipse_geometry: dict[str, Any],
    size: float,
    eclipse_max_step_deg: float,
    eclipse_fill: str,
    eclipse_stroke: str,
    eclipse_width: float,
    eclipse_opacity: float,
    dx: float = 0,
    dy: float = 0,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> list[str]:
    parts = []
    for poly in _face_polygons_from_geojson(
        eclipse_geometry,
        face,
        max_step_deg=eclipse_max_step_deg,
        projection_offset=projection_offset,
    ):
        rings = [
            _translate_points(ring, dx, dy)
            for ring in _face_polygon_svg_points(poly, size)
        ]
        d = _polygon_paths_from_rings(rings)
        if d:
            parts.append(
                f'<path d="{d}" fill="{eclipse_fill}" fill-rule="evenodd" '
                f'stroke="{eclipse_stroke}" stroke-width="{eclipse_width}" '
                f'opacity="{eclipse_opacity}"/>'
            )
    return parts


def _face_cell_parts(
    face: int,
    *,
    selected: set[CellId],
    size: float,
    samples_per_edge: int,
    selected_fill: str,
    selected_stroke: str,
    selected_width: float,
    hatch_density: float,
    hatch_spacing: float | None,
    hatch_angle: float,
    hatch_parallel_edge: int | str | None = None,
    dx: float = 0,
    dy: float = 0,
) -> list[str]:
    parts = []
    resolved_hatch_angle = _resolve_hatch_angle(
        hatch_angle,
        hatch_parallel_edge,
        _flat_face_corners(size, dx, dy),
    )
    for cell in sorted(selected):
        validate_cell(cell)
        if cell.face != face:
            continue
        pts = _translate_points(_cell_svg_points(cell, size, samples_per_edge), dx, dy)
        parts.append(
            f'<path d="{_path(pts)}" fill="{selected_fill}" '
            f'stroke="{selected_stroke}" stroke-width="{selected_width}"/>'
        )
        for x0, y0, x1, y1 in _hatch_segments(
            pts,
            density=hatch_density,
            spacing=hatch_spacing,
            angle_deg=resolved_hatch_angle,
            stroke_width=selected_width,
        ):
            parts.append(
                f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" '
                f'stroke="{selected_stroke}" stroke-width="{selected_width * 0.5:.2f}"/>'
            )
    return parts


def _hatch_segments(
    points: Sequence[Sequence[float]],
    *,
    density: float,
    spacing: float | None,
    angle_deg: float,
    stroke_width: float,
) -> list[tuple[float, float, float, float]]:
    if spacing is None and density <= 0:
        return []
    _require_shapely("density hatching requires shapely")

    poly = Polygon(points)
    if poly.is_empty:
        return []

    minx, miny, maxx, maxy = poly.bounds
    diag = math.hypot(maxx - minx, maxy - miny)
    if spacing is None:
        density = max(0.0, min(100.0, density))
        line_count = max(1, int(round(2 + density * 0.38)))
        spacing = diag / line_count
    else:
        spacing = max(1e-6, float(spacing))
    theta = math.radians(angle_deg)
    dx, dy = math.cos(theta), math.sin(theta)
    nx, ny = -dy, dx
    cx, cy = (minx + maxx) * 0.5, (miny + maxy) * 0.5
    start = -diag
    end = diag
    segs: list[tuple[float, float, float, float]] = []
    count = int(math.ceil((2 * diag) / spacing)) + 2
    for i in range(-count, count + 1):
        off = i * spacing
        x0 = cx + nx * off + dx * start
        y0 = cy + ny * off + dy * start
        x1 = cx + nx * off + dx * end
        y1 = cy + ny * off + dy * end
        clipped = poly.intersection(LineString([(x0, y0), (x1, y1)]))
        if clipped.is_empty:
            continue
        geoms = getattr(clipped, "geoms", [clipped])
        for geom in geoms:
            coords = list(geom.coords) if hasattr(geom, "coords") else []
            if len(coords) >= 2:
                a = coords[0]
                b = coords[-1]
                if math.hypot(b[0] - a[0], b[1] - a[1]) >= stroke_width * 0.25:
                    segs.append((a[0], a[1], b[0], b[1]))
    return segs


def render_face_svg(
    face: int,
    *,
    cells: Iterable[CellId] | None = None,
    eclipse_geometry: dict[str, Any] | None = None,
    size: float = 1000,
    samples_per_edge: int = 12,
    eclipse_max_step_deg: float = 0.5,
    background: str | None = None,
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
    hatch_parallel_edge: int | str | None = None,
    lon_offset: float = 0,
    lat_offset: float = 0,
    roll_offset: float = 0,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> str:
    """Render a single cube face SVG."""

    offset = projection_offset or ProjectionOffset(lon_offset, lat_offset, roll_offset)
    selected = set(cells or [])
    parts: list[str] = []
    if background:
        parts.append(f'<rect width="{size}" height="{size}" fill="{html.escape(background)}"/>')

    if eclipse_geometry:
        parts.extend(_face_eclipse_parts(
            face,
            eclipse_geometry=eclipse_geometry,
            size=size,
            eclipse_max_step_deg=eclipse_max_step_deg,
            eclipse_fill=eclipse_fill,
            eclipse_stroke=eclipse_stroke,
            eclipse_width=eclipse_width,
            eclipse_opacity=eclipse_opacity,
            projection_offset=offset,
        ))

    if selected:
        parts.extend(_face_cell_parts(
            face,
            selected=selected,
            size=size,
            samples_per_edge=samples_per_edge,
            selected_fill=selected_fill,
            selected_stroke=selected_stroke,
            selected_width=selected_width,
            hatch_density=hatch_density,
            hatch_spacing=hatch_spacing,
            hatch_angle=hatch_angle,
            hatch_parallel_edge=hatch_parallel_edge,
        ))

    if grid:
        parts.extend(_face_grid_parts(
            face,
            size=size,
            samples_per_edge=samples_per_edge,
            grid_stroke=grid_stroke,
            grid_width=grid_width,
        ))

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">'
        + "".join(parts)
        + "</svg>"
    )


def _normalize_face_layout(
    layout: Sequence[int | None] | Sequence[Sequence[int | None]],
) -> list[list[int | None]]:
    rows = list(layout)
    if not rows:
        raise ValueError("layout must contain at least one face")
    first = rows[0]
    if isinstance(first, (list, tuple)):
        return [list(row) for row in rows]  # type: ignore[arg-type]
    return [list(rows)]  # type: ignore[list-item]


def render_face_net_svg(
    layout: Sequence[int | None] | Sequence[Sequence[int | None]] = CLASSIC_CROSS_LAYOUT,
    *,
    cells: Iterable[CellId] | None = None,
    eclipse_geometry: dict[str, Any] | None = None,
    size: float = 1000,
    samples_per_edge: int = 12,
    eclipse_max_step_deg: float = 0.5,
    background: str | None = None,
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
    hatch_parallel_edge: int | str | None = None,
    lon_offset: float = 0,
    lat_offset: float = 0,
    roll_offset: float = 0,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> str:
    """Render face SVGs glued into a flat cube-net layout.

    ``layout`` may be a one-row sequence, e.g. ``[1, 2, 3, 4]``, or a nested
    row layout with ``None`` holes, e.g. ``CLASSIC_CROSS_LAYOUT``.
    """

    rows = _normalize_face_layout(layout)
    offset = projection_offset or ProjectionOffset(lon_offset, lat_offset, roll_offset)
    max_cols = max(len(row) for row in rows)
    width = max_cols * size
    height = len(rows) * size
    selected = set(cells or [])
    parts: list[str] = []
    if background:
        parts.append(f'<rect width="{width}" height="{height}" fill="{html.escape(background)}"/>')

    for row_idx, row in enumerate(rows):
        for col_idx, face in enumerate(row):
            if face is None:
                continue
            if not 0 <= int(face) <= 5:
                raise ValueError(f"face must be 0..5, got {face}")
            dx = col_idx * size
            dy = row_idx * size
            face = int(face)
            if eclipse_geometry:
                parts.extend(_face_eclipse_parts(
                    face,
                    eclipse_geometry=eclipse_geometry,
                    size=size,
                    eclipse_max_step_deg=eclipse_max_step_deg,
                    eclipse_fill=eclipse_fill,
                    eclipse_stroke=eclipse_stroke,
                    eclipse_width=eclipse_width,
                    eclipse_opacity=eclipse_opacity,
                    dx=dx,
                    dy=dy,
                    projection_offset=offset,
                ))
            if selected:
                parts.extend(_face_cell_parts(
                    face,
                    selected=selected,
                    size=size,
                    samples_per_edge=samples_per_edge,
                    selected_fill=selected_fill,
                    selected_stroke=selected_stroke,
                    selected_width=selected_width,
                    hatch_density=hatch_density,
                    hatch_spacing=hatch_spacing,
                    hatch_angle=hatch_angle,
                    hatch_parallel_edge=hatch_parallel_edge,
                    dx=dx,
                    dy=dy,
                ))
            if grid:
                parts.extend(_face_grid_parts(
                    face,
                    size=size,
                    samples_per_edge=samples_per_edge,
                    grid_stroke=grid_stroke,
                    grid_width=grid_width,
                    dx=dx,
                    dy=dy,
                ))

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">'
        + "".join(parts)
        + "</svg>"
    )


def _face_local_to_world(face: int, x: float, y: float) -> tuple[float, float, float]:
    fx = x * 0.5
    fy = y * 0.5
    if face == 0:
        return (fx, 0.5, -fy)
    if face == 1:
        return (fx, fy, 0.5)
    if face == 2:
        return (0.5, fy, -fx)
    if face == 3:
        return (-fx, fy, -0.5)
    if face == 4:
        return (-0.5, fy, fx)
    if face == 5:
        return (-fx, -0.5, -fy)
    raise ValueError(f"face must be 0..5, got {face}")


def _cross(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _iso_projector(corner: int):
    sx = 1 if corner & 1 else -1
    sy = 1 if corner & 2 else -1
    sz = 1 if corner & 4 else -1
    sqrt3 = math.sqrt(3.0)
    z_axis = (sx / sqrt3, sy / sqrt3, sz / sqrt3)
    y_dot = sy / sqrt3
    y_axis = (-y_dot * z_axis[0], 1.0 - y_dot * z_axis[1], -y_dot * z_axis[2])
    y_len = math.sqrt(sum(v * v for v in y_axis))
    y_axis = tuple(v / y_len for v in y_axis)
    x_axis = _cross(y_axis, z_axis)
    visible_faces = (
        0 if sy > 0 else 5,
        1 if sz > 0 else 3,
        2 if sx > 0 else 4,
    )

    def project(p: Sequence[float], scale: float) -> tuple[float, float]:
        return (
            (p[0] * x_axis[0] + p[1] * x_axis[1] + p[2] * x_axis[2]) * scale,
            -(p[0] * y_axis[0] + p[1] * y_axis[1] + p[2] * y_axis[2]) * scale,
        )

    return project, visible_faces


def _corner_world(idx: int) -> tuple[float, float, float]:
    return (
        0.5 if idx & 1 else -0.5,
        0.5 if idx & 2 else -0.5,
        0.5 if idx & 4 else -0.5,
    )


def _iso_bounds(project, scale: float) -> tuple[float, float, float, float]:
    pts = [project(_corner_world(i), scale) for i in range(8)]
    minx = min(p[0] for p in pts)
    maxx = max(p[0] for p in pts)
    miny = min(p[1] for p in pts)
    maxy = max(p[1] for p in pts)
    return minx, miny, maxx - minx, maxy - miny


def _iso_face_bounds(face: int, project, scale: float) -> tuple[float, float, float, float]:
    pts = _iso_face_corners(face, project, scale)
    minx = min(p[0] for p in pts)
    maxx = max(p[0] for p in pts)
    miny = min(p[1] for p in pts)
    maxy = max(p[1] for p in pts)
    return minx, miny, maxx - minx, maxy - miny


def _iso_face_corners(face: int, project, scale: float) -> list[tuple[float, float]]:
    return [
        project(_face_local_to_world(face, -1.0,  1.0), scale),
        project(_face_local_to_world(face,  1.0,  1.0), scale),
        project(_face_local_to_world(face,  1.0, -1.0), scale),
        project(_face_local_to_world(face, -1.0, -1.0), scale),
    ]


def _edge_source_points(
    corners: Sequence[Sequence[float]],
    edge: int | str,
) -> tuple[Sequence[float], Sequence[float]]:
    idx = _face_edge_index(edge)
    return corners[idx], corners[(idx + 1) % 4]


def _visual_primary_edge(corners: Sequence[Sequence[float]]) -> str:
    candidates = []
    for idx, name in enumerate(FACE_EDGE_NAMES):
        a, b = _edge_source_points(corners, idx)
        candidates.append((0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), name))
    candidates.sort()
    return candidates[0][2]


def _edge_order_from_primary(primary_edge: str) -> tuple[str, str, str, str]:
    idx = FACE_EDGE_NAMES.index(primary_edge)
    return FACE_EDGE_NAMES[idx:] + FACE_EDGE_NAMES[:idx]


def _rotate_point(p: Sequence[float], angle_rad: float) -> tuple[float, float]:
    c = math.cos(angle_rad)
    s = math.sin(angle_rad)
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c)


def _rotation_frame(
    corners: Sequence[Sequence[float]],
    target_width: float | None = None,
    target_height: float | None = None,
) -> dict[str, Any]:
    primary_edge = _visual_primary_edge(corners)
    a, b = _edge_source_points(corners, primary_edge)
    angle_rad = -math.pi / 2 - math.atan2(b[1] - a[1], b[0] - a[0])
    rotated = [_rotate_point(p, angle_rad) for p in corners]
    minx = min(p[0] for p in rotated)
    maxx = max(p[0] for p in rotated)
    miny = min(p[1] for p in rotated)
    maxy = max(p[1] for p in rotated)
    tight_width = maxx - minx
    tight_height = maxy - miny
    width = float(target_width if target_width is not None else tight_width)
    height = float(target_height if target_height is not None else tight_height)
    return {
        "primary_edge": primary_edge,
        "edge_order": _edge_order_from_primary(primary_edge),
        "angle_rad": angle_rad,
        "angle_deg": math.degrees(angle_rad),
        "translate": (-minx, -miny),
        "pad": ((width - tight_width) * 0.5, (height - tight_height) * 0.5),
        "tight_width": tight_width,
        "tight_height": tight_height,
        "width": width,
        "height": height,
    }


def _frame_matrix(frame: dict[str, Any]) -> tuple[float, float, float, float, float, float]:
    c = math.cos(frame["angle_rad"])
    s = math.sin(frame["angle_rad"])
    e = frame["translate"][0] + frame["pad"][0]
    f = frame["translate"][1] + frame["pad"][1]
    return (c, s, -s, c, e, f)


def _visible_edges(corner: int) -> list[tuple[int, int]]:
    far = corner ^ 7
    edges = []
    for i in range(8):
        for bit in (1, 2, 4):
            j = i ^ bit
            if j <= i:
                continue
            if i == far or j == far:
                continue
            edges.append((i, j))
    return edges


def render_iso_svg(
    *,
    cells: Iterable[CellId] | None = None,
    eclipse_geometry: dict[str, Any] | None = None,
    corner: int = 7,
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
    hatch_parallel_edge: int | str | None = None,
    lon_offset: float = 0,
    lat_offset: float = 0,
    roll_offset: float = 0,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
) -> str:
    """Render a three-face isometric SVG from one of the 8 cube corners."""

    if not 0 <= corner <= 7:
        raise ValueError("corner must be 0..7")
    offset = projection_offset or ProjectionOffset(lon_offset, lat_offset, roll_offset)
    project, visible_faces = _iso_projector(corner)
    minx, miny, width, height = _iso_bounds(project, scale)
    selected = set(cells or [])
    parts: list[str] = []

    def project_cell(cell: CellId) -> list[tuple[float, float]]:
        return [
            project(_face_local_to_world(cell.face, x, y), scale)
            for x, y in cell_ring_face_xy(cell, samples_per_edge=samples_per_edge)
        ]

    if eclipse_geometry:
        for face in visible_faces:
            for poly in _face_polygons_from_geojson(
                eclipse_geometry,
                face,
                max_step_deg=eclipse_max_step_deg,
                projection_offset=offset,
            ):
                rings = _face_polygon_iso_points(poly, face, project, scale)
                d = _polygon_paths_from_rings(rings)
                if d:
                    parts.append(
                        f'<path d="{d}" fill="{eclipse_fill}" fill-rule="evenodd" '
                        f'stroke="{eclipse_stroke}" stroke-width="{eclipse_width}" '
                        f'opacity="{eclipse_opacity}"/>'
                    )

    if selected:
        for cell in sorted(selected):
            if cell.face not in visible_faces:
                continue
            pts = project_cell(cell)
            resolved_hatch_angle = _resolve_hatch_angle(
                hatch_angle,
                hatch_parallel_edge,
                _iso_face_corners(cell.face, project, scale),
            )
            parts.append(
                f'<path d="{_path(pts)}" fill="{selected_fill}" '
                f'stroke="{selected_stroke}" stroke-width="{selected_width}"/>'
            )
            for x0, y0, x1, y1 in _hatch_segments(
                pts,
                density=hatch_density,
                spacing=hatch_spacing,
                angle_deg=resolved_hatch_angle,
                stroke_width=selected_width,
            ):
                parts.append(
                    f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" '
                    f'stroke="{selected_stroke}" stroke-width="{selected_width * 0.5:.2f}"/>'
                )

    if grid:
        paths = []
        for face in visible_faces:
            for cell in cells_for_face(face):
                paths.append(f'<path d="{_path(project_cell(cell))}"/>')
        edge_paths = []
        for a, b in _visible_edges(corner):
            pa = project(_corner_world(a), scale)
            pb = project(_corner_world(b), scale)
            edge_paths.append(f'M{pa[0]:.2f},{pa[1]:.2f}L{pb[0]:.2f},{pb[1]:.2f}')
        parts.append(
            f'<g fill="none" stroke="{grid_stroke}" stroke-width="{grid_width}">'
            + "".join(paths)
            + f'<path d="{"".join(edge_paths)}"/>'
            + "</g>"
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{minx:.2f} {miny:.2f} {width:.2f} {height:.2f}" '
        f'width="{width:.2f}" height="{height:.2f}">'
        + "".join(parts)
        + "</svg>"
    )


def render_iso_face_svg(
    face: int,
    *,
    cells: Iterable[CellId] | None = None,
    eclipse_geometry: dict[str, Any] | None = None,
    corner: int = 7,
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
    hatch_parallel_edge: int | str | None = None,
    lon_offset: float = 0,
    lat_offset: float = 0,
    roll_offset: float = 0,
    projection_offset: ProjectionOffset | Sequence[float] | None = None,
    normalize_orientation: bool = False,
    target_width: float | None = None,
    target_height: float | None = None,
    mirror: bool = False,
) -> str:
    """Render one cube face as an isometric rhomb from one of the 8 corners."""

    face = int(face)
    if not 0 <= face <= 5:
        raise ValueError("face must be 0..5")
    if not 0 <= corner <= 7:
        raise ValueError("corner must be 0..7")

    offset = projection_offset or ProjectionOffset(lon_offset, lat_offset, roll_offset)
    project, visible_faces = _iso_projector(corner)
    if face not in visible_faces:
        raise ValueError(f"face {face} is not visible from corner {corner}")

    corners = _iso_face_corners(face, project, scale)
    minx, miny, width, height = _iso_face_bounds(face, project, scale)
    selected = set(cells or [])
    parts: list[str] = []

    def project_cell(cell: CellId) -> list[tuple[float, float]]:
        return [
            project(_face_local_to_world(cell.face, x, y), scale)
            for x, y in cell_ring_face_xy(cell, samples_per_edge=samples_per_edge)
        ]

    if eclipse_geometry:
        for poly in _face_polygons_from_geojson(
            eclipse_geometry,
            face,
            max_step_deg=eclipse_max_step_deg,
            projection_offset=offset,
        ):
            rings = _face_polygon_iso_points(poly, face, project, scale)
            d = _polygon_paths_from_rings(rings)
            if d:
                parts.append(
                    f'<path d="{d}" fill="{eclipse_fill}" fill-rule="evenodd" '
                    f'stroke="{eclipse_stroke}" stroke-width="{eclipse_width}" '
                    f'opacity="{eclipse_opacity}"/>'
                )

    if selected:
        for cell in sorted(selected):
            if cell.face != face:
                continue
            pts = project_cell(cell)
            resolved_hatch_angle = _resolve_hatch_angle(
                hatch_angle,
                hatch_parallel_edge,
                corners,
            )
            parts.append(
                f'<path d="{_path(pts)}" fill="{selected_fill}" '
                f'stroke="{selected_stroke}" stroke-width="{selected_width}"/>'
            )
            for x0, y0, x1, y1 in _hatch_segments(
                pts,
                density=hatch_density,
                spacing=hatch_spacing,
                angle_deg=resolved_hatch_angle,
                stroke_width=selected_width,
            ):
                parts.append(
                    f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" '
                    f'stroke="{selected_stroke}" stroke-width="{selected_width * 0.5:.2f}"/>'
                )

    if grid:
        paths = [
            f'<path d="{_path(project_cell(cell))}"/>'
            for cell in cells_for_face(face)
        ]
        corners = [
            *corners,
        ]
        paths.append(f'<path d="{_path(corners)}"/>')
        parts.append(
            f'<g fill="none" stroke="{grid_stroke}" stroke-width="{grid_width}">'
            + "".join(paths)
            + "</g>"
        )

    body = "".join(parts)
    if normalize_orientation:
        frame = _rotation_frame(corners, target_width, target_height)
        a, b, c, d, e, f = _frame_matrix(frame)
        body = (
            f'<g transform="matrix({a:.10f} {b:.10f} {c:.10f} {d:.10f} {e:.2f} {f:.2f})">'
            + body
            + "</g>"
        )
        width = frame["width"]
        height = frame["height"]
        if mirror:
            body = f'<g transform="translate({width:.2f},0) scale(-1,1)">{body}</g>'
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {width:.2f} {height:.2f}" '
            f'width="{width:.2f}" height="{height:.2f}">'
            + body
            + "</svg>"
        )

    if mirror:
        center_x = minx + width * 0.5
        body = f'<g transform="translate({2 * center_x:.2f},0) scale(-1,1)">{body}</g>'

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{minx:.2f} {miny:.2f} {width:.2f} {height:.2f}" '
        f'width="{width:.2f}" height="{height:.2f}">'
        + body
        + "</svg>"
    )
