// Frame-based gnomonic projection for the COBE Quadrilateralised Spherical
// Cube. Each face has an orthonormal (East, North, Normal) frame; a sphere
// point is rotated into the frame and projected as (X/Z, Y/Z). Pixel coords
// follow canvas convention (y=0 at the top of the tile) — TileRenderer flips
// to Unity's bottom-up Y when writing into Texture2D.
//
// Face numbering matches the JavaScript reference:
//   0  North pole  (+Z)
//   1  +X  (lon =   0°)
//   2  +Y  (lon =  90°)
//   3  -X  (lon = 180°)
//   4  -Y  (lon = 270°)
//   5  South pole  (-Z)

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Pentalunex {

public static class Projection {
    public const double DEG = Math.PI / 180.0;

    // Clip plane just inside the visible hemisphere — keeps the gnomonic
    // division finite and matches the JS clipping window.
    public const float CLIP_EPS = 0.02f;

    public struct FaceFrame {
        public Vector3 East, North, Normal;
        public FaceFrame(Vector3 e, Vector3 n, Vector3 nm) {
            East = e; North = n; Normal = nm;
        }
    }

    public static readonly FaceFrame[] FACE_FRAMES = new FaceFrame[] {
        new FaceFrame(new Vector3( 0,  1,  0), new Vector3(-1,  0,  0), new Vector3( 0,  0,  1)), // 0  N pole
        new FaceFrame(new Vector3( 0,  1,  0), new Vector3( 0,  0,  1), new Vector3( 1,  0,  0)), // 1  +X
        new FaceFrame(new Vector3(-1,  0,  0), new Vector3( 0,  0,  1), new Vector3( 0,  1,  0)), // 2  +Y
        new FaceFrame(new Vector3( 0, -1,  0), new Vector3( 0,  0,  1), new Vector3(-1,  0,  0)), // 3  -X
        new FaceFrame(new Vector3( 1,  0,  0), new Vector3( 0,  0,  1), new Vector3( 0, -1,  0)), // 4  -Y
        new FaceFrame(new Vector3( 0, -1,  0), new Vector3(-1,  0,  0), new Vector3( 0,  0, -1)), // 5  S pole
    };

    public static readonly string[] FACE_NAMES = {
        "North Pole", "+X (0°)", "+Y (90°E)", "-X (180°)", "-Y (270°E)", "South Pole",
    };

    // ── Forward projection: lon/lat → 3D → face XYZ → pixel ──────────────────

    public static Vector3 LonLatTo3D(double lon, double lat) {
        double la = lat * DEG, lo = lon * DEG;
        double cl = Math.Cos(la);
        return new Vector3((float)(cl * Math.Cos(lo)), (float)(cl * Math.Sin(lo)), (float)Math.Sin(la));
    }

    /// Rotate a sphere point into the face's local (east, north, normal) frame.
    /// In the result, z is the projection onto the face normal — clip with
    /// ClipSegment / ClipRing to drop points that are off the visible hemisphere.
    public static Vector3 ToFaceXYZ(int face, Vector3 p) {
        var f = FACE_FRAMES[face];
        return new Vector3(
            Vector3.Dot(p, f.East),
            Vector3.Dot(p, f.North),
            Vector3.Dot(p, f.Normal)
        );
    }

    /// Gnomonic projection of a face-local 3D point into pixel coords.
    /// Returns canvas-convention (px, py): py=0 at top of the tile, py=N at bottom.
    public static Vector2 ProjXY(Vector3 p, int N) {
        return new Vector2(
            (1f + p.x / p.z) * 0.5f * N,
            (1f - p.y / p.z) * 0.5f * N
        );
    }

    // ── Inverse projection: pixel → face → 3D → lon/lat ──────────────────────

    /// Reverse of ProjXY + ToFaceXYZ. Pixel coords are canvas-convention.
    public static void PixelToLonLat(int face, double px, double py, int N,
                                     out double lon, out double lat) {
        double x = 2.0 * px / N - 1.0;
        double y = 1.0 - 2.0 * py / N;
        double z = 1.0;
        double len = Math.Sqrt(x * x + y * y + z * z);
        double nx = x / len, ny = y / len, nz = z / len;
        var f = FACE_FRAMES[face];
        double pxw = nx * f.East.x  + ny * f.North.x  + nz * f.Normal.x;
        double pyw = nx * f.East.y  + ny * f.North.y  + nz * f.Normal.y;
        double pzw = nx * f.East.z  + ny * f.North.z  + nz * f.Normal.z;
        lon = Math.Atan2(pyw, pxw) / DEG;
        lat = Math.Asin(Math.Max(-1, Math.Min(1, pzw))) / DEG;
    }

    /// Find which cube face owns a (lon, lat) point — same logic the live
    /// hover-raycast uses: highest dot product with the face normal.
    public static int LonLatToFace(double lon, double lat) {
        var p = LonLatTo3D(lon, lat);
        float maxDot = float.NegativeInfinity;
        int owner = 0;
        for (int f = 0; f < 6; f++) {
            float d = Vector3.Dot(p, FACE_FRAMES[f].Normal);
            if (d > maxDot) { maxDot = d; owner = f; }
        }
        return owner;
    }

    /// Project (lon, lat) directly onto a face's pixel grid, clipping to the
    /// visible hemisphere. Returns false if the point is behind the face plane
    /// (z < CLIP_EPS), in which case `pixel` is undefined.
    public static bool LonLatToPixel(int face, double lon, double lat, int N, out Vector2 pixel) {
        var p3 = ToFaceXYZ(face, LonLatTo3D(lon, lat));
        if (p3.z < CLIP_EPS) { pixel = default; return false; }
        pixel = ProjXY(p3, N);
        return true;
    }

    // ── Hemisphere clipping ──────────────────────────────────────────────────

    /// Sutherland-Hodgman clip of a closed ring against z >= CLIP_EPS.
    public static List<Vector3> ClipRing(IList<Vector3> ring) {
        var result = new List<Vector3>(ring.Count + 4);
        if (ring.Count == 0) return result;
        var prev = ring[ring.Count - 1];
        bool prevIn = prev.z >= CLIP_EPS;
        foreach (var cur in ring) {
            bool curIn = cur.z >= CLIP_EPS;
            if (curIn) {
                if (!prevIn) result.Add(InterpZ(prev, cur));
                result.Add(cur);
            } else if (prevIn) {
                result.Add(InterpZ(prev, cur));
            }
            prev = cur; prevIn = curIn;
        }
        return result;
    }

    /// Clip one segment against z >= CLIP_EPS. Returns false if both endpoints
    /// are behind the visible hemisphere.
    public static bool ClipSegment(Vector3 a, Vector3 b, out Vector3 outA, out Vector3 outB) {
        bool aIn = a.z >= CLIP_EPS, bIn = b.z >= CLIP_EPS;
        if (aIn && bIn) { outA = a; outB = b; return true; }
        if (!aIn && !bIn) { outA = outB = default; return false; }
        var ip = InterpZ(a, b);
        if (aIn) { outA = a;  outB = ip; } else { outA = ip; outB = b; }
        return true;
    }

    static Vector3 InterpZ(Vector3 a, Vector3 b) {
        float t = (CLIP_EPS - a.z) / (b.z - a.z);
        return new Vector3(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), CLIP_EPS);
    }
}

}
