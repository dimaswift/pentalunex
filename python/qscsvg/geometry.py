"""Quadrilateralized spherical cube projection primitives.

The face numbering and orientation intentionally match the JavaScript project:

0 = north pole
1 = +X, centered on lon 0
2 = +Y, centered on lon 90E
3 = -X, centered on lon 180
4 = -Y, centered on lon 270E
5 = south pole
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Sequence


DEG = math.pi / 180.0
RAD = 180.0 / math.pi

FACE_NAMES = (
    "North Pole",
    "+X (0)",
    "+Y (90E)",
    "-X (180)",
    "-Y (270E)",
    "South Pole",
)

FACE_FRAMES = (
    {"east": (0.0, 1.0, 0.0), "north": (-1.0, 0.0, 0.0), "normal": (0.0, 0.0, 1.0)},
    {"east": (0.0, 1.0, 0.0), "north": (0.0, 0.0, 1.0), "normal": (1.0, 0.0, 0.0)},
    {"east": (-1.0, 0.0, 0.0), "north": (0.0, 0.0, 1.0), "normal": (0.0, 1.0, 0.0)},
    {"east": (0.0, -1.0, 0.0), "north": (0.0, 0.0, 1.0), "normal": (-1.0, 0.0, 0.0)},
    {"east": (1.0, 0.0, 0.0), "north": (0.0, 0.0, 1.0), "normal": (0.0, -1.0, 0.0)},
    {"east": (0.0, -1.0, 0.0), "north": (-1.0, 0.0, 0.0), "normal": (0.0, 0.0, -1.0)},
)

EQUATOR_FACE_CENTERS = {
    1: 0.0,
    2: 90.0,
    3: 180.0,
    4: 270.0,
}


@dataclass(frozen=True)
class FacePoint:
    face: int
    x: float
    y: float

    @property
    def u(self) -> float:
        return (self.x + 1.0) * 0.5

    @property
    def v(self) -> float:
        return (1.0 - self.y) * 0.5


@dataclass(frozen=True)
class ProjectionOffset:
    lon: float = 0.0
    lat: float = 0.0
    roll: float = 0.0


NO_OFFSET = ProjectionOffset()


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def normalize_lon_180(lon: float) -> float:
    value = ((lon + 180.0) % 360.0) - 180.0
    return 180.0 if value == -180.0 else value


def normalize_lon_360(lon: float) -> float:
    return lon % 360.0


def lon_delta(lon: float, center: float) -> float:
    return ((lon - center + 180.0) % 360.0) - 180.0


def lonlat_to_vec3(lon: float, lat: float) -> tuple[float, float, float]:
    la = lat * DEG
    lo = lon * DEG
    c = math.cos(la)
    return (c * math.cos(lo), c * math.sin(lo), math.sin(la))


def _projection_offset(offset: ProjectionOffset | Sequence[float] | None) -> ProjectionOffset:
    if offset is None:
        return NO_OFFSET
    if isinstance(offset, ProjectionOffset):
        return offset
    values = list(offset)
    if len(values) == 2:
        return ProjectionOffset(float(values[0]), float(values[1]), 0.0)
    if len(values) == 3:
        return ProjectionOffset(float(values[0]), float(values[1]), float(values[2]))
    raise ValueError("projection offset must be (lon, lat) or (lon, lat, roll)")


def rotate_x(p: Sequence[float], deg: float) -> tuple[float, float, float]:
    a = deg * DEG
    c = math.cos(a)
    s = math.sin(a)
    return (p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c)


def rotate_y(p: Sequence[float], deg: float) -> tuple[float, float, float]:
    a = deg * DEG
    c = math.cos(a)
    s = math.sin(a)
    return (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c)


def rotate_z(p: Sequence[float], deg: float) -> tuple[float, float, float]:
    a = deg * DEG
    c = math.cos(a)
    s = math.sin(a)
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2])


def oriented_lonlat_to_vec3(
    lon: float,
    lat: float,
    offset: ProjectionOffset | Sequence[float] | None = None,
) -> tuple[float, float, float]:
    o = _projection_offset(offset)
    return rotate_x(rotate_y(rotate_z(lonlat_to_vec3(lon, lat), o.lon), o.lat), o.roll)


def oriented_vec3_to_lonlat(
    p: Sequence[float],
    offset: ProjectionOffset | Sequence[float] | None = None,
) -> tuple[float, float]:
    o = _projection_offset(offset)
    return vec3_to_lonlat(rotate_z(rotate_y(rotate_x(p, -o.roll), -o.lat), -o.lon))


def vec3_to_lonlat(p: Sequence[float]) -> tuple[float, float]:
    lon = math.atan2(p[1], p[0]) * RAD
    lat = math.asin(clamp(p[2], -1.0, 1.0)) * RAD
    return (normalize_lon_180(lon), lat)


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def normalize3(p: Sequence[float]) -> tuple[float, float, float]:
    length = math.sqrt(dot(p, p))
    if length == 0:
        raise ValueError("cannot normalize zero-length vector")
    return (p[0] / length, p[1] / length, p[2] / length)


def owning_face_for_vec3(p: Sequence[float]) -> int:
    best_face = 0
    best_dot = -math.inf
    for face, frame in enumerate(FACE_FRAMES):
        d = dot(p, frame["normal"])
        if d > best_dot:
            best_dot = d
            best_face = face
    return best_face


def to_face_xyz(face: int, p: Sequence[float]) -> tuple[float, float, float]:
    frame = FACE_FRAMES[face]
    return (
        dot(p, frame["east"]),
        dot(p, frame["north"]),
        dot(p, frame["normal"]),
    )


def from_face_xyz(face: int, p: Sequence[float]) -> tuple[float, float, float]:
    frame = FACE_FRAMES[face]
    east = frame["east"]
    north = frame["north"]
    normal = frame["normal"]
    return (
        p[0] * east[0] + p[1] * north[0] + p[2] * normal[0],
        p[0] * east[1] + p[1] * north[1] + p[2] * normal[1],
        p[0] * east[2] + p[1] * north[2] + p[2] * normal[2],
    )


def vec3_to_face_xy(face: int, p: Sequence[float]) -> tuple[float, float]:
    x, y, z = to_face_xyz(face, p)
    if z <= 0:
        raise ValueError(f"point is not in front of face {face}")
    return (x / z, y / z)


def face_xy_to_vec3(face: int, x: float, y: float) -> tuple[float, float, float]:
    return normalize3(from_face_xyz(face, (x, y, 1.0)))


def lonlat_to_face_xy(
    lon: float,
    lat: float,
    face: int | None = None,
    offset: ProjectionOffset | Sequence[float] | None = None,
) -> FacePoint:
    p = oriented_lonlat_to_vec3(lon, lat, offset)
    face_idx = owning_face_for_vec3(p) if face is None else face
    x, y = vec3_to_face_xy(face_idx, p)
    return FacePoint(face_idx, x, y)


def face_xy_to_lonlat(
    face: int,
    x: float,
    y: float,
    offset: ProjectionOffset | Sequence[float] | None = None,
) -> tuple[float, float]:
    return oriented_vec3_to_lonlat(face_xy_to_vec3(face, x, y), offset)


def face_xy_to_pixel(x: float, y: float, size: float) -> tuple[float, float]:
    return ((x + 1.0) * 0.5 * size, (1.0 - y) * 0.5 * size)


def pixel_to_face_xy(px: float, py: float, size: float) -> tuple[float, float]:
    return (2.0 * px / size - 1.0, 1.0 - 2.0 * py / size)


def densify_lonlat_segment(
    a: Sequence[float],
    b: Sequence[float],
    max_step_deg: float = 2.0,
) -> list[tuple[float, float]]:
    """Return intermediate lon/lat samples along the straight lon/lat segment."""

    lon0, lat0 = a
    lon1, lat1 = b
    dlon = lon_delta(lon1, lon0)
    dlat = lat1 - lat0
    steps = max(1, int(math.ceil(max(abs(dlon), abs(dlat)) / max_step_deg)))
    out = []
    for i in range(steps + 1):
        t = i / steps
        out.append((normalize_lon_180(lon0 + dlon * t), lat0 + dlat * t))
    return out


def unwrap_lon(lon: float, reference: float) -> float:
    return reference + lon_delta(lon, reference)


def unwrap_ring(ring: Iterable[Sequence[float]], reference: float) -> list[tuple[float, float]]:
    return [(unwrap_lon(pt[0], reference), pt[1]) for pt in ring]


def lon_interval_overlap(a0: float, a1: float, b0: float, b1: float, eps: float = 1e-8) -> bool:
    """Return true if two short longitude intervals overlap by positive length."""

    ref = a0
    aa0 = unwrap_lon(a0, ref)
    aa1 = aa0 + ((a1 - a0) % 360.0)
    bb0 = unwrap_lon(b0, ref)
    bb1 = bb0 + ((b1 - b0) % 360.0)
    if aa1 - aa0 > 180.0:
        aa0, aa1 = aa1, aa0 + 360.0
    if bb1 - bb0 > 180.0:
        bb0, bb1 = bb1, bb0 + 360.0
    return min(aa1, bb1) - max(aa0, bb0) > eps
