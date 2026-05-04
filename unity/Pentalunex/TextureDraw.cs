// Software rasteriser for Color32[] buffers — Bresenham line + scanline
// polygon fill, with source-over alpha blending. Used by TileRenderer to
// paint overlays on top of map textures.
//
// Performance is fine for the tile sizes a tile-game needs (a 1024×1024 tile
// with full graticule + a couple of eclipses takes a few ms on desktop). For
// hot loops or > 4k tiles, switch to a GPU path (RenderTexture + a shader).

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Pentalunex {

public static class TextureDraw {

    /// Bresenham line with a stamped square brush of side `thickness`.
    /// All coordinates are in the buffer's native (y=0 at bottom for Unity)
    /// convention — TileRenderer flips canvas-y for you.
    public static void DrawLine(Color32[] pixels, int w, int h,
                                int x0, int y0, int x1, int y1,
                                Color32 color, int thickness) {
        int dx = Math.Abs(x1 - x0);
        int dy = -Math.Abs(y1 - y0);
        int sx = x0 < x1 ? 1 : -1;
        int sy = y0 < y1 ? 1 : -1;
        int err = dx + dy;
        int r = Math.Max(0, (thickness - 1) / 2);
        // Cap iterations so a stray near-horizon segment can't hang the thread.
        int safety = (Math.Abs(x1 - x0) + Math.Abs(y1 - y0) + 4) * 2;
        while (safety-- > 0) {
            Stamp(pixels, w, h, x0, y0, r, color);
            if (x0 == x1 && y0 == y1) break;
            int e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }

    /// Stroke a polyline (open or closed — caller must repeat the first
    /// vertex at the end if a closed outline is desired).
    public static void StrokePolyline(Color32[] pixels, int w, int h,
                                      IList<Vector2> pts, Color32 color, int thickness) {
        for (int i = 0; i + 1 < pts.Count; i++) {
            DrawLine(pixels, w, h,
                (int)Math.Round(pts[i].x),     (int)Math.Round(pts[i].y),
                (int)Math.Round(pts[i + 1].x), (int)Math.Round(pts[i + 1].y),
                color, thickness);
        }
    }

    /// Scanline fill of a single ring. No even-odd / hole support — call
    /// once per ring if you need multi-ring polygons.
    public static void FillPolygon(Color32[] pixels, int w, int h,
                                   IList<Vector2> pts, Color32 color) {
        int n = pts.Count;
        if (n < 3) return;
        float minY = pts[0].y, maxY = pts[0].y;
        for (int i = 1; i < n; i++) {
            if (pts[i].y < minY) minY = pts[i].y;
            if (pts[i].y > maxY) maxY = pts[i].y;
        }
        int yStart = Math.Max(0, (int)Math.Ceiling(minY));
        int yEnd   = Math.Min(h - 1, (int)Math.Floor(maxY));
        var xs = new List<float>(8);
        for (int y = yStart; y <= yEnd; y++) {
            xs.Clear();
            for (int i = 0; i < n; i++) {
                var p1 = pts[i];
                var p2 = pts[(i + 1) % n];
                // Half-open interval — count an edge only when crossing
                // strictly upward or downward, never both.
                if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
                    float x = p1.x + (y - p1.y) / (p2.y - p1.y) * (p2.x - p1.x);
                    xs.Add(x);
                }
            }
            xs.Sort();
            for (int i = 0; i + 1 < xs.Count; i += 2) {
                int xa = Math.Max(0, (int)Math.Round(xs[i]));
                int xb = Math.Min(w - 1, (int)Math.Round(xs[i + 1]));
                int row = y * w;
                for (int x = xa; x <= xb; x++) BlendIndex(pixels, row + x, color);
            }
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    static void Stamp(Color32[] pixels, int w, int h, int cx, int cy, int r, Color32 color) {
        if (r == 0) { Blend(pixels, w, h, cx, cy, color); return; }
        int r2 = r * r;
        for (int dy = -r; dy <= r; dy++) {
            int yy = cy + dy;
            if (yy < 0 || yy >= h) continue;
            int row = yy * w;
            for (int dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy > r2) continue;
                int xx = cx + dx;
                if (xx < 0 || xx >= w) continue;
                BlendIndex(pixels, row + xx, color);
            }
        }
    }

    static void Blend(Color32[] pixels, int w, int h, int x, int y, Color32 src) {
        if (x < 0 || x >= w || y < 0 || y >= h) return;
        BlendIndex(pixels, y * w + x, src);
    }

    /// Source-over alpha blend assuming opaque destination is the common case.
    /// Using integer arithmetic; no premultiplied-alpha conversion. Good enough
    /// for overlay rendering on map tiles.
    static void BlendIndex(Color32[] pixels, int i, Color32 src) {
        var dst = pixels[i];
        int sa = src.a;
        if (sa == 0) return;
        if (sa == 255 && dst.a == 0) { pixels[i] = src; return; }
        int ia = 255 - sa;
        int outA = sa + dst.a * ia / 255;
        pixels[i] = new Color32(
            (byte)((src.r * sa + dst.r * ia) / 255),
            (byte)((src.g * sa + dst.g * ia) / 255),
            (byte)((src.b * sa + dst.b * ia) / 255),
            (byte)(outA > 255 ? 255 : outA)
        );
    }
}

}
