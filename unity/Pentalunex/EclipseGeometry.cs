// GeoJSON-compatible eclipse geometry. The JS reference loads paths from
// Saros bin files and feeds them straight into the renderer; in Unity we
// expect the caller to parse their own data into one of the concrete
// geometry types below before handing them to TileRenderer.
//
// Partial-only eclipse types (P / Pb / Pe / Tminus / Aminus / Aplus) have
// no central path; their polygons are drawn as outlines, not filled regions.

using System.Collections.Generic;

namespace Pentalunex {

public enum GeometryType { Polygon, MultiPolygon, LineString }

public abstract class EclipseGeometry {
    public abstract GeometryType Type { get; }
}

public sealed class PolygonGeometry : EclipseGeometry {
    public override GeometryType Type => GeometryType.Polygon;
    /// Outer ring at index 0; subsequent rings are holes (currently rendered
    /// as additional outlines — fill is not even-odd).
    public List<List<(double lon, double lat)>> Rings;
}

public sealed class MultiPolygonGeometry : EclipseGeometry {
    public override GeometryType Type => GeometryType.MultiPolygon;
    public List<List<List<(double lon, double lat)>>> Polygons;
}

public sealed class LineStringGeometry : EclipseGeometry {
    public override GeometryType Type => GeometryType.LineString;
    public List<(double lon, double lat)> Coordinates;
}

public static class EclipseTypes {
    /// Eclipse type codes that have no central totality / annular path —
    /// drawn as outline only.
    public static readonly HashSet<string> Partial = new HashSet<string> {
        "P", "Pb", "Pe", "Tminus", "Aminus", "Aplus",
    };

    public static bool IsPartial(string type) =>
        type != null && Partial.Contains(type);
}

/// Bin every vertex of a geometry into the cell on the face that owns it
/// (highest dot with face normal, mirroring the live hover-raycast logic).
/// Returns an array of 6 lists, one per face — convenient for the tile-game
/// to know which sectors to highlight on each face.
public static class EclipseCells {
    public static List<GraticuleCells.CellIndex>[] GetCellsByFace(
            EclipseGeometry geom, double step) {
        var sets = new HashSet<GraticuleCells.CellIndex>[6];
        for (int i = 0; i < 6; i++) sets[i] = new HashSet<GraticuleCells.CellIndex>();

        void Add(double lon, double lat) {
            int face = Projection.LonLatToFace(lon, lat);
            sets[face].Add(GraticuleCells.FindCellIndex(lon, lat, step));
        }

        switch (geom) {
            case PolygonGeometry pg:
                foreach (var ring in pg.Rings)
                    foreach (var (lon, lat) in ring) Add(lon, lat);
                break;
            case MultiPolygonGeometry mp:
                foreach (var poly in mp.Polygons)
                    foreach (var ring in poly)
                        foreach (var (lon, lat) in ring) Add(lon, lat);
                break;
            case LineStringGeometry ls:
                foreach (var (lon, lat) in ls.Coordinates) Add(lon, lat);
                break;
        }

        var result = new List<GraticuleCells.CellIndex>[6];
        for (int i = 0; i < 6; i++) result[i] = new List<GraticuleCells.CellIndex>(sets[i]);
        return result;
    }
}

}
