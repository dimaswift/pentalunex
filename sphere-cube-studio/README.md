# Sphere Cube Studio

Dependency-free browser workbench for the Pentalunex sphere-to-cube topology.

This first pass focuses on the core coordinate system:

- spherical `lon/lat` to gnomonic cube face `UV`
- cube face `UV` back to spherical `lon/lat`
- 6 isometric face tiles, one per cube face
- default sphere orientation with poles at opposite cube vertices
- recursive triangular subdivision address:
  - face index
  - root triangle polarity
  - 2-bit child path
  - barycentric coordinate in the terminal triangle
- face-edge adjacency and conservative triangle-neighbor probing
- canvas graticule rendering across the 6 face atlas
- configurable projection anchor offsets for lon/lat/roll
- SVG/PNG triangle export with optional coastline border and graticule layers
- all-triangle ZIP export with progress and topology manifest
- constructor tab for grid-locked triangle painting from a seed key, mirrored mode, shift-delete, and SVG/PNG/JSON export

Run locally:

```sh
python3 -m http.server 5173 --directory sphere-cube-studio
```

Then open `http://localhost:5173`.

Run math tests:

```sh
cd sphere-cube-studio
npm test
```
