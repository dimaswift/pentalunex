//
// Draw a lon/lat polyline onto a single cube face via an IDisplay.
// Port of drawPolylineOnFace in js/projection.js: each segment is rotated
// into face-local space, clipped against the visible hemisphere, then
// rasterised with IDisplay::drawLine.
//

#ifndef FRACTONICA_PATH_DRAWER_H
#define FRACTONICA_PATH_DRAWER_H

#include <cstddef>
#include <cstdint>
#include "IDisplay.h"
#include "Projection.h"
#include "Vector2.h"
#include "Vector3.h"

namespace Fractonica {

class PathDrawer {
public:
    // A single lon/lat pair in degrees. Lon ∈ [-180, 180], Lat ∈ [-90, 90].
    struct LonLat {
        double lon;
        double lat;
    };

    // Draw `points` as a polyline on the given cube face.
    // `display` provides the face's render target (size N×N comes from
    // display.size()). Segments outside the face's hemisphere are dropped;
    // segments crossing the horizon are clipped.
    static void drawPath(IDisplay& display,
                         int face,
                         const LonLat* points,
                         std::size_t count,
                         int16_t thickness,
                         uint32_t color) {
        if (count < 2 || points == nullptr) return;

        const int N = display.size().x; // faces are square — width == height
        if (N <= 0) return;

        Vector3 prev = Projection::toFaceXYZ(
            face, Projection::lonLatTo3D(points[0].lon, points[0].lat));

        for (std::size_t i = 1; i < count; ++i) {
            const Vector3 cur = Projection::toFaceXYZ(
                face, Projection::lonLatTo3D(points[i].lon, points[i].lat));

            Vector3 a, b;
            if (Projection::clipSegment(prev, cur, a, b)) {
                const Vector2 pa = Projection::toPixel(a, N);
                const Vector2 pb = Projection::toPixel(b, N);
                if (pa != pb) {
                    display.drawLine(pa, pb, thickness, color);
                }
            }
            prev = cur;
        }
    }

    // Convenience overload for closed paths — appends the first point
    // implicitly so the polygon outline closes cleanly.
    static void drawClosedPath(IDisplay& display,
                               int face,
                               const LonLat* points,
                               std::size_t count,
                               int16_t thickness,
                               uint32_t color) {
        if (count < 2 || points == nullptr) return;
        drawPath(display, face, points, count, thickness, color);

        // Close the loop: last → first.
        const Vector3 last = Projection::toFaceXYZ(
            face, Projection::lonLatTo3D(points[count - 1].lon, points[count - 1].lat));
        const Vector3 first = Projection::toFaceXYZ(
            face, Projection::lonLatTo3D(points[0].lon, points[0].lat));

        Vector3 a, b;
        if (Projection::clipSegment(last, first, a, b)) {
            const int N = display.size().x;
            const Vector2 pa = Projection::toPixel(a, N);
            const Vector2 pb = Projection::toPixel(b, N);
            if (pa != pb) display.drawLine(pa, pb, thickness, color);
        }
    }
};

} // namespace Fractonica

#endif // FRACTONICA_PATH_DRAWER_H
