// Minimal Arduino shim so the real Adafruit_GFX.cpp compiles on a desktop host.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <string>
#include <algorithm>

#ifndef PROGMEM
#define PROGMEM
#endif

class __FlashStringHelper;
#define F(s) (reinterpret_cast<const __FlashStringHelper *>(s))

class String {
public:
  String(const char *s = "") : s_(s) {}
  const char *c_str() const { return s_.c_str(); }
  unsigned length() const { return (unsigned)s_.size(); }
private:
  std::string s_;
};

#ifndef DEG_TO_RAD
#define DEG_TO_RAD 0.017453292519943295769236907684886
#endif
#ifndef radians
#define radians(deg) ((deg) * DEG_TO_RAD)
#endif

#include "Print.h"
