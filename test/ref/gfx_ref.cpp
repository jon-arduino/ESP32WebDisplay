// Reference receiver: replays a framed ESP32PhoneDisplay byte stream through the REAL
// Adafruit_GFX (GFXcanvas16) and dumps the final raw framebuffer. The browser renderer's
// output is compared against this, pixel for pixel.
//
// usage: gfx_ref <stream.bin> <out.bin> [max_frames]
// out.bin: u16 W, u16 H, u8 rotation, then W*H little-endian RGB565 pixels (raw/physical order)
#include <stdio.h>
#include <vector>
#include "Adafruit_GFX.h"

static std::vector<uint8_t> slurp(const char *path) {
  std::vector<uint8_t> v;
  FILE *f = fopen(path, "rb");
  if (!f) { perror(path); exit(2); }
  uint8_t buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) v.insert(v.end(), buf, buf + n);
  fclose(f);
  return v;
}
static inline uint16_t U16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static inline int16_t I16(const uint8_t *p) { return (int16_t)(p[0] | (p[1] << 8)); }

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: gfx_ref in out [max_frames]\n"); return 2; }
  std::vector<uint8_t> in = slurp(argv[1]);
  long limit = argc > 3 ? atol(argv[3]) : -1;

  GFXcanvas16 *c = nullptr;
  uint16_t fg = 0xFFFF;           // DRAW_BITMAP carries no colour on the wire; the text colour is used
  long frames = 0;
  size_t pos = 0;
  while (pos + 3 <= in.size()) {
    if (in[pos] != 0xA5) { pos++; continue; }
    uint16_t len = U16(&in[pos + 1]);
    if (len < 1 || pos + 3 + len > in.size()) break;
    if (limit >= 0 && frames >= limit) break;
    uint8_t cmd = in[pos + 3];
    const uint8_t *p = &in[pos + 4];
    size_t n = len - 1;
    pos += 3 + len;
    frames++;

    if (cmd == 0x01) {            // BEGIN
      delete c;
      c = new GFXcanvas16(U16(p), U16(p + 2));
      fg = 0xFFFF;
      continue;
    }
    if (!c) continue;
    switch (cmd) {
    case 0x02: c->fillScreen(U16(p)); break;
    case 0x05: c->setRotation(p[0] & 3); break;
    case 0x10: c->drawPixel(I16(p), I16(p + 2), U16(p + 4)); break;
    case 0x11: c->drawLine(I16(p), I16(p + 2), I16(p + 4), I16(p + 6), U16(p + 8)); break;
    case 0x12: c->drawFastHLine(I16(p), I16(p + 2), I16(p + 4), U16(p + 6)); break;
    case 0x13: c->drawFastVLine(I16(p), I16(p + 2), I16(p + 4), U16(p + 6)); break;
    case 0x20: c->drawRect(I16(p), I16(p + 2), I16(p + 4), I16(p + 6), U16(p + 8)); break;
    case 0x21: c->fillRect(I16(p), I16(p + 2), I16(p + 4), I16(p + 6), U16(p + 8)); break;
    case 0x22: c->drawRoundRect(I16(p), I16(p + 2), I16(p + 4), I16(p + 6), I16(p + 8), U16(p + 10)); break;
    case 0x23: c->fillRoundRect(I16(p), I16(p + 2), I16(p + 4), I16(p + 6), I16(p + 8), U16(p + 10)); break;
    case 0x30: c->drawCircle(I16(p), I16(p + 2), I16(p + 4), U16(p + 6)); break;
    case 0x31: c->fillCircle(I16(p), I16(p + 2), I16(p + 4), U16(p + 6)); break;
    case 0x32: c->drawTriangle(I16(p), I16(p + 2), I16(p + 4), I16(p + 6), I16(p + 8), I16(p + 10), U16(p + 12)); break;
    case 0x33: c->fillTriangle(I16(p), I16(p + 2), I16(p + 4), I16(p + 6), I16(p + 8), I16(p + 10), U16(p + 12)); break;
    case 0x40: case 0x41: {
      bool bg = cmd == 0x41;
      int16_t x = I16(p), y = I16(p + 2), w = I16(p + 4), h = I16(p + 6);
      size_t hdr = bg ? 12 : 8;
      long need = (long)((w + 7) / 8) * (h > 0 ? h : 0);
      std::vector<uint8_t> data(need > 0 ? need : 1, 0);   // missing bytes read as 0, like the browser
      for (long i = 0; i < need && hdr + i < n; i++) data[i] = p[hdr + i];
      if (bg) c->drawBitmap(x, y, data.data(), w, h, U16(p + 8), U16(p + 10));
      else c->drawBitmap(x, y, data.data(), w, h, fg);
      break;
    }
    case 0x50: c->setCursor(I16(p), I16(p + 2)); break;
    case 0x51: fg = U16(p); c->setTextColor(fg); break;
    case 0x52: fg = U16(p); c->setTextColor(fg, U16(p + 2)); break;
    case 0x53: c->setTextSize(p[0]); break;
    case 0x54: c->setTextWrap(p[0] != 0); break;
    case 0x55: c->cp437(p[0] != 0); break;
    case 0x57: c->write(p[0]); break;
    default: break;               // FLUSH, INVERT, title/buttons, touch control: no pixel effect
    }
  }

  FILE *o = fopen(argv[2], "wb");
  if (!o) { perror(argv[2]); return 2; }
  if (c) {
    uint8_t hdr[5];
    // raw (physical) size = size at rotation 0; recover it from the rotation
    int16_t W = (c->getRotation() & 1) ? c->height() : c->width();
    int16_t H = (c->getRotation() & 1) ? c->width() : c->height();
    hdr[0] = W & 255; hdr[1] = W >> 8; hdr[2] = H & 255; hdr[3] = H >> 8; hdr[4] = c->getRotation();
    fwrite(hdr, 1, 5, o);
    const uint16_t *b = c->getBuffer();
    for (long i = 0; i < (long)W * H; i++) { uint8_t t[2] = { (uint8_t)(b[i] & 255), (uint8_t)(b[i] >> 8) }; fwrite(t, 1, 2, o); }
  }
  fclose(o);
  return 0;
}
