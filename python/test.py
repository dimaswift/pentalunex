from pathlib import Path

from qscsvg import (
    CLASSIC_CROSS_LAYOUT,
    adjacent_cells,
    best_iso_view_for_eclipse,
    cell_at_lonlat,
    get_eclipse,
    render_best_iso_eclipse_svg,
    render_face_net_svg,
    render_face_svg,
    render_iso_svg,
)


def main() -> None:
    out_dir = Path(__file__).resolve().parent

    cell = cell_at_lonlat(0, 0)
    print("cell at lon=0 lat=0:", cell)
    print("edge neighbors:", adjacent_cells(cell))

    eclipse = get_eclipse(141, 22)
    view = best_iso_view_for_eclipse(eclipse, samples_per_edge=6,      
    lon_offset=45,
    lat_offset=35.2643897,
    roll_offset=-45)
    cells = list(view.cells)
    print(
        f"Saros 141 position 22: {eclipse['datetime_utc']} "
        f"{eclipse['type']} intersects {len(cells)} cells"
    )
    print(
        f"best corner {view.corner}: visible faces {view.visible_faces}, "
        f"touched faces {view.touched_faces}"
    )
    face = view.touched_faces[0]

    (out_dir / f"example_face{face}_path.svg").write_text(
        render_face_svg(
            face,
            eclipse_geometry=eclipse["geometry"],
            size=900,
            eclipse_fill="#ff5a6d66",
            eclipse_stroke="#ff5a6d",
            eclipse_width=8,
            grid_stroke="#707070",
        ),
        encoding="utf-8",
    )
    (out_dir / "example_best_iso_path.svg").write_text(
        render_iso_svg(
            eclipse_geometry=eclipse["geometry"],
            corner=view.corner,
            scale=900,
            eclipse_fill="#ff5a6d66",
            eclipse_stroke="#ff5a6d",
            eclipse_width=1,
            grid_stroke="#707070",
            cells=cells,
            hatch_spacing=24,
            hatch_angle=90
        ),
        encoding="utf-8",
    )

    (out_dir / f"example_face{face}_cells.svg").write_text(
        render_face_svg(
            face,
            cells=cells,
            size=900,
            selected_fill="#d21f3c22",
            selected_stroke="#d21f3c",
            hatch_spacing=24,
            hatch_angle=90,
        ),
        encoding="utf-8",
    )

    (out_dir / "example_best_iso_cells.svg").write_text(
        render_iso_svg(
            cells=cells,
            corner=view.corner,
            scale=900,
            selected_fill="#d21f3c22",
            selected_stroke="#d21f3c",
            hatch_spacing=24,
            hatch_angle=90,
        ),
        encoding="utf-8",
    )

    (out_dir / "example_best_iso_all.svg").write_text(
        render_best_iso_eclipse_svg(
            eclipse,
            scale=900,
            selected_fill="#d21f3c22",
            selected_stroke="#d21f3c",
            eclipse_fill="#ff5a6d66",
            eclipse_stroke="#ff5a6d",
            hatch_spacing=24,
            hatch_angle=90,
        ),
        encoding="utf-8",
    )

    (out_dir / "example_cross_net.svg").write_text(
        render_face_net_svg(
            CLASSIC_CROSS_LAYOUT,
            cells=cells,
            eclipse_geometry=eclipse["geometry"],
            size=500,
            selected_fill="#d21f3c22",
            selected_stroke="#d21f3c",
            eclipse_fill="#ff5a6d66",
            eclipse_stroke="#ff5a6d",
            hatch_spacing=18,
            hatch_angle=90,
        ),
        encoding="utf-8",
    )

    from qscsvg import render_iso_face_svg, export_tile_sandbox_zip

    (out_dir / "example_single_face.svg").write_text(render_iso_face_svg(
        face,
        cells=cells,
        eclipse_geometry=eclipse["geometry"],
        selected_fill="#d21f3c22",
        selected_stroke="#d21f3c",
        eclipse_fill="#ff5a6d66",
        eclipse_stroke="#ff5a6d",
        hatch_spacing=18,
        hatch_angle=90,
        corner=view.corner,
        lon_offset=45,
        lat_offset=45,
        roll_offset=-0,
    ))

    export_tile_sandbox_zip(
    "tiles.zip",
    scale=1000,
    lon_offset=45,
    lat_offset=35.2643897,
    roll_offset=-45,
    cells=cells,
    eclipse_geometry=eclipse["geometry"],
    hatch_parallel_edge="left",
    selected_fill="#d21f3c22",
    selected_stroke="#d21f3c",
    eclipse_fill="#ff5a6d66",
    eclipse_stroke="#ff5a6d",
    hatch_spacing=18,
)
if __name__ == "__main__":
    main()
