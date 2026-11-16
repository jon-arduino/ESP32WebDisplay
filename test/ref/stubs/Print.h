#pragma once
#include <stdint.h>
#include <stddef.h>

class Print {
public:
  virtual ~Print() {}
  virtual size_t write(uint8_t) = 0;
  size_t write(const char *s) { size_t n = 0; while (*s) n += write((uint8_t)*s++); return n; }
  size_t print(const char *s) { return write(s); }
  size_t write(const uint8_t *b, size_t len) { size_t n = 0; while (len--) n += write(*b++); return n; }
};
