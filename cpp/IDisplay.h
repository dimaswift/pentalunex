
#ifndef CORE_IDISPLAY_H
#define CORE_IDISPLAY_H

#include "Vector2.h"
#include "IMatrix.h"



namespace Fractonica
{
    class IDisplay : public IMatrix
    {
    public:
        ~IDisplay() override = default;
        virtual void print(const char *msg, int16_t x, int16_t y, uint8_t size) = 0;
        virtual void log(const char *msg) = 0;
        virtual void logError(const char *msg)= 0;
        virtual void drawLine(int16_t x1, int16_t y1, int16_t x2, int16_t y2, int16_t thickness, uint32_t color) = 0;
        virtual void drawLine(const Vector2& p1, const Vector2& p2, int16_t thickness, uint32_t color) = 0;
        virtual void drawRect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint32_t color) = 0;
        virtual void drawFillRect(const Vector2& min, const Vector2& max, uint32_t color) = 0;
        virtual void drawNGonFilled(const Vector2& center, float radius, uint32_t col, int num_segments) = 0;
        virtual void drawRect(const Vector2& min, const Vector2& max, uint32_t color) = 0;
        virtual void drawBitmap(int16_t x, int16_t y, uint16_t width, uint16_t height, const uint16_t *bitmap) = 0;
        virtual void setCursor(const Vector2& pos) = 0;
        virtual void expand(int16_t w, int16_t h) = 0;
        virtual void printF(const char* fmt, ...) = 0;
        virtual void update() = 0;
        virtual bool isOpen() = 0;
    };
}

#endif