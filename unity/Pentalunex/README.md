# Pentalunex (Unity)

C# port of the Pentalunex core: COBE CSC face projection, graticule cell
indexing, eclipse-path rendering, and a `TileRenderer` that paints overlays
onto a `Texture2D`.

Map textures are **not** part of this port — pre-render them with the JS app
(`Export faces as PNG`) and load each face as a regular `Texture2D` in Unity
before handing it to `TileRenderer`.

## Files

| File                  | What it does                                          |
| --------------------- | ----------------------------------------------------- |
| `Projection.cs`       | Frame-based gnomonic projection, lon/lat ↔ pixel,     |
|                       | hemisphere clipping, face-of-(lon,lat) lookup         |
| `GraticuleCells.cs`   | Cell indexing, cell ring generation, pick at pixel    |
| `EclipseGeometry.cs`  | Polygon / MultiPolygon / LineString data classes,     |
|                       | partial-eclipse type set, per-face cell binner        |
| `TextureDraw.cs`      | Bresenham line + scanline polygon fill on `Color32[]` |
| `TileRenderer.cs`     | Public draw API for one face tile                     |

## Quick start

```csharp
using UnityEngine;
using Pentalunex;

public class TileExample : MonoBehaviour {
    public Texture2D faceMap;   // your pre-rendered face_2.png imported into Unity

    void Start() {
        // Assume faceMap was already blitted into a writable Texture2D.
        var tex = new Texture2D(faceMap.width, faceMap.height,
                                TextureFormat.RGBA32, mipChain: false);
        tex.SetPixels32(faceMap.GetPixels32());
        tex.Apply();

        var tr = new TileRenderer(tex, face: 2) { Mirrored = false };

        tr.DrawGraticule(step: 15, color: Color.white, width: 1, alpha: 0.5f);

        // (your eclipse data, parsed from a saros bin or JSON elsewhere)
        var geom = new PolygonGeometry { Rings = ... };
        tr.DrawEclipseGeometry(geom, type: "T",
            outline: Color.red, fill: Color.red, fillEnabled: true,
            width: 2, alpha: 0.9f);

        tr.DrawTouchedCells(geom, step: 15,
            fill:   new Color(1, 0.3f, 0.4f, 0.13f),
            stroke: new Color(1, 0.3f, 0.4f, 1f),
            width: 2, alpha: 0.5f);

        tr.Apply();   // single GPU upload
        GetComponent<Renderer>().material.mainTexture = tex;
    }
}
```

## Lookups

```csharp
// Tile pixel ↔ lon/lat (canvas Y convention: y=0 at top of the tile)
Projection.PixelToLonLat(face, px, py, N, out double lon, out double lat);
Projection.LonLatToPixel(face, lon, lat, N, out Vector2 pixel);

// Which face owns a (lon, lat) point?
int face = Projection.LonLatToFace(lon, lat);

// What graticule sector is at a given tile pixel?
var hit = GraticuleCells.GetCellAtPixel(face, px, py, N, step);
// → hit.LonIdx, hit.LatIdx, hit.Lon, hit.Lat, hit.Face
```

## Mirror & adjacency for the tile-game

`TileRenderer.Mirrored = true` flips every projected pixel along the vertical
centre axis. Apply the same flag when blitting your map texture (e.g. use
`Graphics.Blit` with a flipped UV) so the overlays line up.

For tile placement: a face's eastern edge at `(N, y)` corresponds to its
adjacent cube neighbour's western edge. With mirror enabled, a tile's eastern
edge becomes its western edge, which lets you place the same face image on
the opposite side of a neighbour and keep edges continuous.

## Y convention

Internally `Projection.ProjXY` returns canvas-style coords (y=0 at the top of
the tile). `TileRenderer` flips this to Unity's `Texture2D` (y=0 at bottom)
when writing pixels, so you can think purely in lon/lat for everything you
draw — the renderer handles the flip.

## Caveats

- `FillPolygon` doesn't implement even-odd / hole filling. Eclipse polygons
  with inner holes will get all rings filled. Easy to add if you need it.
- Lines are aliased Bresenham. For smoother output, render at 2× and
  downsample, or move the overlay layer to a `RenderTexture` driven by a
  shader.
- `(int, int)` line endpoints can overflow if a near-horizon point projects
  far outside the tile; `TextureDraw.DrawLine` has a safety cap on iterations
  but you'll waste cycles. The hemisphere clip in `Projection.ClipSegment`
  prevents the worst cases.
