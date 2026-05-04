//
// Graticule overlay: parallels + meridians at a configurable angular step.
// Port of js/graticule.js. Each parallel/meridian is sampled at 0.5° and
// drawn as a polyline on the requested face. The face boundary is drawn
// in pixel space — face edges are great-circle arcs which project as
// straight lines under gnomonic, so a pixel-space rectangle is exact.
//

#ifndef FRACTONICA_GRATICULE_H
#define FRACTONICA_GRATICULE_H

#include <cstdint>
#include "IDisplay.h"
#include "PathDrawer.h"

namespace Fractonica {

class Graticule {
public:
    // Sampling step along each line, in degrees. Matches js/graticule.js.
    static constexpr double SAMPLE_STEP_DEG = 0.5;
    // Maximum samples for a 360° sweep at SAMPLE_STEP_DEG (= 721 with the
    // inclusive endpoint). Sized for a parallel; meridians use 361.
    static constexpr int MAX_SAMPLES = 721;

    // Draw parallels every `stepDeg` (excluding the poles), meridians every
    // `stepDeg`, plus the equator if stepDeg > 1°, plus the face outline.
    static void drawGraticule(IDisplay& display,
                              int face,
                              double stepDeg,
                              int16_t thickness,
                              uint32_t color) {
        if (stepDeg <= 0.0) return;

        PathDrawer::LonLat buf[MAX_SAMPLES];

        // Parallels: lat ∈ (-90 + step, 90), longitudes -180..180 inclusive.
        for (double lat = -90.0 + stepDeg; lat < 90.0; lat += stepDeg) {
            const int n = sampleParallel(buf, lat);
            PathDrawer::drawPath(display, face, buf, n, thickness, color);
        }

        // Meridians: lon ∈ [-180, 180), latitudes -90..90 inclusive.
        for (double lon = -180.0; lon < 180.0; lon += stepDeg) {
            const int n = sampleMeridian(buf, lon);
            PathDrawer::drawPath(display, face, buf, n, thickness, color);
        }

        // For coarse step the equator gets skipped above — draw it explicitly.
        if (stepDeg > 1.0) {
            const int n = sampleParallel(buf, 0.0);
            PathDrawer::drawPath(display, face, buf, n, thickness, color);
        }

        // Face boundary as a pixel-space rectangle.
        drawFaceBoundary(display, thickness, color);
    }

    // Draw just the perimeter of the current face in pixel space.
    static void drawFaceBoundary(IDisplay& display,
                                 int16_t thickness,
                                 uint32_t color) {
        const Vector2 sz = display.size();
        const int16_t w = sz.x, h = sz.y;
        if (w <= 1 || h <= 1) return;
        const int16_t x0 = 0, y0 = 0;
        const int16_t x1 = static_cast<int16_t>(w - 1);
        const int16_t y1 = static_cast<int16_t>(h - 1);
        display.drawLine(Vector2(x0, y0), Vector2(x1, y0), thickness, color);
        display.drawLine(Vector2(x1, y0), Vector2(x1, y1), thickness, color);
        display.drawLine(Vector2(x1, y1), Vector2(x0, y1), thickness, color);
        display.drawLine(Vector2(x0, y1), Vector2(x0, y0), thickness, color);
    }

private:
    static int sampleParallel(PathDrawer::LonLat* out, double lat) {
        int n = 0;
        for (double lon = -180.0; lon <= 180.0 && n < MAX_SAMPLES; lon += SAMPLE_STEP_DEG) {
            out[n++] = {lon, lat};
        }
        return n;
    }

    static int sampleMeridian(PathDrawer::LonLat* out, double lon) {
        int n = 0;
        for (double lat = -90.0; lat <= 90.0 && n < MAX_SAMPLES; lat += SAMPLE_STEP_DEG) {
            out[n++] = {lon, lat};
        }
        return n;
    }
};

} // namespace Fractonica

#endif // FRACTONICA_GRATICULE_H
