# Web display notes
- Wire protocol identical to BLE/WiFi (`GraphicsProtocol`/`Protocol.h`); WebSocket is treated as a byte stream.
- Page served over plain http; one tab is active (newest wins). Hidden tab sends DISPLAY_AVAILABLE(0); visible again sends AVAILABLE(1)+REDRAW.
- Query params: `?flush=ms` (idle present, default 50), `?buttons=0`, `?host=`, `?ws=`, `?port=`, `?path=`, `?debug`.
- Edit `web/index.html`, then `python3 tools/embed_web.py` (CI: `--check`).
- Known v1 limits: not simultaneous with iPhone transport; DRAW_BITMAP uses text color (wire has none).
