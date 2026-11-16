# Web_HelloWorld
Set WIFI_SSID/WIFI_PASS, upload, open the URL shown on Serial. Needs libraries: ESP32PhoneDisplay, ESPAsyncWebServer (mathieucarbou fork recommended), AsyncTCP, Adafruit GFX.
Browser and iPhone are separate transports in v1: use one per sketch.
Tip: `http://esp32-display.local/?flush=50` changes the idle auto-present time (ms); `?buttons=0` hides T1/T2; `?debug` shows stats.
