#pragma once
// -----------------------------------------------------------------------------
//  WebTransport - GraphicsTransport that serves a web page and talks the standard
//  display protocol over a WebSocket (/ws). One browser tab is the display.
//
//    WebTransport transport(WIFI_SSID, WIFI_PASS, "esp32-display");
//    ESP32PhoneDisplay display(transport);
//    RemoteTouchScreen ts(transport);
//    transport.onConnected([]{ ...set a flag; draw from loop()... });
//    transport.begin();            // then open http://esp32-display.local/
//
//  Callbacks run on the network task: only set flags there, draw from loop().
//  Browser option: http://host/?flush=50 sets the idle auto-present time in ms.
// -----------------------------------------------------------------------------
#include <Arduino.h>
#include <functional>
#include <vector>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <GraphicsTransport.h>
#include <BackChannelParser.h>

class WebTransport : public GraphicsTransport
{
public:
    WebTransport(const char *ssid, const char *password,
                 const char *hostname = "esp32-display", uint16_t port = 80);

    // Optional: start a SoftAP if the station connection fails within staTimeoutMs.
    void setSoftAP(const char *apSsid, const char *apPassword, uint32_t staTimeoutMs = 15000);
    void setDeviceName(const char *name) { _hostname = name; }
    void setPowerSave(bool enable)       { _powerSave = enable; if (_started) WiFi.setSleep(enable); }

    void begin();                          // blocking WiFi connect, then serves the page

    // GraphicsTransport
    bool canSend() const override { return _connected; }
    void send(const uint8_t *data, uint16_t len) override;
    void flush() override;
    void reset() override;
    void onTouch(std::function<void(uint8_t, int16_t, int16_t, uint8_t)> cb) override { _parser.onTouch(cb); }

    void onConnected(std::function<void()> cb)             { _onConnected = cb; }
    void onDisconnected(std::function<void()> cb)          { _onDisconnected = cb; }
    void onKey(std::function<void(uint8_t)> cb)            { _parser.onKey(cb); }
    void onRedrawRequest(std::function<void()> cb)         { _parser.onRedrawRequest(cb); }
    void onDisplayAvailable(std::function<void(bool)> cb)  { _parser.onDisplayAvailable(cb); }
    bool isClientConnected() const { return _connected; }
    String url() const;

private:
    static constexpr size_t   MAX_TX    = 24576;
    static constexpr uint32_t DRAIN_MS  = 10;
    static constexpr uint32_t WAIT_MS   = 2000;

    void startSoftAP();
    void startServer();
    void onWsEvent(AsyncWebSocket *s, AsyncWebSocketClient *c, AwsEventType t, void *arg, uint8_t *data, size_t len);
    void drain();
    static void taskThunk(void *p);

    const char *_ssid, *_password;
    String      _hostname;
    uint16_t    _port;
    const char *_apSsid = nullptr, *_apPassword = nullptr;
    uint32_t    _staTimeoutMs = 15000;
    bool        _powerSave = true, _started = false, _apMode = false;

    AsyncWebServer _server;
    AsyncWebSocket _ws;
    BackChannelParser _parser;
    SemaphoreHandle_t _mutex = nullptr;       // protects _txBuf
    SemaphoreHandle_t _sendMutex = nullptr;   // serialises drain(): swap + send must be atomic or chunks reorder
    std::vector<uint8_t> _txBuf;
    volatile bool     _connected = false;
    volatile uint32_t _clientId  = 0;
    std::function<void()> _onConnected, _onDisconnected;
};
