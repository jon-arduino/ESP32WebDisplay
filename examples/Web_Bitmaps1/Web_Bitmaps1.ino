// Web_Bitmaps - test pattern for 1-bit bitmaps (drawBitmap) on a browser display.
//
// What it exercises:
//   * widths that are / are not a multiple of 8 (7,8,9,10,15,16,17,21) - each bitmap has a 1px
//     border plus a diagonal, so a wrong byte count shows up as a missing edge or a skewed diagonal
//   * foreground only (transparent background) vs foreground + background colour
//   * clipping at the left / bottom / right screen edges
//   * a large bitmap (T2): 200x100 = 2600 bytes in a single frame. (A frame bigger than 4096 bytes,
//     e.g. 200x200 = 5000, would hang ESP32PhoneDisplay's WiFiTransport - see the issue list.)
//
// T1 = redraw, T2 = toggle the large bitmap.
//
// Note: the wire format of drawBitmap(x,y,bmp,w,h,color) carries no colour, so the display
// uses its CURRENT TEXT COLOUR. bmp() below sets it first so the example works either way.
#include <ESP32WebDisplay.h>

const char *WIFI_SSID = "YOUR_SSID";
const char *WIFI_PASS = "YOUR_PASSWORD";

WebTransport      transport(WIFI_SSID, WIFI_PASS, "esp32-display");
ESP32PhoneDisplay display(transport);

static const uint16_t BLACK = 0x0000, WHITE = 0xFFFF, RED = 0xF800, GREEN = 0x07E0,
                      BLUE = 0x001F, YELLOW = 0xFFE0, CYAN = 0x07FF, GREY = 0x4208, NAVY = 0x0010;

volatile bool redrawPending = false;
volatile bool offline       = false;
volatile bool bigToggle     = false;
bool          showBig       = false;

// Adafruit bitmap layout: each row padded to whole bytes, MSB first.
static const uint8_t SMILEY[8] = {0x3C, 0x42, 0xA5, 0x81, 0xA5, 0x99, 0x42, 0x3C};

static uint8_t scratch[2600];               // big enough for 200x100 (25 bytes/row * 100)

// Border + diagonal test pattern, packed row-padded into `scratch`.
static const uint8_t *makePattern(int w, int h)
{
    int stride = (w + 7) / 8;
    memset(scratch, 0, stride * h);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            bool on = x == 0 || y == 0 || x == w - 1 || y == h - 1 || x == y;
            if (on) scratch[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
        }
    return scratch;
}

// Draw with an explicit colour (see note at the top).
static void bmp(int x, int y, const uint8_t *b, int w, int h, uint16_t fg)
{
    display.setTextColor(fg);
    display.drawBitmap(x, y, b, w, h, fg);
}
static void bmpBg(int x, int y, const uint8_t *b, int w, int h, uint16_t fg, uint16_t bg)
{
    display.drawBitmap(x, y, b, w, h, fg, bg);
}

static void label(int x, int y, const char *s, uint16_t c = WHITE)
{
    display.setTextSize(1);
    display.setTextColor(c);
    display.setCursor(x, y);
    display.print(s);
}

void drawScreen()
{
    display.begin(240, 320);
    display.setTitle("Bitmaps");
    display.setButton1("Redraw");
    display.setButton2("Big");
    display.fillScreen(BLACK);

    label(4, 4, "1-bit bitmaps", YELLOW);

    // Row 1: smiley, foreground only on a coloured stripe, then fg+bg
    display.fillRect(0, 16, 240, 24, NAVY);
    label(4, 18, "fg only", WHITE);
    bmp(52, 20, SMILEY, 8, 8, YELLOW);
    bmp(66, 20, SMILEY, 8, 8, GREEN);
    label(100, 18, "fg+bg", WHITE);
    bmpBg(142, 20, SMILEY, 8, 8, BLACK, YELLOW);
    bmpBg(156, 20, SMILEY, 8, 8, WHITE, RED);

    // Row 2: widths around the byte boundary. Each has border + diagonal.
    label(4, 46, "widths 7 8 9 10 15 16 17 21 (h=12)", CYAN);
    static const int W[] = {7, 8, 9, 10, 15, 16, 17, 21};
    int x = 4;
    for (int i = 0; i < 8; i++) {
        bmp(x, 58, makePattern(W[i], 12), W[i], 12, WHITE);
        x += W[i] + 6;
    }

    // Row 3: same sizes with a background colour (opaque)
    label(4, 76, "same, fg+bg", CYAN);
    x = 4;
    for (int i = 0; i < 8; i++) {
        bmpBg(x, 88, makePattern(W[i], 12), W[i], 12, BLACK, GREEN);
        x += W[i] + 6;
    }

    // Row 4: medium bitmaps
    label(4, 108, "32x32 and 64x40", CYAN);
    bmp(4, 120, makePattern(32, 32), 32, 32, YELLOW);
    bmpBg(44, 120, makePattern(64, 40), 64, 40, WHITE, BLUE);

    // Row 5: clipping against the screen edges (should be cut off, not wrap)
    label(4, 168, "clipping", CYAN);
    bmp(-5, 180, makePattern(20, 20), 20, 20, RED);        // off the left edge
    bmp(226, 180, makePattern(20, 20), 20, 20, RED);       // off the right edge
    bmp(110, 312, makePattern(20, 20), 20, 20, RED);       // off the bottom edge

    // Row 6: big bitmaps (T2)
    if (showBig) {
        bmpBg(20, 204, makePattern(200, 100), 200, 100, YELLOW, GREY);   // 2600 bytes
    } else {
        label(4, 204, "T2: draw 200x100 (2600 B)", GREY);
    }
    display.flush();
}

void setup()
{
    Serial.begin(115200);
    transport.setPowerSave(false);
    transport.onConnected([]()      { offline = false; redrawPending = true; });
    transport.onDisconnected([]()   { offline = true; });
    transport.onRedrawRequest([]()  { redrawPending = true; });
    transport.onKey([](uint8_t key) { if (key == '2') bigToggle = true; redrawPending = true; });
    transport.begin();
}

void loop()
{
    if (bigToggle) { bigToggle = false; showBig = !showBig; }
    if (redrawPending) { redrawPending = false; drawScreen(); }
    delay(20);
}
