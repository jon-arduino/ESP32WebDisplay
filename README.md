# ESP32WebDisplay
Add-on for [ESP32PhoneDisplay](https://github.com/jon-arduino/ESP32PhoneDisplay): the ESP32 hosts a page that acts as a remote Adafruit_GFX display with touch (and T1/T2 keys), over a WebSocket, using the same binary protocol as the iPhone app.
Separate library so iPhone-only users don't need the web code.

- `src/WebTransport.*` - GraphicsTransport (HTTP page at `/`, WebSocket at `/ws`)
- `web/index.html` - the page: pixel-exact Adafruit_GFX renderer (verified against the real library); embedded gzipped via `tools/embed_web.py`
- `tools/mock_server.js` - run the page without hardware: `node tools/mock_server.js`
- Tests: `./run_tests.sh`
See docs/web.md. License: pending (see LICENSE).
