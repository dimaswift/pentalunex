"""Best-view helpers for eclipse paths on the QSC cube."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .cells import CellId
from .paths import cells_intersecting_geojson
from .saros import get_eclipse
from .svg import render_iso_svg


@dataclass(frozen=True)
class IsoView:
    corner: int
    visible_faces: tuple[int, int, int]
    touched_faces: tuple[int, ...]
    cells: tuple[CellId, ...]
    visible_cell_count: int


def visible_faces_for_corner(corner: int) -> tuple[int, int, int]:
    if not 0 <= corner <= 7:
        raise ValueError("corner must be 0..7")
    sx = 1 if corner & 1 else -1
    sy = 1 if corner & 2 else -1
    sz = 1 if corner & 4 else -1
    return (
        0 if sy > 0 else 5,
        1 if sz > 0 else 3,
        2 if sx > 0 else 4,
    )


def _geometry_from_eclipse(eclipse: dict[str, Any]) -> dict[str, Any]:
    return eclipse.get("geometry", eclipse)


def _hemisphere_counts(cells: Iterable[CellId]) -> tuple[int, int]:
    above = 0
    below = 0
    for cell in cells:
        if cell.face == 0:
            above += 1
        elif cell.face == 5:
            below += 1
        elif cell.b <= 1:
            below += 1
        else:
            above += 1
    return above, below


def best_iso_view_for_cells(cells: Iterable[CellId]) -> IsoView:
    cell_tuple = tuple(cells)
    touched_faces = tuple(sorted({cell.face for cell in cell_tuple}))
    above, below = _hemisphere_counts(cell_tuple)
    preferred_pole = 5 if below > above else 0

    best_corner = 0
    best_key = (-1, -1, 0)
    for corner in range(8):
        visible = visible_faces_for_corner(corner)
        visible_count = sum(1 for cell in cell_tuple if cell.face in visible)
        pole_bonus = 1 if preferred_pole in visible else 0
        # Third item keeps ties stable by choosing the lower corner index.
        key = (visible_count, pole_bonus, -corner)
        if key > best_key:
            best_key = key
            best_corner = corner

    visible = visible_faces_for_corner(best_corner)
    return IsoView(
        corner=best_corner,
        visible_faces=visible,
        touched_faces=touched_faces,
        cells=cell_tuple,
        visible_cell_count=sum(1 for cell in cell_tuple if cell.face in visible),
    )


def best_iso_view_for_eclipse(
    eclipse: dict[str, Any],
    *,
    samples_per_edge: int = 10,
    max_step_deg: float = 0.5,
    min_area: float = 1e-9,
) -> IsoView:
    geometry = _geometry_from_eclipse(eclipse)
    cells = cells_intersecting_geojson(
        geometry,
        samples_per_edge=samples_per_edge,
        max_step_deg=max_step_deg,
        min_area=min_area,
    )
    return best_iso_view_for_cells(cells)


def render_best_iso_eclipse_svg(
    eclipse: dict[str, Any],
    *,
    include_cells: bool = True,
    include_path: bool = True,
    samples_per_edge: int = 10,
    max_step_deg: float = 0.5,
    min_area: float = 1e-9,
    **render_kwargs: Any,
) -> str:
    geometry = _geometry_from_eclipse(eclipse)
    view = best_iso_view_for_eclipse(
        eclipse,
        samples_per_edge=samples_per_edge,
        max_step_deg=max_step_deg,
        min_area=min_area,
    )
    return render_iso_svg(
        cells=view.cells if include_cells else None,
        eclipse_geometry=geometry if include_path else None,
        corner=view.corner,
        samples_per_edge=samples_per_edge,
        eclipse_max_step_deg=max_step_deg,
        **render_kwargs,
    )


def render_best_iso_saros_svg(
    saros_number: int,
    position: int,
    *,
    data_dir: str | None = None,
    **kwargs: Any,
) -> str:
    eclipse = get_eclipse(saros_number, position, data_dir=data_dir)
    return render_best_iso_eclipse_svg(eclipse, **kwargs)
