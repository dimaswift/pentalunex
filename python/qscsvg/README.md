# qscsvg

Python utilities for generating SVG graticules, graticule cells, and eclipse-path
cell overlays on a Quadrilateralized Spherical Cube.

## CGRCS Coordinate Core

The package now exposes a Cube-Gnomonic Reference Coordinate System core in
`qscsvg.cgrcs`. This is the canonical coordinate layer for new tile/card
pipeline work:

- `ReferenceFrame.canonical("F" | "E" | "V", spin_index)` creates one of the
  18 canonical frames.
- `ReferenceFrame.from_projection_offset(lon, lat, roll)` preserves the
  existing browser/export offset behavior as a custom CGRCS frame.
- `project_to_cube()` and `unproject_from_cube()` convert between geographic
  points and face-local `u,v` coordinates.
- `enumerate_rhomb_addresses()` returns the de-duplicated corner-rhomb library:
  18 frames x 12 unique corner-face classes x 2 polarities = 432 cards.
- `enumerate_view_addresses()` includes the expanded view library:
  12 corner-face rhombs, 8 edge-centered side views, and 6 head-on face views
  per frame and polarity = 936 cards.

The gnomonic lensing is intentional. Individual frames are allowed to stretch or
dramatize regions; representation fairness comes from the complete canonical
frame ensemble.

The package intentionally uses the same face IDs as the JavaScript viewer:

- `0`: north pole
- `1`: equatorial face centered on lon 0
- `2`: equatorial face centered on lon 90E
- `3`: equatorial face centered on lon 180
- `4`: equatorial face centered on lon 270E
- `5`: south pole

## Cell Topology

The 30-degree graticule grid contains 112 cells:

- 4 equatorial faces x 16 cells
- 2 polar faces x 24 cells

Equatorial cell IDs are `CellId(face, col, row)`, where `col` is west-to-east
and `row` is south-to-north.

Polar cell IDs are `CellId(face, sector, ring)`, where `sector` is
`floor(lon / 30)` and `ring` is `0` for the outer ring or `1` for the inner
ring around the pole.

Adjacency is edge-only. Cells touching only at a vertex are not neighbors.

## Example

```python
from pathlib import Path

from qscsvg import (
    CLASSIC_CROSS_LAYOUT,
    adjacent_cells,
    best_iso_view_for_eclipse,
    cell_at_lonlat,
    cells_intersecting_geojson,
    get_eclipse,
    render_best_iso_eclipse_svg,
    render_best_iso_saros_svg,
    render_face_net_svg,
    render_face_svg,
)

cell = cell_at_lonlat(0, 0)
print(cell)
print(adjacent_cells(cell))

eclipse = get_eclipse(141, 21)
cells = cells_intersecting_geojson(eclipse["geometry"])
view = best_iso_view_for_eclipse(eclipse)

print(view.corner)
print(view.visible_faces)
print(view.touched_faces)

Path("face_1_path.svg").write_text(
    render_face_svg(
        1,
        eclipse_geometry=eclipse["geometry"],
        eclipse_width=8,
    ),
    encoding="utf-8",
)

Path("best_iso_all.svg").write_text(
    render_best_iso_eclipse_svg(
        eclipse,
        eclipse_width=8,
        hatch_spacing=24,
        hatch_angle=90,
    ),
    encoding="utf-8",
)

Path("best_iso_from_saros.svg").write_text(
    render_best_iso_saros_svg(
        141,
        21,
        eclipse_width=8,
        hatch_spacing=24,
        hatch_angle=90,
    ),
    encoding="utf-8",
)

Path("face_1_cells.svg").write_text(
    render_face_svg(
        1,
        cells=cells,
        hatch_spacing=24,
        hatch_angle=90,
    ),
    encoding="utf-8",
)

Path("classic_cross.svg").write_text(
    render_face_net_svg(
        CLASSIC_CROSS_LAYOUT,
        cells=cells,
        eclipse_geometry=eclipse["geometry"],
        hatch_spacing=24,
        hatch_angle=90,
    ),
    encoding="utf-8",
)
```

Run examples from the repo root with:

```bash
PYTHONPATH=python python3 python/test.py
```
