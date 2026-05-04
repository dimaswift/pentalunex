//
// Graticule cell detection and highlighting.
// Port of js/graticule-cells.js — cells are uniform lat/lon rectangles of
// size `step × step` degrees. Each cell is identified by (lonIdx, latIdx)
// where lon0 = -180 + lonIdx*step, lat0 = -90 + latIdx*step.
//

#ifndef FRACTONICA_GRATICULE_CELLS_H
#define FRACTONICA_GRATICULE_CELLS_H

#include <cmath>
#include <cstdint>
#include "IDisplay.h"
#include "PathDrawer.h"
#include "Projection.h"
#include "Vector2.h"
#include "Vector3.h"

namespace Fractonica {

class GraticuleCells {
public:
    struct CellIndex { int lonIdx; int latIdx; };
    struct LonLatPoint { double lon; double lat; };

    // Cell ring is sampled with this many points per edge — same density as
    // js/graticule-cells.js (10 segments per side → 40 vertices per cell).
    static constexpr int EDGE_SAMPLES = 10;
    static constexpr int RING_VERTICES = 4 * EDGE_SAMPLES;

    // Snap a lon/lat point to the (lonIdx, latIdx) of its enclosing cell.
    static CellIndex findCell(double lon, double lat, double step) {
        CellIndex c;
        c.lonIdx = static_cast<int>(std::floor((lon + 180.0) / step));
        c.latIdx = static_cast<int>(std::floor((lat +  90.0) / step));
        return c;
    }

    // Pixel (col,row) on a face's N×N canvas → lon/lat. Inverse of projXY
    // followed by reprojection back to world space. Useful for hit-testing.
    static LonLatPoint pixelToLonLat(int face, int px, int py, int N) {
        // Reverse of Projection::projXY:
        //   px = (1 + x/z)/2 * N  →  x/z = 2*px/N - 1
        //   py = (1 - y/z)/2 * N  →  y/z = 1 - 2*py/N
        const double x = 2.0 * px / N - 1.0;
        const double y = 1.0 - 2.0 * py / N;
        const double z = 1.0;

        const double len = std::sqrt(x * x + y * y + z * z);
        const Vector3 local{x / len, y / len, z / len};
        const Vector3 world = Projection::fromFaceXYZ(face, local);

        LonLatPoint out;
        out.lon = std::atan2(world.y, world.x) / Projection::DEG;
        double zc = world.z;
        if (zc >  1.0) zc =  1.0;
        if (zc < -1.0) zc = -1.0;
        out.lat = std::asin(zc) / Projection::DEG;
        return out;
    }

    // Build the lon/lat ring for a single cell — bottom, right, top, left
    // edges, densified so gnomonic distortion stays smooth.
    static void buildCellRing(int lonIdx, int latIdx, double step,
                              PathDrawer::LonLat* out /*[RING_VERTICES]*/) {
        const double lon0 = -180.0 + lonIdx * step;
        const double lon1 = lon0 + step;
        const double lat0 =  -90.0 + latIdx * step;
        const double lat1 = lat0 + step;

        int k = 0;
        // Bottom edge (lat = lat0), going east.
        for (int i = 0; i < EDGE_SAMPLES; ++i) {
            const double t = static_cast<double>(i) / EDGE_SAMPLES;
            out[k++] = {lon0 + (lon1 - lon0) * t, lat0};
        }
        // Right edge (lon = lon1), going north.
        for (int i = 0; i < EDGE_SAMPLES; ++i) {
            const double t = static_cast<double>(i) / EDGE_SAMPLES;
            out[k++] = {lon1, lat0 + (lat1 - lat0) * t};
        }
        // Top edge (lat = lat1), going west.
        for (int i = 0; i < EDGE_SAMPLES; ++i) {
            const double t = static_cast<double>(i) / EDGE_SAMPLES;
            out[k++] = {lon1 - (lon1 - lon0) * t, lat1};
        }
        // Left edge (lon = lon0), going south.
        for (int i = 0; i < EDGE_SAMPLES; ++i) {
            const double t = static_cast<double>(i) / EDGE_SAMPLES;
            out[k++] = {lon0, lat1 - (lat1 - lat0) * t};
        }
    }

    // Outline a single graticule cell on the given face.
    static void drawCell(IDisplay& display,
                         int face,
                         int lonIdx, int latIdx,
                         double step,
                         int16_t thickness,
                         uint32_t color) {
        PathDrawer::LonLat ring[RING_VERTICES];
        buildCellRing(lonIdx, latIdx, step, ring);
        PathDrawer::drawClosedPath(display, face, ring, RING_VERTICES,
                                   thickness, color);
    }

    // Outline the cell that contains a given lon/lat. Convenience wrapper.
    static void drawCellAt(IDisplay& display,
                           int face,
                           double lon, double lat,
                           double step,
                           int16_t thickness,
                           uint32_t color) {
        const CellIndex c = findCell(lon, lat, step);
        drawCell(display, face, c.lonIdx, c.latIdx, step, thickness, color);
    }
};

} // namespace Fractonica

#endif // FRACTONICA_GRATICULE_CELLS_H
