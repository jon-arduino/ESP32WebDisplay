#include "WebTransport.h"
#include "web/WebDisplayPage.h"
#include <ESPmDNS.h>

WebTransport::WebTransport(const char *ssid, const char *password, const char *hostname, uint16_t port)
    : _ssid(ssid), _password(password), _hostname(hostname), _port(port), _server(port), _ws("/ws") {}

void WebTransport::setSoftAP(const char *s, const char *p, uint32_t t) { _apSsid = s; _apPassword = p; _staTimeoutMs = t; }

String WebTransport::url() const {
    IPAddress ip = _apMode ? WiFi.softAPIP() : WiFi.localIP();
    return "http://" + ip.toString() + (_port == 80 ? "" : ":" + String(_port)) + "/";
}

void WebTransport::startSoftAP() {
    WiFi.mode(WIFI_AP);
    if (!WiFi.softAP(_apSsid, _apPassword)) { Serial.println("[Web] SoftAP failed"); return; }
    _apMode = true;
}

void WebTransport::begin() {
    if (!_mutex) _mutex = xSemaphoreCreateMutex();
    if (!_sendMutex) _sendMutex = xSemaphoreCreateMutex();
    _txBuf.reserve(4096);

    WiFi.persistent(false);
    WiFi.mode(_apSsid ? WIFI_AP_STA : WIFI_STA);
    WiFi.setHostname(_hostname.c_str());      // after mode(): the STA interface exists now
    WiFi.setAutoReconnect(true);
    WiFi.begin(_ssid, _password);
    Serial.print("[Web] Connecting");
    uint32_t t0 = millis(), lastTry = t0;
    while (WiFi.status() != WL_CONNECTED) {
        if (_apSsid && millis() - t0 >= _staTimeoutMs) {
            Serial.println("\n[Web] STA timeout - starting SoftAP");
            WiFi.disconnect(true);
            startSoftAP();
            break;
        }
        if (millis() - lastTry >= 10000) {     // retry: first attempt after a flash often fails
            Serial.printf("\n[Web] retrying (status %d)", WiFi.status());
            WiFi.disconnect();
            delay(100);
            WiFi.begin(_ssid, _password);
            lastTry = millis();
        }
        delay(500); Serial.print(".");
    }
    Serial.println("\n[Web] WiFi up");
    WiFi.setSleep(_powerSave);
    if (MDNS.begin(_hostname.c_str())) MDNS.addService("http", "tcp", _port);
    startServer();
    _started = true;
    xTaskCreatePinnedToCore(taskThunk, "webTx", 4096, this, 1, nullptr, 0);
    Serial.printf("\n[Web] Open %s  (or http://%s.local/)\n", url().c_str(), _hostname.c_str());
}

void WebTransport::startServer() {
    _ws.onEvent([this](AsyncWebSocket *s, AsyncWebSocketClient *c, AwsEventType t, void *a, uint8_t *d, size_t l) {
        onWsEvent(s, c, t, a, d, l);
    });
    _server.addHandler(&_ws);
    _server.on("/", HTTP_GET, [](AsyncWebServerRequest *r) {
        AsyncWebServerResponse *res = r->beginResponse(200, "text/html", WEB_DISPLAY_PAGE_GZ, WEB_DISPLAY_PAGE_GZ_LEN);
        res->addHeader("Content-Encoding", "gzip");
        res->addHeader("Cache-Control", "no-cache");
        r->send(res);
    });
    _server.onNotFound([](AsyncWebServerRequest *r) { r->send(404, "text/plain", "not found"); });
    _server.begin();
}

void WebTransport::onWsEvent(AsyncWebSocket *, AsyncWebSocketClient *c, AwsEventType t, void *, uint8_t *data, size_t len) {
    switch (t) {
    case WS_EVT_CONNECT:
        if (_connected && _clientId != c->id()) {          // newest tab wins
            AsyncWebSocketClient *old = _ws.client(_clientId);
            if (old) old->close();
        }
        _clientId = c->id();
        _parser.reset();
        if (xSemaphoreTake(_mutex, portMAX_DELAY)) { _txBuf.clear(); xSemaphoreGive(_mutex); }
        _connected = true;
        if (_onConnected) _onConnected();
        break;
    case WS_EVT_DISCONNECT:
        if (c->id() == _clientId) {
            _connected = false;
            if (_onDisconnected) _onDisconnected();
        }
        break;
    case WS_EVT_DATA:                                       // byte stream: fragments/messages are irrelevant
        if (c->id() == _clientId) _parser.feed(data, len);
        break;
    default: break;
    }
}

void WebTransport::send(const uint8_t *data, uint16_t len) {
    if (!_connected || !_mutex) return;
    uint32_t t0 = millis();
    for (;;) {
        xSemaphoreTake(_mutex, portMAX_DELAY);
        if (_txBuf.size() + len <= MAX_TX) {
            _txBuf.insert(_txBuf.end(), data, data + len);
            xSemaphoreGive(_mutex);
            return;
        }
        xSemaphoreGive(_mutex);
        if (!_connected || millis() - t0 > WAIT_MS) return;  // client stalled: drop (browser asks for REDRAW on reconnect)
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}

void WebTransport::drain() {
    if (!_connected || !_sendMutex) return;
    if (!xSemaphoreTake(_sendMutex, pdMS_TO_TICKS(20))) return;   // another thread is draining
    AsyncWebSocketClient *c = _ws.client(_clientId);
    if (c && c->canSend()) {                                     // else keep buffering
        std::vector<uint8_t> out;
        if (xSemaphoreTake(_mutex, pdMS_TO_TICKS(5))) { out.swap(_txBuf); xSemaphoreGive(_mutex); }
        if (!out.empty()) c->binary(out.data(), out.size());
    }
    xSemaphoreGive(_sendMutex);
}

void WebTransport::flush() { drain(); }

void WebTransport::reset() {
    if (xSemaphoreTake(_mutex, portMAX_DELAY)) { _txBuf.clear(); xSemaphoreGive(_mutex); }
}

void WebTransport::taskThunk(void *p) {
    WebTransport *self = static_cast<WebTransport *>(p);
    uint32_t lastPing = millis();
    for (;;) {
        self->drain();
        self->_ws.cleanupClients();
        if (self->_connected && millis() - lastPing >= 3000) {
            static const uint8_t ping[] = {0xA5, 0x01, 0x00, 0xF0};
            self->send(ping, sizeof(ping));
            lastPing = millis();
        }
        vTaskDelay(pdMS_TO_TICKS(DRAIN_MS));
    }
}
