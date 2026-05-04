//
// Created by Dmitry Popov on 29.01.2026.
//

#ifndef FRACTONICA_IMATRIX_H
#define FRACTONICA_IMATRIX_H
#include <stdint.h>

#include "Vector2.h"

namespace Fractonica {
    class IMatrix {

    public:
        enum Origin {
            TopLeft = 0,
            TopRight = 1,
            BottomLeft = 2,
            BottomRight = 3,
            AsIs = 4
        };
        virtual ~IMatrix() = default;
        virtual void drawPixel(uint16_t x, uint16_t y, uint32_t color) = 0;
        virtual bool begin() = 0;
        virtual void flush() = 0;
        virtual void clear() = 0;
        virtual Vector2 size() = 0;

        [[nodiscard]] virtual uint32_t getColor(uint8_t r, uint8_t g, uint8_t b) const = 0;
        [[nodiscard]] virtual uint32_t getColorHSV(uint16_t h, uint8_t s, uint8_t v) const = 0;
    };
}

#endif //FRACTONICA_IMATRIX_H