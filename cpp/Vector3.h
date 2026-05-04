//
// 3D vector used internally by the gnomonic cube-face projection.
// Mirrors the math in js/projection.js, but kept in double precision so
// horizon clipping stays numerically stable before we snap to int pixels.
//

#ifndef FRACTONICA_VECTOR3_H
#define FRACTONICA_VECTOR3_H

#include <cmath>

namespace Fractonica {

struct Vector3 {
    double x, y, z;

    constexpr Vector3() : x(0), y(0), z(0) {}
    constexpr Vector3(double _x, double _y, double _z) : x(_x), y(_y), z(_z) {}

    constexpr Vector3 operator+(const Vector3& r) const { return {x + r.x, y + r.y, z + r.z}; }
    constexpr Vector3 operator-(const Vector3& r) const { return {x - r.x, y - r.y, z - r.z}; }
    constexpr Vector3 operator*(double s) const { return {x * s, y * s, z * s}; }

    constexpr double dot(const Vector3& r) const { return x * r.x + y * r.y + z * r.z; }
    double length() const { return std::sqrt(x * x + y * y + z * z); }
};

} // namespace Fractonica

#endif // FRACTONICA_VECTOR3_H
