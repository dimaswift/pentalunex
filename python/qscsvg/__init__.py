"""QSC graticule and eclipse-path SVG utilities."""

from .cells import (
    CellId,
    adjacent_cells,
    all_cells,
    cell_at_face_xy,
    cell_at_lonlat,
    cell_label,
    cell_ring_face_xy,
    cell_ring_lonlat,
    cells_for_face,
)
from .geometry import (
    FACE_NAMES,
    FacePoint,
    ProjectionOffset,
    face_xy_to_lonlat,
    face_xy_to_pixel,
    lonlat_to_face_xy,
    oriented_lonlat_to_vec3,
    oriented_vec3_to_lonlat,
    pixel_to_face_xy,
)
from .paths import cells_intersecting_face_polygon, cells_intersecting_geojson
from .saros import get_eclipse, load_saros
from .svg import CLASSIC_CROSS_LAYOUT, render_face_net_svg, render_face_svg, render_iso_face_svg, render_iso_svg
from .view import (
    IsoView,
    best_iso_view_for_cells,
    best_iso_view_for_eclipse,
    render_best_iso_eclipse_svg,
    render_best_iso_saros_svg,
    visible_faces_for_corner,
)


__all__ = [
    "CellId",
    "FACE_NAMES",
    "FacePoint",
    "IsoView",
    "ProjectionOffset",
    "CLASSIC_CROSS_LAYOUT",
    "adjacent_cells",
    "all_cells",
    "best_iso_view_for_cells",
    "best_iso_view_for_eclipse",
    "cell_at_face_xy",
    "cell_at_lonlat",
    "cell_label",
    "cell_ring_face_xy",
    "cell_ring_lonlat",
    "cells_for_face",
    "cells_intersecting_face_polygon",
    "cells_intersecting_geojson",
    "face_xy_to_lonlat",
    "face_xy_to_pixel",
    "get_eclipse",
    "load_saros",
    "lonlat_to_face_xy",
    "oriented_lonlat_to_vec3",
    "oriented_vec3_to_lonlat",
    "pixel_to_face_xy",
    "render_best_iso_eclipse_svg",
    "render_best_iso_saros_svg",
    "render_face_net_svg",
    "render_face_svg",
    "render_iso_face_svg",
    "render_iso_svg",
    "visible_faces_for_corner",
]
