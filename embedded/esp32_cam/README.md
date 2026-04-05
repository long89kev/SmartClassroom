# ESP32-CAM Surveillance Node — Setup Guide

## Hardware Required

| Component | Quantity | Purpose |
|-----------|----------|---------|
| AI-Thinker ESP32-CAM | 1 | Camera + WiFi MCU |
| OV2640 Camera Module | 1 | Usually included with ESP32-CAM |
| ESP32-CAM MB HW-381 | 1 | Motherboard / USB Programmer for ESP32-CAM |
| Micro-USB Cable | 1 | For programming and power |

## Board Pinout & Connection (MB HW-381)

Because you are using the **ESP32-CAM MB HW-381 motherboard**, you do not need manual FTDI wiring or jumper cables.

1. **Insert ESP32-CAM**: Align the pins of the ESP32-CAM into the female headers of the MB HW-381 board. The camera should face outward, away from the motherboard.
2. **Connect to PC**: Plug a Micro-USB cable into the MB HW-381 and connect it to your computer.

The MB HW-381 board includes a CH340 USB-to-serial chip and an auto-download circuit. This means:
* No FTDI adapter required.
* No manual `IO0` to `GND` connections.
* No need to manually press the `RST` button to upload (in most cases).
* The board safely regulates power to the ESP32-CAM.

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
| Port | Your CH340 COM port (from MB HW-381) |

### 5. Upload
1. Click **Upload** in Arduino IDE
2. The MB HW-381 auto-download circuit will automatically put the board into programming mode and reset it.
3. Wait for the upload to complete.
4. *Note: If the IDE gets stuck on "Connecting.....", briefly press the **BOOT** (or **IO0**) button on the MB HW-381 board.*
5. Open Serial Monitor at 115200 baud
6. Press the **RST** button on the MB HW-381 if the program doesn't start automatically.

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
| Brownout / rebooting | Verify your USB cable is data+power capable and plugged into a good USB port (MB HW-381 usually solves power issues). |
| No PSRAM detected | Ensure partition scheme is "Huge APP"; some clone boards lack PSRAM |
| Blurry images | Allow camera warm-up; adjust `set_quality` in config |
| Can't upload | If stuck on "Connecting...", press the BOOT/IO0 button on the MB HW-381. Make sure you installed the CH340 driver. |
| Stream laggy | Reduce `FRAME_SIZE` to `FRAMESIZE_CIF` (400×296) |
