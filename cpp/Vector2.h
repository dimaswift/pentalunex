#ifndef VECTOR2_H
#define VECTOR2_H
#include <stdint.h>
#include <cmath>
struct Vector2 {
    int16_t x, y;

    constexpr Vector2() : x(0), y(0) { }
    constexpr Vector2(const int16_t _x, const int16_t _y) : x(_x), y(_y) { }

    constexpr Vector2 operator+(const Vector2& rhs) const {
        return Vector2(x + rhs.x, y + rhs.y);
    }
    constexpr Vector2& operator+=(const Vector2& rhs) {
        x += rhs.x;
        y += rhs.y;
        return *this;
    }

    constexpr Vector2 operator-(const Vector2& rhs) const {
        return Vector2(x - rhs.x, y - rhs.y);
    }
    constexpr Vector2& operator-=(const Vector2& rhs) {
        x -= rhs.x;
        y -= rhs.y;
        return *this;
    }

    constexpr Vector2 operator*(const int16_t scalar) const {
        return Vector2(x * scalar, y * scalar);
    }

    constexpr Vector2& operator*=(const int16_t scalar) {
        x *= scalar;
        y *= scalar;
        return *this;
    }

    constexpr Vector2 operator/(const int16_t scalar) const {
        return Vector2(x / scalar, y / scalar);
    }

    constexpr Vector2& operator/=(const int16_t scalar) {
        x /= scalar;
        y /= scalar;
        return *this;
    }

    // --- Unary Minus (Negation) ---
    constexpr Vector2 operator-() const {
        return Vector2(-x, -y);
    }

    // --- Equality ---
    constexpr bool operator==(const Vector2& rhs) const {
        return x == rhs.x && y == rhs.y;
    }
    constexpr bool operator!=(const Vector2& rhs) const {
        return x != rhs.x || y != rhs.y;
    }

    static Vector2 Rotate(const Vector2& point, const Vector2& anchor, int16_t angle) {
        float s = std::sin(angle * M_PI / 180.0);
        float c = std::cos(angle * M_PI / 180.0);

        // Translate point back to origin
        int16_t px = point.x - anchor.x;
        int16_t py = point.y - anchor.y;

        // Rotate and translate back
        int16_t xNew = px * c - py * s + anchor.x;
        int16_t yNew = px * s + py * c + anchor.y;

        return Vector2(xNew, yNew);
    }
};

#endif