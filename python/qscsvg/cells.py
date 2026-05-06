"""Face-native 30-degree graticule cells for the QSC cube."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence

from .geometry import (
    DEG,
    EQUATOR_FACE_CENTERS,
    face_xy_to_lonlat,
    lon_delta,
    lon_interval_overlap,
    lonlat_to_face_xy,
    normalize_lon_360,
)


EQUATOR_REL_LON_BOUNDS = (-45.0, -30.0, 0.0, 30.0, 45.0)
EQUATOR_LAT_BOUNDS = (-90.0, -30.0, 0.0, 30.0, 90.0)
POLAR_LAT_BOUND = 60.0
POLAR_SECTORS = 12


@dataclass(frozen=True, order=True)
class CellId:
    """Stable graticule cell identifier.

    For equatorial faces 1..4:
      a = column west-to-east, 0..3
      b = row south-to-north, 0..3

    For polar faces 0 and 5:
      a = longitude sector, floor(lon / 30), 0..11
      b = ring, 0 outer and 1 inner
    """

    face: int
    a: int
    b: int

    def key(self) -> str:
        return f"{self.face}:{self.a}:{self.b}"


def all_cells() -> list[CellId]:
    cells: list[CellId] = []
    for face in (0, 5):
        for sector in range(POLAR_SECTORS):
            for ring in range(2):
                cells.append(CellId(face, sector, ring))
    for face in (1, 2, 3, 4):
        for row in range(4):
            for col in range(4):
                cells.append(CellId(face, col, row))
    return sorted(cells)


def is_polar(face: int) -> bool:
    return face in (0, 5)


def _bucket(value: float, bounds: Sequence[float]) -> int:
    for i in range(len(bounds) - 1):
        if value < bounds[i + 1] or i == len(bounds) - 2:
            return i
    return len(bounds) - 2


def cell_at_lonlat(lon: float, lat: float) -> CellId:
    fp = lonlat_to_face_xy(lon, lat)
    return cell_at_face_xy(fp.face, fp.x, fp.y)


def cell_at_face_xy(face: int, x: float, y: float) -> CellId:
    lon, lat = face_xy_to_lonlat(face, x, y)
    if is_polar(face):
        sector = min(11, int(math.floor(normalize_lon_360(lon) / 30.0)))
        ring = 1 if abs(lat) >= POLAR_LAT_BOUND else 0
        return CellId(face, sector, ring)

    center = EQUATOR_FACE_CENTERS[face]
    rel_lon = max(-45.0, min(45.0, lon_delta(lon, center)))
    col = _bucket(rel_lon, EQUATOR_REL_LON_BOUNDS)
    if lat < -30.0:
        row = 0
    elif lat < 0.0:
        row = 1
    elif lat < 30.0:
        row = 2
    else:
        row = 3
    return CellId(face, col, row)


def _equator_point(face: int, col_boundary: int, row_boundary: int) -> tuple[float, float]:
    rel = EQUATOR_REL_LON_BOUNDS[col_boundary]
    x = math.tan(rel * DEG)
    if row_boundary == 0:
        return (x, -1.0)
    if row_boundary == 4:
        return (x, 1.0)
    lat = EQUATOR_LAT_BOUNDS[row_boundary]
    y = math.tan(lat * DEG) / math.cos(rel * DEG)
    return (x, y)


def _sample_equator_horizontal(
    face: int,
    col0: int,
    col1: int,
    row_boundary: int,
    samples: int,
) -> list[tuple[float, float]]:
    p0 = _equator_point(face, col0, row_boundary)
    p1 = _equator_point(face, col1, row_boundary)
    if row_boundary in (0, 4):
        return [
            (p0[0] + (p1[0] - p0[0]) * i / samples, p0[1])
            for i in range(samples + 1)
        ]

    center = EQUATOR_FACE_CENTERS[face]
    rel0 = EQUATOR_REL_LON_BOUNDS[col0]
    rel1 = EQUATOR_REL_LON_BOUNDS[col1]
    lat = EQUATOR_LAT_BOUNDS[row_boundary]
    pts = []
    for i in range(samples + 1):
        rel = rel0 + (rel1 - rel0) * i / samples
        fp = lonlat_to_face_xy(center + rel, lat, face=face)
        pts.append((fp.x, fp.y))
    return pts


def _sample_equator_vertical(
    face: int,
    col_boundary: int,
    row0: int,
    row1: int,
    samples: int,
) -> list[tuple[float, float]]:
    p0 = _equator_point(face, col_boundary, row0)
    p1 = _equator_point(face, col_boundary, row1)
    rel = EQUATOR_REL_LON_BOUNDS[col_boundary]
    x = p0[0]
    if row0 == 0 and row1 == 4:
        return [(x, -1.0 + 2.0 * i / samples) for i in range(samples + 1)]

    pts = []
    for i in range(samples + 1):
        t = i / samples
        if row0 == 0:
            y = -1.0 + (p1[1] + 1.0) * t
        elif row1 == 4:
            y = p0[1] + (1.0 - p0[1]) * t
        else:
            lat0 = EQUATOR_LAT_BOUNDS[row0]
            lat1 = EQUATOR_LAT_BOUNDS[row1]
            lat = lat0 + (lat1 - lat0) * t
            y = math.tan(lat * DEG) / math.cos(rel * DEG)
        pts.append((x, y))
    return pts


def _polar_face_xy(face: int, lon: float, lat_abs: float) -> tuple[float, float]:
    lat = lat_abs if face == 0 else -lat_abs
    fp = lonlat_to_face_xy(lon, lat, face=face)
    return (fp.x, fp.y)


def _polar_square_point(face: int, lon: float) -> tuple[float, float]:
    x, y = _polar_face_xy(face, lon, POLAR_LAT_BOUND)
    m = max(abs(x), abs(y))
    return (x / m, y / m)


def _sample_polar_square(face: int, lon0: float, lon1: float, samples: int) -> list[tuple[float, float]]:
    return [
        _polar_square_point(face, lon0 + (lon1 - lon0) * i / samples)
        for i in range(samples + 1)
    ]


def _sample_polar_arc(face: int, lon0: float, lon1: float, samples: int) -> list[tuple[float, float]]:
    return [
        _polar_face_xy(face, lon0 + (lon1 - lon0) * i / samples, POLAR_LAT_BOUND)
        for i in range(samples + 1)
    ]


def cell_ring_face_xy(cell: CellId, samples_per_edge: int = 8) -> list[tuple[float, float]]:
    """Return a closed-ish ring in face x/y coordinates.

    The first point is not repeated at the end. Consumers that need explicit
    closure should append it themselves.
    """

    n = max(2, samples_per_edge)
    face = cell.face
    if not is_polar(face):
        col = cell.a
        row = cell.b
        bottom = _sample_equator_horizontal(face, col, col + 1, row, n)
        right = _sample_equator_vertical(face, col + 1, row, row + 1, n)[1:]
        top = list(reversed(_sample_equator_horizontal(face, col, col + 1, row + 1, n)))[1:]
        left = list(reversed(_sample_equator_vertical(face, col, row, row + 1, n)))[1:-1]
        return bottom + right + top + left

    lon0 = cell.a * 30.0
    lon1 = lon0 + 30.0
    pole = (0.0, 0.0)
    if cell.b == 0:
        outer = _sample_polar_square(face, lon0, lon1, n * 2)
        inward = list(reversed(_sample_polar_arc(face, lon0, lon1, n)))
        return outer + inward

    arc = _sample_polar_arc(face, lon0, lon1, n)
    return arc + [pole]


def cell_ring_lonlat(cell: CellId, samples_per_edge: int = 8) -> list[tuple[float, float]]:
    return [face_xy_to_lonlat(cell.face, x, y) for x, y in cell_ring_face_xy(cell, samples_per_edge)]


def _wrap_sector(sector: int) -> int:
    return sector % POLAR_SECTORS


def _equator_side_lon_interval(face: int, col: int) -> tuple[float, float]:
    center = EQUATOR_FACE_CENTERS[face]
    return (
        center + EQUATOR_REL_LON_BOUNDS[col],
        center + EQUATOR_REL_LON_BOUNDS[col + 1],
    )


def _polar_outer_sectors_for_lon_interval(lon0: float, lon1: float) -> list[int]:
    out = []
    for sector in range(POLAR_SECTORS):
        s0 = sector * 30.0
        s1 = s0 + 30.0
        if lon_interval_overlap(lon0, lon1, s0, s1):
            out.append(sector)
    return out


def adjacent_cells(cell: CellId) -> list[CellId]:
    """Return cells that share a non-zero-length edge with *cell*."""

    face, a, b = cell.face, cell.a, cell.b
    out: set[CellId] = set()

    if is_polar(face):
        out.add(CellId(face, _wrap_sector(a - 1), b))
        out.add(CellId(face, _wrap_sector(a + 1), b))
        out.add(CellId(face, a, 1 - b))
        if b == 0:
            pole_face = face
            eq_row = 3 if pole_face == 0 else 0
            for eq_face in (1, 2, 3, 4):
                for col in range(4):
                    lon0, lon1 = _equator_side_lon_interval(eq_face, col)
                    if a in _polar_outer_sectors_for_lon_interval(lon0, lon1):
                        out.add(CellId(eq_face, col, eq_row))
        return sorted(out)

    # Same-face equatorial neighbors.
    if a > 0:
        out.add(CellId(face, a - 1, b))
    else:
        prev_face = 4 if face == 1 else face - 1
        out.add(CellId(prev_face, 3, b))
    if a < 3:
        out.add(CellId(face, a + 1, b))
    else:
        next_face = 1 if face == 4 else face + 1
        out.add(CellId(next_face, 0, b))
    if b > 0:
        out.add(CellId(face, a, b - 1))
    else:
        lon0, lon1 = _equator_side_lon_interval(face, a)
        for sector in _polar_outer_sectors_for_lon_interval(lon0, lon1):
            out.add(CellId(5, sector, 0))
    if b < 3:
        out.add(CellId(face, a, b + 1))
    else:
        lon0, lon1 = _equator_side_lon_interval(face, a)
        for sector in _polar_outer_sectors_for_lon_interval(lon0, lon1):
            out.add(CellId(0, sector, 0))
    return sorted(out)


def validate_cell(cell: CellId) -> None:
    if cell.face not in range(6):
        raise ValueError(f"face must be 0..5, got {cell.face}")
    if is_polar(cell.face):
        if not 0 <= cell.a < 12 or cell.b not in (0, 1):
            raise ValueError(f"invalid polar cell {cell}")
    elif not 0 <= cell.a < 4 or not 0 <= cell.b < 4:
        raise ValueError(f"invalid equatorial cell {cell}")


def cells_for_face(face: int) -> list[CellId]:
    return [cell for cell in all_cells() if cell.face == face]


def cell_label(cell: CellId) -> str:
    if is_polar(cell.face):
        ring = "outer" if cell.b == 0 else "inner"
        return f"F{cell.face} sector {cell.a} {ring}"
    return f"F{cell.face} col {cell.a} row {cell.b}"
