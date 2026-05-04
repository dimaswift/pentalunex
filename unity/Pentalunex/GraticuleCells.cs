// Graticule sector indexing: turn (lon, lat) into a (lonIdx, latIdx) cell at
// a given step, generate the lon/lat ring of a cell for drawing, and look up
// the cell at any pixel of a face tile.

using System;
using System.Collections.Generic;

namespace Pentalunex {

public static class GraticuleCells {

    public struct CellIndex : IEquatable<CellIndex> {
        public int LonIdx, LatIdx;
        public CellIndex(int lonIdx, int latIdx) { LonIdx = lonIdx; LatIdx = latIdx; }
        public bool Equals(CellIndex o) => LonIdx == o.LonIdx && LatIdx == o.LatIdx;
        public override bool Equals(object o) => o is CellIndex c && Equals(c);
        public override int GetHashCode() => (LonIdx * 397) ^ LatIdx;
    }

    public struct CellHit {
        public int Face;
        public double Lon, Lat;
        public int LonIdx, LatIdx;
    }

    /// Snap a (lon, lat) point to its containing graticule cell.
    public static CellIndex FindCellIndex(double lon, double lat, double step) {
        return new CellIndex(
            (int)Math.Floor((lon + 180.0) / step),
            (int)Math.Floor((lat + 90.0)  / step)
        );
    }

    /// Lon/lat polyline tracing the four edges of a graticule cell.
    /// Each edge is densely sampled (10 sub-segments) so that gnomonic
    /// projection on a cube face stays smooth — a cell that crosses the
    /// horizon won't degenerate into a straight line.
    public static List<(double lon, double lat)> GenerateCellRing(
            int lonIdx, int latIdx, double step) {
        double lon0 = -180.0 + lonIdx * step;
        double lon1 = lon0 + step;
        double lat0 = -90.0  + latIdx * step;
        double lat1 = lat0 + step;
        var ring = new List<(double, double)>(40);

        for (int i = 0; i <= 10; i++) {
            double lon = lon0 + (lon1 - lon0) * i / 10.0;
            ring.Add((lon, lat0));
        }
        for (int i = 1; i <= 10; i++) {
            double lat = lat0 + (lat1 - lat0) * i / 10.0;
            ring.Add((lon1, lat));
        }
        for (int i = 9; i >= 0; i--) {
            double lon = lon0 + (lon1 - lon0) * i / 10.0;
            ring.Add((lon, lat1));
        }
        for (int i = 9; i >= 1; i--) {
            double lat = lat0 + (lat1 - lat0) * i / 10.0;
            ring.Add((lon0, lat));
        }
        return ring;
    }

    /// Inverse-project a tile pixel through a face and return the cell at
    /// that point. (px, py) are in canvas convention (y=0 at the top).
    public static CellHit GetCellAtPixel(int face, double px, double py, int N, double step) {
        Projection.PixelToLonLat(face, px, py, N, out double lon, out double lat);
        var cell = FindCellIndex(lon, lat, step);
        return new CellHit {
            Face = face, Lon = lon, Lat = lat,
            LonIdx = cell.LonIdx, LatIdx = cell.LatIdx,
        };
    }
}

}
