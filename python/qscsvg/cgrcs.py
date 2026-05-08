"""Cube-Gnomonic Reference Coordinate System core.

This module is the stable coordinate layer for the tile/card pipeline. It keeps
gnomonic distortion as a first-class property: each reference frame is a lawful
lens, and fairness comes from deterministic frame-family enumeration.

CGRCS v1 intentionally preserves the face IDs and face-local axes already used
by the JavaScript/Python renderers:

    0 = +Z / north-pole face
    1 = +X
    2 = +Y
    3 = -X
    4 = -Y
    5 = -Z / south-pole face
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Literal, Sequence


SYSTEM_VERSION = "CGRCS:v1"
EPS = 1e-10
FACE_CLIP_EPS = 0.02
DEG = math.pi / 180.0
RAD = 180.0 / math.pi

PoleClass = Literal["F", "E", "V"]
Polarity = Literal["Terra", "Umbra"]
BoundaryClass = Literal["interior", "edge", "vertex"]
ViewFamily = Literal["corner_face", "edge", "face"]

Vec3 = tuple[float, float, float]
Point = tuple[float, float]
Matrix3 = tuple[Vec3, Vec3, Vec3]

FACE_CODES = ("+Z", "+X", "+Y", "-X", "-Y", "-Z")
FACE_ID_BY_CODE = {code: idx for idx, code in enumerate(FACE_CODES)}
FACE_NAMES = (
    "North Pole",
    "+X (0)",
    "+Y (90E)",
    "-X (180)",
    "-Y (270E)",
    "South Pole",
)

# Face frames match qscsvg.geometry and js/projection.js. The first two frame
# axes are face-local u/v; the third is the face normal.
FACE_FRAMES = (
    {"u": (0.0, 1.0, 0.0), "v": (-1.0, 0.0, 0.0), "normal": (0.0, 0.0, 1.0)},
    {"u": (0.0, 1.0, 0.0), "v": (0.0, 0.0, 1.0), "normal": (1.0, 0.0, 0.0)},
    {"u": (-1.0, 0.0, 0.0), "v": (0.0, 0.0, 1.0), "normal": (0.0, 1.0, 0.0)},
    {"u": (0.0, -1.0, 0.0), "v": (0.0, 0.0, 1.0), "normal": (-1.0, 0.0, 0.0)},
    {"u": (1.0, 0.0, 0.0), "v": (0.0, 0.0, 1.0), "normal": (0.0, -1.0, 0.0)},
    {"u": (0.0, -1.0, 0.0), "v": (-1.0, 0.0, 0.0), "normal": (0.0, 0.0, -1.0)},
)

POLE_DIRECTIONS: dict[PoleClass, Vec3] = {
    "F": (0.0, 0.0, 1.0),
    "E": (1.0 / math.sqrt(2.0), 0.0, 1.0 / math.sqrt(2.0)),
    "V": (1.0 / math.sqrt(3.0), 1.0 / math.sqrt(3.0), 1.0 / math.sqrt(3.0)),
}

SPIN_DEGREES = (0.0, 15.0, 30.0, 45.0, 60.0, 75.0)
ISO_VIEWS = ("+++", "++-", "+-+", "+--", "-++", "-+-", "--+", "---")
EDGE_VIEW_CODES = ("E+++", "E++-", "E+-+", "E+--", "E-++", "E-+-", "E--+", "E---")
HEAD_ON_VIEW_CODES = ("F+Z", "F+X", "F+Y", "F-X", "F-Y", "F-Z")

# Existing corner exports produce 8 * 3 = 24 face/rhomb assets, but orientation
# normalization collapses them into two rotation classes per cube face. Each
# group lists equivalent (corner, face) exports; the first pair is canonical.
CORNER_FACE_GROUPS: tuple[tuple[tuple[int, int], ...], ...] = (
    ((2, 0), (6, 0)),
    ((3, 0), (7, 0)),
    ((4, 1), (7, 1)),
    ((5, 1), (6, 1)),
    ((1, 2), (7, 2)),
    ((3, 2), (5, 2)),
    ((0, 3), (3, 3)),
    ((1, 3), (2, 3)),
    ((0, 4), (6, 4)),
    ((2, 4), (4, 4)),
    ((0, 5), (4, 5)),
    ((1, 5), (5, 5)),
)
UNIQUE_CORNER_FACE_PAIRS = tuple(group[0] for group in CORNER_FACE_GROUPS)
CORNER_FACE_CANONICAL = {
    pair: group[0]
    for group in CORNER_FACE_GROUPS
    for pair in group
}


@dataclass(frozen=True)
class GeoPoint:
    lat_deg: float
    lon_deg: float


@dataclass(frozen=True)
class ReferenceFrame:
    pole_class: PoleClass | str
    spin_index: int | None
    spin_deg: float
    matrix: Matrix3
    inverse_matrix: Matrix3
    code: str
    kind: str = "canonical"

    @classmethod
    def canonical(cls, pole_class: PoleClass, spin_index: int) -> "ReferenceFrame":
        return make_reference_frame(pole_class, spin_index)

    @classmethod
    def from_projection_offset(
        cls,
        lon: float = 0.0,
        lat: float = 0.0,
        roll: float = 0.0,
    ) -> "ReferenceFrame":
        return reference_frame_from_projection_offset(lon, lat, roll)

    def to_manifest(self) -> dict[str, object]:
        return {
            "system": SYSTEM_VERSION,
            "kind": self.kind,
            "code": self.code,
            "pole_class": self.pole_class,
            "spin_index": self.spin_index,
            "spin_deg": self.spin_deg,
            "matrix": [[round(v, 12) for v in row] for row in self.matrix],
            "inverse_matrix": [[round(v, 12) for v in row] for row in self.inverse_matrix],
        }


@dataclass(frozen=True)
class CubePoint:
    frame: ReferenceFrame
    face: int
    u: float
    v: float
    cube_vector: Vec3
    sphere_vector: Vec3
    boundary: BoundaryClass
    seam_faces: tuple[int, ...]

    @property
    def face_code(self) -> str:
        return FACE_CODES[self.face]

    def address(self, polarity: Polarity = "Terra") -> str:
        return (
            f"{SYSTEM_VERSION}/{self.frame.code}/{self.face_code}/{polarity}/"
            f"u={self.u:.6f}/v={self.v:.6f}"
        )


@dataclass(frozen=True, order=True)
class GraticuleCell:
    face: int
    lon_idx: int
    lat_idx: int

    def key(self) -> str:
        return f"{self.face}:{self.lon_idx}:{self.lat_idx}"


@dataclass(frozen=True)
class RhombAddress:
    frame: str
    iso_view: str
    face: int
    polarity: Polarity = "Terra"

    @property
    def face_code(self) -> str:
        return FACE_CODES[self.face]

    def code(self) -> str:
        short_polarity = "T" if self.polarity == "Terra" else "U"
        return f"{self.frame}-I{self.iso_view}-{self.face_code}-{short_polarity}"


@dataclass(frozen=True)
class ViewState:
    family: ViewFamily
    code: str
    visible_faces: tuple[int, ...]
    corner: int | None = None
    face: int | None = None
    canonical_pair: tuple[int, int] | None = None


@dataclass(frozen=True)
class ViewAddress:
    frame: str
    view: ViewState
    polarity: Polarity = "Terra"

    def code(self) -> str:
        short_polarity = "T" if self.polarity == "Terra" else "U"
        return f"{self.frame}-{self.view.code}-{short_polarity}"


@dataclass(frozen=True)
class FaceSegment:
    face: int
    points: tuple[CubePoint, ...]


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def normalize_lon_180(lon: float) -> float:
    value = ((lon + 180.0) % 360.0) - 180.0
    return 180.0 if value == -180.0 else value


def lon_delta(lon: float, center: float) -> float:
    return ((lon - center + 180.0) % 360.0) - 180.0


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Sequence[float], b: Sequence[float]) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def norm(a: Sequence[float]) -> float:
    return math.sqrt(dot(a, a))


def normalize3(a: Sequence[float]) -> Vec3:
    length = norm(a)
    if length <= EPS:
        raise ValueError("cannot normalize zero-length vector")
    return (a[0] / length, a[1] / length, a[2] / length)


def identity_matrix() -> Matrix3:
    return ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))


def transpose_matrix(m: Matrix3) -> Matrix3:
    return (
        (m[0][0], m[1][0], m[2][0]),
        (m[0][1], m[1][1], m[2][1]),
        (m[0][2], m[1][2], m[2][2]),
    )


def mat_vec(m: Matrix3, p: Sequence[float]) -> Vec3:
    return (
        m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
        m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
        m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
    )


def mat_mul(a: Matrix3, b: Matrix3) -> Matrix3:
    bt = transpose_matrix(b)
    return tuple(
        tuple(dot(row, col) for col in bt)  # type: ignore[misc]
        for row in a
    )  # type: ignore[return-value]


def rotation_matrix(axis: Sequence[float], angle_deg: float) -> Matrix3:
    ax = normalize3(axis)
    x, y, z = ax
    angle = angle_deg * DEG
    c = math.cos(angle)
    s = math.sin(angle)
    t = 1.0 - c
    return (
        (t * x * x + c, t * x * y - s * z, t * x * z + s * y),
        (t * x * y + s * z, t * y * y + c, t * y * z - s * x),
        (t * x * z - s * y, t * y * z + s * x, t * z * z + c),
    )


def rotate_x_matrix(deg: float) -> Matrix3:
    a = deg * DEG
    c = math.cos(a)
    s = math.sin(a)
    return ((1.0, 0.0, 0.0), (0.0, c, -s), (0.0, s, c))


def rotate_y_matrix(deg: float) -> Matrix3:
    a = deg * DEG
    c = math.cos(a)
    s = math.sin(a)
    return ((c, 0.0, s), (0.0, 1.0, 0.0), (-s, 0.0, c))


def rotate_z_matrix(deg: float) -> Matrix3:
    a = deg * DEG
    c = math.cos(a)
    s = math.sin(a)
    return ((c, -s, 0.0), (s, c, 0.0), (0.0, 0.0, 1.0))


def align_vectors_matrix(source: Sequence[float], target: Sequence[float]) -> Matrix3:
    a = normalize3(source)
    b = normalize3(target)
    d = clamp(dot(a, b), -1.0, 1.0)
    if abs(d - 1.0) <= EPS:
        return identity_matrix()
    if abs(d + 1.0) <= EPS:
        fallback = (1.0, 0.0, 0.0) if abs(a[0]) < 0.9 else (0.0, 1.0, 0.0)
        return rotation_matrix(cross(a, fallback), 180.0)
    axis = cross(a, b)
    angle = math.acos(d) * RAD
    return rotation_matrix(axis, angle)


def geo_to_vector(point: GeoPoint | Sequence[float]) -> Vec3:
    if isinstance(point, GeoPoint):
        lat = point.lat_deg
        lon = point.lon_deg
    else:
        lat = float(point[0])
        lon = float(point[1])
    la = lat * DEG
    lo = lon * DEG
    c = math.cos(la)
    return (c * math.cos(lo), c * math.sin(lo), math.sin(la))


def vector_to_geo(vector: Sequence[float]) -> GeoPoint:
    p = normalize3(vector)
    lat = math.asin(clamp(p[2], -1.0, 1.0)) * RAD
    lon = math.atan2(p[1], p[0]) * RAD
    return GeoPoint(lat, normalize_lon_180(lon))


def make_reference_frame(pole_class: PoleClass, spin_index: int) -> ReferenceFrame:
    if pole_class not in POLE_DIRECTIONS:
        raise ValueError("pole_class must be one of F, E, V")
    if not 0 <= int(spin_index) <= 5:
        raise ValueError("spin_index must be 0..5")

    spin = SPIN_DEGREES[int(spin_index)]
    pole_axis = POLE_DIRECTIONS[pole_class]
    align = align_vectors_matrix((0.0, 0.0, 1.0), pole_axis)
    spin_matrix = rotation_matrix(pole_axis, spin)
    matrix = mat_mul(spin_matrix, align)
    code = f"{pole_class}{int(spin)}"
    return ReferenceFrame(
        pole_class=pole_class,
        spin_index=int(spin_index),
        spin_deg=spin,
        matrix=matrix,
        inverse_matrix=transpose_matrix(matrix),
        code=code,
        kind="canonical",
    )


def reference_frame_from_projection_offset(
    lon: float = 0.0,
    lat: float = 0.0,
    roll: float = 0.0,
) -> ReferenceFrame:
    matrix = mat_mul(rotate_x_matrix(roll), mat_mul(rotate_y_matrix(lat), rotate_z_matrix(lon)))
    code = f"offset({lon:g},{lat:g},{roll:g})"
    return ReferenceFrame(
        pole_class="custom",
        spin_index=None,
        spin_deg=float(roll),
        matrix=matrix,
        inverse_matrix=transpose_matrix(matrix),
        code=code,
        kind="projection_offset",
    )


def reference_frame_from_offset(offset: object | Sequence[float] | None = None) -> ReferenceFrame:
    if offset is None:
        return reference_frame_from_projection_offset()
    lon = getattr(offset, "lon", None)
    lat = getattr(offset, "lat", None)
    roll = getattr(offset, "roll", None)
    if lon is not None and lat is not None:
        return reference_frame_from_projection_offset(float(lon), float(lat), float(roll or 0.0))
    values = list(offset)  # type: ignore[arg-type]
    if len(values) == 2:
        return reference_frame_from_projection_offset(float(values[0]), float(values[1]), 0.0)
    if len(values) == 3:
        return reference_frame_from_projection_offset(float(values[0]), float(values[1]), float(values[2]))
    raise ValueError("projection offset must be None, an object with lon/lat/roll, or a 2/3-value sequence")


def enumerate_reference_frames() -> list[ReferenceFrame]:
    return [
        make_reference_frame(pole_class, spin_index)
        for pole_class in ("F", "E", "V")
        for spin_index in range(6)
    ]


def face_xyz(face: int, p: Sequence[float]) -> Vec3:
    frame = FACE_FRAMES[face]
    return (
        dot(p, frame["u"]),
        dot(p, frame["v"]),
        dot(p, frame["normal"]),
    )


def face_xy_to_cube_vector(face: int, u: float, v: float) -> Vec3:
    frame = FACE_FRAMES[face]
    uu = frame["u"]
    vv = frame["v"]
    nn = frame["normal"]
    return normalize3((
        uu[0] * u + vv[0] * v + nn[0],
        uu[1] * u + vv[1] * v + nn[1],
        uu[2] * u + vv[2] * v + nn[2],
    ))


def dominant_faces(vector: Sequence[float], eps: float = EPS) -> tuple[int, ...]:
    scores = [dot(vector, frame["normal"]) for frame in FACE_FRAMES]
    best = max(scores)
    return tuple(idx for idx, score in enumerate(scores) if abs(score - best) <= eps)


def owning_face(vector: Sequence[float], eps: float = EPS) -> int:
    return dominant_faces(vector, eps=eps)[0]


def classify_face_location(u: float, v: float, eps: float = EPS) -> BoundaryClass:
    on_u = abs(abs(u) - 1.0) <= eps
    on_v = abs(abs(v) - 1.0) <= eps
    if on_u and on_v:
        return "vertex"
    if on_u or on_v:
        return "edge"
    return "interior"


def project_to_cube(point: GeoPoint | Sequence[float], frame: ReferenceFrame) -> CubePoint:
    sphere = geo_to_vector(point)
    cube = mat_vec(frame.matrix, sphere)
    face = owning_face(cube)
    x, y, z = face_xyz(face, cube)
    if z <= EPS:
        raise ValueError("projected point is not in front of selected face")
    u = x / z
    v = y / z
    return CubePoint(
        frame=frame,
        face=face,
        u=u,
        v=v,
        cube_vector=cube,
        sphere_vector=sphere,
        boundary=classify_face_location(u, v),
        seam_faces=dominant_faces(cube),
    )


def project_lonlat_to_cube(lon: float, lat: float, frame: ReferenceFrame) -> CubePoint:
    return project_to_cube(GeoPoint(lat, lon), frame)


def unproject_from_cube(face: int, u: float, v: float, frame: ReferenceFrame) -> GeoPoint:
    cube = face_xy_to_cube_vector(face, u, v)
    sphere = mat_vec(frame.inverse_matrix, cube)
    return vector_to_geo(sphere)


def projected_xy_on_face(
    face: int,
    lon: float,
    lat: float,
    frame: ReferenceFrame,
) -> tuple[float, float, float]:
    cube = mat_vec(frame.matrix, geo_to_vector(GeoPoint(lat, lon)))
    return face_xyz(face, cube)


def densify_lonlat_segment(
    a: Sequence[float],
    b: Sequence[float],
    max_step_deg: float = 2.0,
) -> list[Point]:
    lon0, lat0 = a
    lon1, lat1 = b
    dlon = lon_delta(lon1, lon0)
    dlat = lat1 - lat0
    steps = max(1, int(math.ceil(max(abs(dlon), abs(dlat)) / max_step_deg)))
    return [
        (normalize_lon_180(lon0 + dlon * i / steps), lat0 + dlat * i / steps)
        for i in range(steps + 1)
    ]


def densify_lonlat_ring(ring: Sequence[Sequence[float]], max_step_deg: float) -> list[Point]:
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


def interp_z(a: Sequence[float], b: Sequence[float], eps: float = FACE_CLIP_EPS) -> Vec3:
    t = (eps - a[2]) / (b[2] - a[2])
    return (
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
        eps,
    )


def clip_ring_z(ring: Sequence[Sequence[float]], eps: float = FACE_CLIP_EPS) -> list[Vec3]:
    if not ring:
        return []
    out: list[Vec3] = []
    prev = ring[-1]
    prev_in = prev[2] >= eps
    for cur in ring:
        cur_in = cur[2] >= eps
        if cur_in:
            if not prev_in:
                out.append(interp_z(prev, cur, eps))
            out.append((cur[0], cur[1], cur[2]))
        elif prev_in:
            out.append(interp_z(prev, cur, eps))
        prev = cur
        prev_in = cur_in
    return out


def clip_polygon_to_face(points: Sequence[Point]) -> list[Point]:
    def clip_against_edge(points_in, inside, intersect):
        if not points_in:
            return []
        output = []
        prev = points_in[-1]
        prev_inside = inside(prev)
        for curr in points_in:
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


def project_lonlat_ring_to_face_xy(
    face: int,
    ring: Sequence[Sequence[float]],
    frame: ReferenceFrame,
    *,
    max_step_deg: float = 0.5,
    clip_to_face: bool = True,
) -> list[Point]:
    ring3 = [
        projected_xy_on_face(face, lon, lat, frame)
        for lon, lat in densify_lonlat_ring(ring, max_step_deg)
    ]
    points = []
    for p in clip_ring_z(ring3):
        u = p[0] / p[2]
        v = p[1] / p[2]
        if math.isfinite(u) and math.isfinite(v):
            points.append((u, v))
    return clip_polygon_to_face(points) if clip_to_face else points


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
        ring.append((lon0 + (lon1 - lon0) * i / 10.0, lat0))
    for i in range(1, 11):
        ring.append((lon1, lat0 + (lat1 - lat0) * i / 10.0))
    for i in range(9, -1, -1):
        ring.append((lon0 + (lon1 - lon0) * i / 10.0, lat1))
    for i in range(9, 0, -1):
        ring.append((lon0, lat0 + (lat1 - lat0) * i / 10.0))
    return ring


def graticule_cell_face_xy(
    cell: GraticuleCell,
    step: float,
    frame: ReferenceFrame,
) -> list[Point]:
    ring = graticule_cell_lonlat_ring(cell.lon_idx, cell.lat_idx, step)
    return project_lonlat_ring_to_face_xy(
        cell.face,
        ring,
        frame,
        max_step_deg=step / 10.0,
        clip_to_face=True,
    )


def get_visible_faces(view: str) -> tuple[int, int, int]:
    if view not in ISO_VIEWS:
        raise ValueError(f"view must be one of {ISO_VIEWS}")
    sx, sy, sz = view
    return (
        FACE_ID_BY_CODE["+X" if sx == "+" else "-X"],
        FACE_ID_BY_CODE["+Y" if sy == "+" else "-Y"],
        FACE_ID_BY_CODE["+Z" if sz == "+" else "-Z"],
    )


def canonical_corner_face_pair(corner: int, face: int) -> tuple[int, int]:
    try:
        return CORNER_FACE_CANONICAL[(int(corner), int(face))]
    except KeyError as exc:
        raise ValueError(f"face {face} is not visible from corner {corner}") from exc


def is_canonical_corner_face_pair(corner: int, face: int) -> bool:
    return canonical_corner_face_pair(corner, face) == (int(corner), int(face))


def _sign_char(value: str) -> str:
    if value not in ("+", "-"):
        raise ValueError("view signs must be '+' or '-'")
    return value


def get_edge_view_visible_faces(view: str) -> tuple[int, int]:
    if view not in EDGE_VIEW_CODES:
        raise ValueError(f"edge view must be one of {EDGE_VIEW_CODES}")
    sx = _sign_char(view[1])
    sy = _sign_char(view[2])
    return (
        FACE_ID_BY_CODE["+X" if sx == "+" else "-X"],
        FACE_ID_BY_CODE["+Y" if sy == "+" else "-Y"],
    )


def get_head_on_visible_faces(view: str) -> tuple[int]:
    if view not in HEAD_ON_VIEW_CODES:
        raise ValueError(f"head-on view must be one of {HEAD_ON_VIEW_CODES}")
    return (FACE_ID_BY_CODE[view[1:]],)


def enumerate_unique_corner_face_views() -> list[ViewState]:
    out = []
    for corner, face in UNIQUE_CORNER_FACE_PAIRS:
        iso = ISO_VIEWS[corner]
        out.append(ViewState(
            family="corner_face",
            code=f"I{iso}-{FACE_CODES[face]}",
            visible_faces=(face,),
            corner=corner,
            face=face,
            canonical_pair=(corner, face),
        ))
    return out


def enumerate_edge_views() -> list[ViewState]:
    return [
        ViewState(
            family="edge",
            code=code,
            visible_faces=get_edge_view_visible_faces(code),
        )
        for code in EDGE_VIEW_CODES
    ]


def enumerate_head_on_views() -> list[ViewState]:
    return [
        ViewState(
            family="face",
            code=code,
            visible_faces=get_head_on_visible_faces(code),
            face=get_head_on_visible_faces(code)[0],
        )
        for code in HEAD_ON_VIEW_CODES
    ]


def enumerate_view_states(
    *,
    include_corner_faces: bool = True,
    include_edge_views: bool = True,
    include_head_on_faces: bool = True,
) -> list[ViewState]:
    out: list[ViewState] = []
    if include_corner_faces:
        out.extend(enumerate_unique_corner_face_views())
    if include_edge_views:
        out.extend(enumerate_edge_views())
    if include_head_on_faces:
        out.extend(enumerate_head_on_views())
    return out


def make_rhomb_address(
    frame: ReferenceFrame,
    iso_view: str,
    face: int,
    polarity: Polarity = "Terra",
) -> RhombAddress:
    visible = get_visible_faces(iso_view)
    if face not in visible:
        raise ValueError(f"face {face} is not visible in I{iso_view}")
    return RhombAddress(frame=frame.code, iso_view=iso_view, face=face, polarity=polarity)


def enumerate_rhomb_addresses(
    *,
    include_polarities: bool = True,
) -> list[RhombAddress]:
    polarities: tuple[Polarity, ...] = ("Terra", "Umbra") if include_polarities else ("Terra",)
    out: list[RhombAddress] = []
    for frame in enumerate_reference_frames():
        for corner, face in UNIQUE_CORNER_FACE_PAIRS:
            iso_view = ISO_VIEWS[corner]
            for polarity in polarities:
                out.append(RhombAddress(frame=frame.code, iso_view=iso_view, face=face, polarity=polarity))
    return out


def enumerate_view_addresses(
    *,
    include_polarities: bool = True,
    include_corner_faces: bool = True,
    include_edge_views: bool = True,
    include_head_on_faces: bool = True,
) -> list[ViewAddress]:
    polarities: tuple[Polarity, ...] = ("Terra", "Umbra") if include_polarities else ("Terra",)
    views = enumerate_view_states(
        include_corner_faces=include_corner_faces,
        include_edge_views=include_edge_views,
        include_head_on_faces=include_head_on_faces,
    )
    return [
        ViewAddress(frame=frame.code, view=view, polarity=polarity)
        for frame in enumerate_reference_frames()
        for view in views
        for polarity in polarities
    ]


def project_polyline(
    points: Iterable[GeoPoint | Sequence[float]],
    frame: ReferenceFrame,
) -> list[CubePoint]:
    return [project_to_cube(point, frame) for point in points]


def split_at_cube_seams(points: Sequence[CubePoint]) -> list[FaceSegment]:
    if not points:
        return []
    segments: list[FaceSegment] = []
    current_face = points[0].face
    current = [points[0]]
    for point in points[1:]:
        if point.face != current_face:
            segments.append(FaceSegment(current_face, tuple(current)))
            current_face = point.face
            current = [point]
        else:
            current.append(point)
    segments.append(FaceSegment(current_face, tuple(current)))
    return segments


def cgrcs_manifest() -> dict[str, object]:
    return {
        "system": SYSTEM_VERSION,
        "projection": "cube gnomonic",
        "face_convention": "qscsvg/js-compatible",
        "face_codes": {str(idx): code for idx, code in enumerate(FACE_CODES)},
        "canonical_frames": [frame.code for frame in enumerate_reference_frames()],
        "iso_views": list(ISO_VIEWS),
        "view_families": {
            "corner_face": {
                "description": "orientation-normalized corner-view rhombs; 24 corner/face exports collapse to 12 rotation classes",
                "unique_count": len(UNIQUE_CORNER_FACE_PAIRS),
                "canonical_pairs": [
                    {"corner": corner, "face": face, "view": f"I{ISO_VIEWS[corner]}", "face_code": FACE_CODES[face]}
                    for corner, face in UNIQUE_CORNER_FACE_PAIRS
                ],
                "equivalence_groups": [
                    [
                        {"corner": corner, "face": face}
                        for corner, face in group
                    ]
                    for group in CORNER_FACE_GROUPS
                ],
            },
            "edge": {
                "description": "side views with a cube edge centered; two faces visible",
                "unique_count": len(EDGE_VIEW_CODES),
                "views": [
                    {"code": code, "visible_faces": get_edge_view_visible_faces(code)}
                    for code in EDGE_VIEW_CODES
                ],
            },
            "face": {
                "description": "head-on single-face views",
                "unique_count": len(HEAD_ON_VIEW_CODES),
                "views": [
                    {"code": code, "visible_faces": get_head_on_visible_faces(code)}
                    for code in HEAD_ON_VIEW_CODES
                ],
            },
        },
        "polarity": {
            "Terra": "normal orientation",
            "Umbra": "canonical local mirror reserved as a polarity layer",
        },
        "distortion_policy": (
            "gnomonic lensing is preserved per frame; representation fairness "
            "comes from the complete canonical frame ensemble"
        ),
        "canonical_corner_rhomb_count": len(enumerate_rhomb_addresses(include_polarities=True)),
        "canonical_view_state_count": len(enumerate_view_states()),
        "canonical_view_card_count": len(enumerate_view_addresses(include_polarities=True)),
    }
