//
// Gnomonic per-face projection for the COBE / Q3C spherical cube.
// Port of js/projection.js. Each of the 6 cube faces has an orthonormal
// (east, north, normal) frame; a unit-sphere point is rotated into the frame,
// then projected to the tangent plane as (X/Z, Y/Z).
//
// All math is in double precision; the final pixel coordinates are snapped
// to int16_t Vector2 at the IDisplay boundary.
//

#ifndef FRACTONICA_PROJECTION_H
#define FRACTONICA_PROJECTION_H

#include <cmath>
#include <cstdint>
#include "Vector2.h"
#include "Vector3.h"

namespace Fractonica {

namespace Projection {

constexpr double DEG = 3.14159265358979323846 / 180.0;

// Clip plane just inside the visible hemisphere. Matches js/projection.js.
// ≈ 88.85° from the face normal — keeps the perspective division finite.
constexpr double CLIP_EPS = 0.02;

constexpr int FACE_COUNT = 6;

struct FaceFrame {
    Vector3 east;
    Vector3 north;
    Vector3 normal;
};

// Same ordering as JS:
//   0 N pole, 1 +X (lon=0), 2 +Y (lon=90), 3 -X (lon=180), 4 -Y (lon=270), 5 S pole
inline const FaceFrame& faceFrame(int face) {
    static const FaceFrame frames[FACE_COUNT] = {
        {{ 0,  1,  0}, {-1,  0,  0}, { 0,  0,  1}}, // 0 N pole
        {{ 0,  1,  0}, { 0,  0,  1}, { 1,  0,  0}}, // 1 lon=0
        {{-1,  0,  0}, { 0,  0,  1}, { 0,  1,  0}}, // 2 lon=90
        {{ 0, -1,  0}, { 0,  0,  1}, {-1,  0,  0}}, // 3 lon=180
        {{ 1,  0,  0}, { 0,  0,  1}, { 0, -1,  0}}, // 4 lon=270
        {{ 0, -1,  0}, {-1,  0,  0}, { 0,  0, -1}}, // 5 S pole
    };
    return frames[face];
}

// Lon/lat (degrees) → unit vector on the celestial sphere.
inline Vector3 lonLatTo3D(double lon, double lat) {
    const double la = lat * DEG;
    const double lo = lon * DEG;
    const double cl = std::cos(la);
    return {cl * std::cos(lo), cl * std::sin(lo), std::sin(la)};
}

// Rotate a world-space point into a face's local (east, north, normal) frame.
inline Vector3 toFaceXYZ(int face, const Vector3& p) {
    const FaceFrame& f = faceFrame(face);
    return {f.east.dot(p), f.north.dot(p), f.normal.dot(p)};
}

// Reverse of toFaceXYZ — face-local back to world space.
inline Vector3 fromFaceXYZ(int face, const Vector3& p) {
    const FaceFrame& f = faceFrame(face);
    return {
        p.x * f.east.x + p.y * f.north.x + p.z * f.normal.x,
        p.x * f.east.y + p.y * f.north.y + p.z * f.normal.y,
        p.x * f.east.z + p.y * f.north.z + p.z * f.normal.z,
    };
}

// Linear interpolate to the clip plane Z = CLIP_EPS along segment a→b.
inline Vector3 interpZ(const Vector3& a, const Vector3& b) {
    const double t = (CLIP_EPS - a.z) / (b.z - a.z);
    return {a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), CLIP_EPS};
}

// Clip one face-local segment against the visible hemisphere (Z >= CLIP_EPS).
// Returns true if any part is visible; out0/out1 receive the (possibly
// clipped) endpoints.
inline bool clipSegment(const Vector3& a, const Vector3& b,
                        Vector3& out0, Vector3& out1) {
    const bool aIn = a.z >= CLIP_EPS;
    const bool bIn = b.z >= CLIP_EPS;
    if (aIn && bIn) { out0 = a; out1 = b; return true; }
    if (!aIn && !bIn) return false;
    const Vector3 ip = interpZ(a, b);
    if (aIn) { out0 = a;  out1 = ip; }
    else     { out0 = ip; out1 = b;  }
    return true;
}

// Project a face-local point to pixel coords on an N×N face canvas.
// Mirrors projXY in projection.js: px = (1 + x/z)/2 * N, py = (1 - y/z)/2 * N.
inline void projXY(const Vector3& p, int N, double& px, double& py) {
    px = (1.0 + p.x / p.z) * 0.5 * N;
    py = (1.0 - p.y / p.z) * 0.5 * N;
}

// Snap to the int16_t pixel space used by IDisplay::drawLine.
inline Vector2 toPixel(const Vector3& p, int N) {
    double px, py;
    projXY(p, N, px, py);
    // round-half-to-nearest, then clamp into a sane int16_t range.
    long ix = std::lround(px);
    long iy = std::lround(py);
    if (ix < INT16_MIN) ix = INT16_MIN; else if (ix > INT16_MAX) ix = INT16_MAX;
    if (iy < INT16_MIN) iy = INT16_MIN; else if (iy > INT16_MAX) iy = INT16_MAX;
    return Vector2(static_cast<int16_t>(ix), static_cast<int16_t>(iy));
}

// Pick the face that owns a lon/lat point — the face whose normal has
// the largest dot product with the unit direction. Matches the mouse-hover /
// cell-binning logic in js/eclipse-overlay.js.
inline int lonLatToFace(double lon, double lat) {
    const Vector3 p = lonLatTo3D(lon, lat);
    int best = 0;
    double bestDot = -2.0;
    for (int f = 0; f < FACE_COUNT; ++f) {
        const double d = faceFrame(f).normal.dot(p);
        if (d > bestDot) { bestDot = d; best = f; }
    }
    return best;
}

} // namespace Projection
} // namespace Fractonica

#endif // FRACTONICA_PROJECTION_H
