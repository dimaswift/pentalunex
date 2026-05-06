"""SVG renderers for direct cube faces and 8-corner isometric views."""

from __future__ import annotations

import html
import math
from typing import Any, Iterable, Sequence

try:
    from shapely.geometry import LineString, Polygon, box
    from shapely.validation import make_valid
except Exception:  # pragma: no cover
    LineString = None
    Polygon = None
    box = None
    make_valid = None

from .cells import CellId, cell_ring_face_xy, cells_for_face, validate_cell
from .geometry import densify_lonlat_segment, face_xy_to_pixel, lonlat_to_vec3, to_face_xyz


FACE_CLIP_EPS = 1e-8
CLASSIC_CROSS_LAYOUT = (
    (None, 0, None, None),
    (4, 1, 2, 3),
    (None, 5, None, None),
)


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
    if Polygon is None or box is None:
        raise RuntimeError("eclipse path SVG rendering requires shapely")

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
) -> list[str]:
    parts = []
    for poly in _face_polygons_from_geojson(
        eclipse_geometry,
        face,
        max_step_deg=eclipse_max_step_deg,
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
    dx: float = 0,
    dy: float = 0,
) -> list[str]:
    parts = []
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
            angle_deg=hatch_angle,
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
    if Polygon is None:
        raise RuntimeError("density hatching requires shapely")

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
) -> str:
    """Render a single cube face SVG."""

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
) -> str:
    """Render face SVGs glued into a flat cube-net layout.

    ``layout`` may be a one-row sequence, e.g. ``[1, 2, 3, 4]``, or a nested
    row layout with ``None`` holes, e.g. ``CLASSIC_CROSS_LAYOUT``.
    """

    rows = _normalize_face_layout(layout)
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
) -> str:
    """Render a three-face isometric SVG from one of the 8 cube corners."""

    if not 0 <= corner <= 7:
        raise ValueError("corner must be 0..7")
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
            parts.append(
                f'<path d="{_path(pts)}" fill="{selected_fill}" '
                f'stroke="{selected_stroke}" stroke-width="{selected_width}"/>'
            )
            for x0, y0, x1, y1 in _hatch_segments(
                pts,
                density=hatch_density,
                spacing=hatch_spacing,
                angle_deg=hatch_angle,
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
