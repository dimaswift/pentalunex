// Public drawing API for one face tile. Mirrors js/tile-render.js but drives
// a Unity Texture2D directly via a Color32[] back buffer:
//
//   var tr = new TileRenderer(tex, face: 2) { Mirrored = false };
//   tr.DrawGraticule(step: 15, color: Color.white, width: 1, alpha: 0.5f);
//   tr.DrawEclipseGeometry(geom, type, outline, fill, fillEnabled: true,
//                          width: 2, alpha: 0.9f);
//   tr.DrawCell(lonIdx, latIdx, step: 15,
//               fill: new Color(1, 0.3f, 0.4f, 0.13f),
//               stroke: new Color(1, 0.3f, 0.4f, 1f),
//               width: 2, alpha: 0.5f);
//   tr.Apply();   // single GPU upload at the end
//
// Mirror is applied on every projected pixel coord, so the map texture you
// loaded into `tex` beforehand and every overlay drawn through this renderer
// stay mutually consistent — exactly what the tile-game's mirror placement
// relies on for continuous edges across cube neighbours.
//
// Y convention: gnomonic ProjXY returns canvas-style (y=0 at top of tile);
// this renderer flips to Unity's y=0-at-bottom Texture2D layout when writing.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Pentalunex {

public class TileRenderer {
    readonly Texture2D _texture;
    readonly Color32[] _pixels;
    readonly int _N;
    readonly int _face;

    /// Flip every drawn pixel along the vertical centre axis. Match this to
    /// the same flag you used when blitting the source map texture.
    public bool Mirrored { get; set; }

    public int Face => _face;
    public int Size => _N;

    public TileRenderer(Texture2D texture, int face) {
        if (texture == null) throw new ArgumentNullException(nameof(texture));
        if (texture.width != texture.height)
            throw new ArgumentException("TileRenderer requires a square texture.");
        if (face < 0 || face > 5)
            throw new ArgumentOutOfRangeException(nameof(face), "face must be 0..5");
        _texture = texture;
        _N       = texture.width;
        _face    = face;
        _pixels  = texture.GetPixels32();
    }

    /// Push the buffered pixels back to the GPU texture. Call once after a
    /// batch of draws.
    public void Apply() {
        _texture.SetPixels32(_pixels);
        _texture.Apply();
    }

    /// Discard pending edits and re-read from the texture (e.g. after the
    /// caller blitted a fresh map background).
    public void Reload() {
        var fresh = _texture.GetPixels32();
        Array.Copy(fresh, _pixels, fresh.Length);
    }

    /// Direct access to the back buffer for callers that want to clear the
    /// tile or composite a custom layer before drawing overlays.
    public Color32[] PixelBuffer => _pixels;

    // ── Graticule ────────────────────────────────────────────────────────────

    /// Parallels and meridians at `step` degrees, plus the equator (when
    /// `step > 1`) and the face boundary rectangle.
    public void DrawGraticule(double step, Color color, float width, float alpha) {
        var c = ToColor32(color, alpha);
        int thickness = Math.Max(1, Mathf.RoundToInt(width));
        var ring = new List<(double, double)>(721);

        // parallels
        for (double lat = -90 + step; lat < 90; lat += step) {
            ring.Clear();
            for (double lon = -180; lon <= 180; lon += 0.5) ring.Add((lon, lat));
            DrawLonLatPolyline(ring, c, thickness);
        }
        // meridians
        for (double lon = -180; lon < 180; lon += step) {
            ring.Clear();
            for (double lat = -90; lat <= 90; lat += 0.5) ring.Add((lon, lat));
            DrawLonLatPolyline(ring, c, thickness);
        }
        if (step > 1) {
            ring.Clear();
            for (double lon = -180; lon <= 180; lon += 0.5) ring.Add((lon, 0));
            DrawLonLatPolyline(ring, c, thickness);
        }

        // Face boundary — great-circle arcs project as straight lines in
        // gnomonic, so a pixel-space rectangle is exact. Mirror is symmetric
        // here so we ignore it.
        TextureDraw.DrawLine(_pixels, _N, _N, 0,    0,    _N-1, 0,    c, thickness);
        TextureDraw.DrawLine(_pixels, _N, _N, _N-1, 0,    _N-1, _N-1, c, thickness);
        TextureDraw.DrawLine(_pixels, _N, _N, _N-1, _N-1, 0,    _N-1, c, thickness);
        TextureDraw.DrawLine(_pixels, _N, _N, 0,    _N-1, 0,    0,    c, thickness);
    }

    // ── Eclipse paths ────────────────────────────────────────────────────────

    /// Draw an eclipse geometry. For partial-type eclipses (P/Pb/Pe/Tminus/...)
    /// `fill` is ignored and the polygons are drawn as outlines. For total or
    /// annular eclipses, the polygons are filled (when `fillEnabled`) and
    /// outlined. LineString geometry is always stroked.
    public void DrawEclipseGeometry(EclipseGeometry geom, string type,
                                    Color outline, Color fill, bool fillEnabled,
                                    float width, float alpha) {
        if (geom == null) return;
        bool partial = EclipseTypes.IsPartial(type);
        var oCol = ToColor32(outline, alpha);
        Color32? fCol = (!partial && fillEnabled) ? (Color32?)ToColor32(fill, alpha) : null;
        int thickness = Math.Max(1, Mathf.RoundToInt(width));

        switch (geom) {
            case PolygonGeometry pg:
                foreach (var ring in pg.Rings) DrawRing(ring, partial, fCol, oCol, thickness);
                break;
            case MultiPolygonGeometry mp:
                foreach (var poly in mp.Polygons)
                    foreach (var ring in poly) DrawRing(ring, partial, fCol, oCol, thickness);
                break;
            case LineStringGeometry ls:
                DrawLonLatPolyline(ls.Coordinates, oCol, thickness);
                break;
        }
    }

