/*
 * esp32_cam.ino — Smart AI-IoT Classroom Surveillance Camera Node
 *
 * Hardware:
 *   - AI-Thinker ESP32-CAM (OV2640)
 *
 * Features:
 *   - HTTP MJPEG streaming server (port 81)
 *   - Single frame capture endpoint (port 80)
 *   - MQTT integration for remote commands
 *   - Mode-aware capture policies:
 *     * IDLE: camera off / minimal
 *     * NORMAL (Learning): periodic captures every 5 min for occupancy
 *     * TESTING: active monitoring, frequent captures on demand
 *
 * Required Libraries:
 *   - WiFi (built-in)
 *   - PubSubClient by Nick O'Leary
 *   - ArduinoJson by Benoit Blanchon
 *   - esp_camera (built-in for ESP32-CAM)
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "config.h"

// ─── Global Objects ─────────────────────────────────────
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
httpd_handle_t stream_httpd = NULL;
httpd_handle_t capture_httpd = NULL;

// ─── State Variables ────────────────────────────────────
String currentMode = "IDLE";
bool streamingActive = false;
bool captureRequested = false;
unsigned long lastHeartbeat = 0;
unsigned long lastPeriodicCapture = 0;
unsigned long sessionStartTime = 0;
unsigned long uptimeSeconds = 0;

// ─── Function Declarations ──────────────────────────────
void setupWiFi();
void setupCamera();
void setupMQTT();
void startHTTPServers();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void reconnectMQTT();
void publishHeartbeat();
void publishFrameReady(size_t frameSize);
void handleModeChange(String newMode);
void handleCaptureCommand(String command);
void handleStreamCommand(String command);
void periodicCapture();

// ─── HTTP Handlers ──────────────────────────────────────

// MJPEG Stream handler
static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  esp_err_t res = ESP_OK;

  char part_buf[128];
  static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=frame";
  static const char* STREAM_BOUNDARY = "\r\n--frame\r\n";
  static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\nX-Timestamp: %lu\r\n\r\n";

  res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;

  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "X-Framerate", "10");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAM] Frame capture failed");
      res = ESP_FAIL;
      break;
    }

    size_t hlen = snprintf(part_buf, sizeof(part_buf), STREAM_PART, fb->len, millis());
    res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, part_buf, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);

    esp_camera_fb_return(fb);
    fb = NULL;

    if (res != ESP_OK) break;

    delay(100);  // ~10 FPS
  }

  return res;
}

// Single JPEG capture handler
static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM] Capture failed");
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);

  // Notify via MQTT that a frame was captured
  publishFrameReady(fb->len);

  esp_camera_fb_return(fb);
  return res;
}

// Status/info handler
static esp_err_t status_handler(httpd_req_t *req) {
  StaticJsonDocument<512> doc;
  doc["status"] = "online";
  doc["mode"] = currentMode;
  doc["streaming"] = streamingActive;
  doc["uptime_s"] = millis() / 1000;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["free_heap"] = ESP.getFreeHeap();

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    doc["frame_size"] = s->status.framesize;
    doc["quality"] = s->status.quality;
  }

  char buf[512];
  serializeJson(doc, buf);

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, buf, strlen(buf));
}

// ─── Setup ──────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("╔══════════════════════════════════════════╗");
  Serial.println("║  Smart AI-IoT Classroom - ESP32-CAM Node ║");
  Serial.println("╚══════════════════════════════════════════╝");

  // Initialize camera
  setupCamera();

  // Connect WiFi
  setupWiFi();

  // Start HTTP servers for streaming/capture
  startHTTPServers();

  // Connect MQTT
  setupMQTT();

  Serial.println("[READY] ESP32-CAM initialized");
  Serial.print("[STREAM] http://");
  Serial.print(WiFi.localIP());
  Serial.print(":");
  Serial.print(STREAM_PORT);
  Serial.println("/stream");
  Serial.print("[CAPTURE] http://");
  Serial.print(WiFi.localIP());
  Serial.println("/capture");
}

// ─── Main Loop ──────────────────────────────────────────
void loop() {
  // Maintain MQTT connection
  if (!mqtt.connected()) {
    reconnectMQTT();
  }
  mqtt.loop();

  unsigned long now = millis();

  // Heartbeat
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    uptimeSeconds = now / 1000;
    publishHeartbeat();
  }

  // Periodic capture based on mode
  periodicCapture();
}

// ─── Camera Initialization ──────────────────────────────
void setupCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_LATEST;

  // Higher quality if PSRAM available
  if (psramFound()) {
    config.frame_size = FRAME_SIZE;
    config.jpeg_quality = JPEG_QUALITY;
    config.fb_count = FB_COUNT;
    Serial.println("[CAM] PSRAM found — using high quality");
  } else {
    config.frame_size = FRAMESIZE_SVGA;
    config.jpeg_quality = 16;
    config.fb_count = 1;
    Serial.println("[CAM] No PSRAM — using reduced quality");
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] Init FAILED: 0x%x\n", err);
    delay(1000);
    ESP.restart();
  }

  // Adjust sensor settings for classroom environment
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_brightness(s, 1);      // Slightly brighter
    s->set_contrast(s, 1);        // Slightly more contrast
    s->set_saturation(s, 0);      // Normal saturation
    s->set_whitebal(s, 1);        // Auto white balance ON
    s->set_awb_gain(s, 1);        // Auto WB gain ON
    s->set_wb_mode(s, 0);         // Auto WB mode
    s->set_exposure_ctrl(s, 1);   // Auto exposure ON
    s->set_aec2(s, 1);            // Auto exposure DSP ON
    s->set_gain_ctrl(s, 1);       // Auto gain ON
    s->set_hmirror(s, 0);         // No horizontal mirror
    s->set_vflip(s, 0);           // No vertical flip
  }

  Serial.println("[CAM] Camera initialized successfully");
}

// ─── WiFi Setup ─────────────────────────────────────────
void setupWiFi() {
  Serial.print("[WiFi] Connecting to ");
  Serial.print(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("[WiFi] Connected! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("[WiFi] FAILED. Restarting...");
    ESP.restart();
  }
}

// ─── HTTP Server Setup ──────────────────────────────────
void startHTTPServers() {
  // Capture server (port 80)
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = CAPTURE_PORT;
  config.ctrl_port = CAPTURE_PORT;

  httpd_uri_t capture_uri = {
    .uri       = "/capture",
    .method    = HTTP_GET,
    .handler   = capture_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t status_uri = {
    .uri       = "/status",
    .method    = HTTP_GET,
    .handler   = status_handler,
    .user_ctx  = NULL
  };

  if (httpd_start(&capture_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(capture_httpd, &capture_uri);
    httpd_register_uri_handler(capture_httpd, &status_uri);
    Serial.printf("[HTTP] Capture server started on port %d\n", CAPTURE_PORT);
  }

  // Stream server (port 81)
  config.server_port = STREAM_PORT;
  config.ctrl_port = STREAM_PORT + 1;

  httpd_uri_t stream_uri = {
    .uri       = "/stream",
    .method    = HTTP_GET,
    .handler   = stream_handler,
    .user_ctx  = NULL
  };

  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
    Serial.printf("[HTTP] Stream server started on port %d\n", STREAM_PORT);
  }
}

// ─── MQTT Setup ─────────────────────────────────────────
void setupMQTT() {
  mqtt.setServer(MQTT_BROKER_IP, MQTT_BROKER_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);
  reconnectMQTT();
}

void reconnectMQTT() {
  int attempts = 0;
  while (!mqtt.connected() && attempts < 5) {
    Serial.print("[MQTT] Connecting...");

    bool connected;
    if (strlen(MQTT_USERNAME) > 0) {
      connected = mqtt.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD);
    } else {
      connected = mqtt.connect(MQTT_CLIENT_ID);
    }

    if (connected) {
      Serial.println(" Connected!");
      mqtt.subscribe(TOPIC_CAM_CAPTURE);
      mqtt.subscribe(TOPIC_CAM_STREAM);
      mqtt.subscribe(TOPIC_CAM_CONFIG);
      mqtt.subscribe(TOPIC_MODE);
      Serial.println("[MQTT] Subscribed to camera topics");

      // Publish online status
      StaticJsonDocument<128> doc;
      doc["status"] = "online";
      doc["ip"] = WiFi.localIP().toString();
      doc["stream_url"] = "http://" + WiFi.localIP().toString() + ":81/stream";
      doc["capture_url"] = "http://" + WiFi.localIP().toString() + "/capture";
      char buf[128];
      serializeJson(doc, buf);
      mqtt.publish(TOPIC_CAM_STATUS, buf, true);  // Retained
    } else {
      Serial.print(" Failed (rc=");
      Serial.print(mqtt.state());
      Serial.println("). Retrying...");
      delay(MQTT_RECONNECT_DELAY_MS);
    }
    attempts++;
  }
}

// ─── MQTT Callback ──────────────────────────────────────
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message;
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  message.trim();

  Serial.print("[MQTT RX] ");
  Serial.print(topic);
  Serial.print(" → ");
  Serial.println(message);

  String topicStr = String(topic);

  if (topicStr == TOPIC_CAM_CAPTURE) {
    handleCaptureCommand(message);
  } else if (topicStr == TOPIC_CAM_STREAM) {
    handleStreamCommand(message);
  } else if (topicStr == TOPIC_MODE) {
    handleModeChange(message);
  } else if (topicStr == TOPIC_CAM_CONFIG) {
    // Handle config changes (resolution, quality, etc.)
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, message);
    if (err == DeserializationError::Ok) {
      sensor_t *s = esp_camera_sensor_get();
      if (s) {
        if (doc.containsKey("quality")) {
          s->set_quality(s, doc["quality"].as<int>());
        }
        if (doc.containsKey("framesize")) {
          s->set_framesize(s, (framesize_t)doc["framesize"].as<int>());
        }
        if (doc.containsKey("brightness")) {
          s->set_brightness(s, doc["brightness"].as<int>());
        }
        Serial.println("[CAM] Config updated via MQTT");
      }
    }
  }
}

// ─── Command Handlers ───────────────────────────────────
void handleCaptureCommand(String command) {
  if (command == "NOW" || command == "1") {
    Serial.println("[CAM] Capture requested via MQTT");
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) {
      publishFrameReady(fb->len);
      esp_camera_fb_return(fb);
      Serial.printf("[CAM] Captured frame: %u bytes\n", fb->len);
    } else {
      Serial.println("[CAM] Capture failed!");
    }
  }
}

void handleStreamCommand(String command) {
  if (command == "START" || command == "ON") {
    streamingActive = true;
    Serial.println("[CAM] Streaming enabled");
  } else if (command == "STOP" || command == "OFF") {
    streamingActive = false;
    Serial.println("[CAM] Streaming disabled");
  }
}

void handleModeChange(String newMode) {
  newMode.toUpperCase();
  String oldMode = currentMode;
  currentMode = newMode;

  Serial.print("[MODE] Changed: ");
  Serial.print(oldMode);
  Serial.print(" → ");
  Serial.println(currentMode);

  if (currentMode == "NORMAL") {
    sessionStartTime = millis();
    // Learning: periodic captures, camera awake
    sensor_t *s = esp_camera_sensor_get();
    if (s) s->set_framesize(s, FRAMESIZE_VGA);
  } else if (currentMode == "TESTING") {
    // Testing: higher alert, more frequent captures
    sensor_t *s = esp_camera_sensor_get();
    if (s) s->set_framesize(s, FRAMESIZE_VGA);
  } else {
    // IDLE
    sessionStartTime = 0;
  }
}

// ─── Periodic Capture (Mode-Aware) ──────────────────────
void periodicCapture() {
  unsigned long now = millis();
  unsigned long interval = 0;

  if (currentMode == "NORMAL") {
    // In learning mode: check if within attendance window (first 15 min)
    if (sessionStartTime > 0 && (now - sessionStartTime) < ATTENDANCE_DURATION_MS) {
      interval = 5000;  // Every 5 seconds during attendance
    } else {
      interval = LEARNING_CAPTURE_INTERVAL_MS;  // Every 5 minutes after
    }
  } else if (currentMode == "TESTING") {
    interval = TESTING_CAPTURE_INTERVAL_MS;  // Every 10 seconds
  } else {
    return;  // IDLE — no periodic captures
  }

  if (now - lastPeriodicCapture >= interval) {
    lastPeriodicCapture = now;

    // Notify gateway that a frame is available to fetch via HTTP
    StaticJsonDocument<128> doc;
    doc["event"] = "periodic_capture";
    doc["mode"] = currentMode;
    doc["url"] = "http://" + WiFi.localIP().toString() + "/capture";
    doc["ts"] = now;

    char buf[128];
    serializeJson(doc, buf);
    mqtt.publish(TOPIC_CAM_FRAME_READY, buf);

    Serial.printf("[CAM] Periodic capture notification (mode=%s, interval=%lums)\n",
                  currentMode.c_str(), interval);
  }
}

// ─── MQTT Publish Helpers ───────────────────────────────
void publishHeartbeat() {
  StaticJsonDocument<256> doc;
  doc["uptime_s"] = uptimeSeconds;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["mode"] = currentMode;
  doc["streaming"] = streamingActive;
  doc["free_heap"] = ESP.getFreeHeap();
  doc["stream_url"] = "http://" + WiFi.localIP().toString() + ":81/stream";

  char buf[256];
  serializeJson(doc, buf);
  mqtt.publish(TOPIC_CAM_HEARTBEAT, buf);
}

void publishFrameReady(size_t frameSize) {
  StaticJsonDocument<128> doc;
  doc["event"] = "frame_captured";
  doc["size"] = frameSize;
  doc["url"] = "http://" + WiFi.localIP().toString() + "/capture";
  doc["ts"] = millis();

  char buf[128];
  serializeJson(doc, buf);
  mqtt.publish(TOPIC_CAM_FRAME_READY, buf);
}
