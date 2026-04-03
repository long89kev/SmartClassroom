# ESP32-CAM Surveillance Node — Setup Guide

## Hardware Required

| Component | Quantity | Purpose |
|-----------|----------|---------|
| AI-Thinker ESP32-CAM | 1 | Camera + WiFi MCU |
| OV2640 Camera Module | 1 | Usually included with ESP32-CAM |
| FTDI USB-to-Serial Adapter (3.3V) | 1 | For programming (ESP32-CAM has no USB) |
| Jumper wires | — | Connections |

## Board Pinout (AI-Thinker ESP32-CAM)

```
       ┌───────────────────────┐
       │     ESP32-CAM         │
       │   (AI-Thinker)        │
       │                       │
       │  5V ─── FTDI 5V       │
       │  GND ── FTDI GND      │
       │  U0R ── FTDI TX       │
       │  U0T ── FTDI RX       │
       │                       │
       │  IO0 ── GND           │  ← Connect during upload ONLY
       │                       │
       │  GPIO4 = Flash LED    │  (built-in)
       │                       │
       │  ┌─────────┐          │
       │  │ OV2640  │          │
       │  │ Camera  │          │
       │  └─────────┘          │
       └───────────────────────┘
```

### Programming Connection
```
FTDI Adapter        ESP32-CAM
────────────        ─────────
5V           ──────  5V
GND          ──────  GND
TX           ──────  U0R
RX           ──────  U0T

                     IO0 ──── GND  (only during upload!)
```

> **Important**: Remove the IO0 → GND jumper AFTER uploading, then press the RST button to boot normally.

## Software Setup

### 1. Arduino IDE & ESP32 Board
Same as the [ESP32 Sensor Node setup](../esp32_node/README.md#2-add-esp32-board-support).

### 2. Install Required Libraries
In **Sketch → Include Library → Manage Libraries**:

| Library | Author | Version |
|---------|--------|---------|
| PubSubClient | Nick O'Leary | 2.8+ |
| ArduinoJson | Benoit Blanchon | 6.x |

> `esp_camera` and `esp_http_server` are built-in with the ESP32 board package.

### 3. Configure
Edit `config.h`:
```cpp
#define WIFI_SSID         "YourWiFiName"
#define WIFI_PASSWORD     "YourWiFiPassword"
#define MQTT_BROKER_IP    "192.168.1.100"    // Docker host IP
```

### 4. Board Settings in Arduino IDE

| Setting | Value |
|---------|-------|
| Board | AI Thinker ESP32-CAM |
| Upload Speed | 115200 |
| CPU Frequency | 240MHz |
| Flash Frequency | 80MHz |
| Flash Mode | QIO |
| Partition Scheme | Huge APP (3MB No OTA / 1MB SPIFFS) |
| Port | Your FTDI COM port |

### 5. Upload
1. Connect IO0 → GND (enter programming mode)
2. Press RST button on ESP32-CAM
3. Click **Upload** in Arduino IDE
4. Wait for "Connecting....." then upload completes
5. **Disconnect IO0 from GND**
6. Press RST to reboot into normal mode
7. Open Serial Monitor at 115200 baud

## Endpoints

After boot, the ESP32-CAM exposes:

| URL | Method | Description |
|-----|--------|-------------|
| `http://<IP>/capture` | GET | Single JPEG frame |
| `http://<IP>/status` | GET | JSON status info |
| `http://<IP>:81/stream` | GET | MJPEG live stream |

## Capture Modes

The camera adjusts its behavior based on the system mode (received via MQTT):

| Mode | Capture Interval | Purpose |
|------|-----------------|---------|
| IDLE | No captures | Camera standby |
| NORMAL (first 15 min) | Every 5 seconds | Attendance detection |
| NORMAL (after 15 min) | Every 5 minutes | Occupancy counting |
| TESTING | Every 10 seconds | Cheat detection monitoring |

## Verification

Serial Monitor output after successful boot:
```
╔══════════════════════════════════════════╗
║  Smart AI-IoT Classroom - ESP32-CAM Node ║
╚══════════════════════════════════════════╝
[CAM] PSRAM found — using high quality
[CAM] Camera initialized successfully
[WiFi] Connecting to YourWiFiName... Connected! IP: 192.168.1.201
[HTTP] Capture server started on port 80
[HTTP] Stream server started on port 81
[MQTT] Connecting... Connected!
[MQTT] Subscribed to camera topics
[READY] ESP32-CAM initialized
[STREAM] http://192.168.1.201:81/stream
[CAPTURE] http://192.168.1.201/capture
```

### Test Endpoints
```bash
# View live stream (open in browser)
http://192.168.1.201:81/stream

# Capture single frame
curl http://192.168.1.201/capture -o test_frame.jpg

# Check status
curl http://192.168.1.201/status

# Trigger capture via MQTT
docker exec doai_mosquitto mosquitto_pub -t "classroom/camera/capture" -m "NOW"

# Change mode via MQTT
docker exec doai_mosquitto mosquitto_pub -t "classroom/mode" -m "TESTING"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Camera init failed (0x20001) | Check camera ribbon cable; ensure correct pin definitions |
| Brownout / rebooting | Insufficient power — use a good 5V/2A supply, not just FTDI |
| No PSRAM detected | Ensure partition scheme is "Huge APP"; some clone boards lack PSRAM |
| Blurry images | Allow camera warm-up; adjust `set_quality` in config |
| Can't upload | Ensure IO0 is connected to GND; press RST before upload |
| Stream laggy | Reduce `FRAME_SIZE` to `FRAMESIZE_CIF` (400×296) |