    void DrawRing(IList<(double, double)> ring, bool asOutlineOnly,
                  Color32? fill, Color32 stroke, int thickness) {
        if (asOutlineOnly) DrawLonLatPolyline(ring, stroke, thickness);
        else DrawLonLatPolygon(ring, fill, stroke, thickness);
    }

    // ── Sectors / cell highlight ─────────────────────────────────────────────

    /// Highlight one graticule cell on the current face. If the cell isn't
    /// visible on this face (clips to nothing) the call is a no-op.
    /// `fill` / `stroke` may be null to disable that part.
    public void DrawCell(int lonIdx, int latIdx, double step,
                         Color? fill, Color? stroke, float width, float alpha) {
        var ring = GraticuleCells.GenerateCellRing(lonIdx, latIdx, step);
        Color32? f = fill.HasValue   ? (Color32?)ToColor32(fill.Value,   alpha) : null;
        Color32? s = stroke.HasValue ? (Color32?)ToColor32(stroke.Value, alpha) : null;
        DrawLonLatPolygon(ring, f, s, Math.Max(1, Mathf.RoundToInt(width)));
    }

    /// Convenience: every cell touched by an eclipse geometry on this face,
    /// using EclipseCells.GetCellsByFace under the hood.
    public void DrawTouchedCells(EclipseGeometry geom, double step,
                                 Color? fill, Color? stroke, float width, float alpha) {
        var cellsByFace = EclipseCells.GetCellsByFace(geom, step);
        foreach (var cell in cellsByFace[_face])
            DrawCell(cell.LonIdx, cell.LatIdx, step, fill, stroke, width, alpha);
    }

    // ── Internal: project lon/lat to mirrored Unity-Y pixels and draw ────────

    void DrawLonLatPolyline(IList<(double lon, double lat)> coords,
                            Color32 color, int thickness) {
        if (coords.Count < 2) return;
        var prev3 = Projection.ToFaceXYZ(_face,
            Projection.LonLatTo3D(coords[0].lon, coords[0].lat));
        for (int i = 1; i < coords.Count; i++) {
            var cur3 = Projection.ToFaceXYZ(_face,
                Projection.LonLatTo3D(coords[i].lon, coords[i].lat));
            if (Projection.ClipSegment(prev3, cur3, out var a, out var b)) {
                var pa = ProjectPixelInt(a);
                var pb = ProjectPixelInt(b);
                TextureDraw.DrawLine(_pixels, _N, _N, pa.x, pa.y, pb.x, pb.y, color, thickness);
            }
            prev3 = cur3;
        }
    }

    void DrawLonLatPolygon(IList<(double lon, double lat)> ring,
                           Color32? fill, Color32? stroke, int thickness) {
        var ring3 = new List<Vector3>(ring.Count);
        foreach (var (lon, lat) in ring)
            ring3.Add(Projection.ToFaceXYZ(_face, Projection.LonLatTo3D(lon, lat)));
        var clipped = Projection.ClipRing(ring3);
        if (clipped.Count < 3) return;

        var pts = new Vector2[clipped.Count];
        for (int i = 0; i < clipped.Count; i++) pts[i] = ProjectPixel(clipped[i]);

        if (fill.HasValue) TextureDraw.FillPolygon(_pixels, _N, _N, pts, fill.Value);
        if (stroke.HasValue) {
            var closed = new Vector2[pts.Length + 1];
            Array.Copy(pts, closed, pts.Length);
            closed[pts.Length] = pts[0];
            TextureDraw.StrokePolyline(_pixels, _N, _N, closed, stroke.Value, thickness);
        }
    }

    Vector2 ProjectPixel(Vector3 fp) {
        var v = Projection.ProjXY(fp, _N);
        return new Vector2(MirrorX(v.x), CanvasYToTexY(v.y));
    }

    Vector2Int ProjectPixelInt(Vector3 fp) {
        var v = ProjectPixel(fp);
        return new Vector2Int(Mathf.RoundToInt(v.x), Mathf.RoundToInt(v.y));
    }

    float MirrorX(float px)        => Mirrored ? _N - px : px;
    float CanvasYToTexY(float py)  => _N - py;

    static Color32 ToColor32(Color c, float alphaMul) {
        return new Color32(
            (byte)Mathf.RoundToInt(Mathf.Clamp01(c.r) * 255f),
            (byte)Mathf.RoundToInt(Mathf.Clamp01(c.g) * 255f),
            (byte)Mathf.RoundToInt(Mathf.Clamp01(c.b) * 255f),
            (byte)Mathf.RoundToInt(Mathf.Clamp01(c.a * alphaMul) * 255f)
        );
    }
}

}
