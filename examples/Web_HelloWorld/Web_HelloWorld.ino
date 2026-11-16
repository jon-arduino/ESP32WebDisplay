// Web_HelloWorld - a web browser as the display. Open the URL printed on Serial
// (or http://esp32-display.local/). Touch paints dots; T1 clears; T2 redraws.
#include <ESP32WebDisplay.h>

const char *WIFI_SSID = "your-ssid";
const char *WIFI_PASS = "your-password";

WebTransport      transport(WIFI_SSID, WIFI_PASS, "esp32-display");
ESP32PhoneDisplay display(transport);
RemoteTouchScreen ts(transport);

// Callbacks run on the network task: only set flags, draw in loop().
volatile bool redrawPending = false;
volatile bool offline       = false;

void drawScreen() {
    display.begin(240, 320);
    display.setTitle("Web Hello");
    display.setButton1("Clear");
    display.setButton2("Redraw");
    display.fillScreen(0x0000);
    display.fillRect(0, 0, 240, 28, 0x1AB3);
    display.setTextColor(0xFFFF);
    display.setTextSize(2);
    display.setCursor(8, 6);
    display.print("Hello World");
    display.setTextSize(1);
    display.setCursor(8, 40);
    display.print("Touch the screen to paint");
    display.flush();
    ts.begin(TOUCH_MODE_RESISTIVE, 30);
}

void setup() {
    Serial.begin(115200);
    transport.setPowerSave(false);               // lower latency
    transport.onConnected([]()  { offline = false; redrawPending = true; });
    transport.onDisconnected([](){ offline = true; });
    transport.onRedrawRequest([](){ redrawPending = true; });
    transport.onKey([](uint8_t k) { redrawPending = true; });   // '1' or '2'
    transport.begin();
}

void loop() {
    if (redrawPending) { redrawPending = false; drawScreen(); }
    if (offline) { delay(50); return; }
    TSPoint p = ts.getPoint();
    if (p.z > RemoteTouchScreen::MINPRESSURE) {
        display.fillCircle(p.x, p.y, 4, 0xFFE0);
        display.flush();
    }
    delay(5);
}
