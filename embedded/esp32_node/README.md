# ESP32 Sensor/Actuator Node — Setup Guide

## Hardware Required

| Component | Quantity | Purpose |
|-----------|----------|---------|
| ESP32 DevKit V1 | 1 | Main controller |
| DHT22 Sensor (1-Wire) | 1 | Temperature & humidity |
| Analog Light Sensor (LDR)| 1 | Ambient light level |
| 4-Channel Relay Module (5V, Active LOW) | 1 | Device control |
| 16x2 I2C LCD Display | 1 | Status display |
| 5V Buzzer | 1 | Audio alerts |
| Miniature LEDs or LED strips | 3 | Simulating zone lighting |
| Miniature DC Fan (5V) | 1 | Simulating HVAC |
| Breadboard + Jumper wires | — | Connections |
| 5V Power Supply | 1 | Relay module power |

## Wiring Diagram

```
ESP32 DevKit V1
┌──────────────────────────┐
│                          │
│  GPIO 25 ──────── Relay CH1 IN ──── LED Zone 1
│  GPIO 26 ──────── Relay CH2 IN ──── LED Zone 2
│  GPIO 27 ──────── Relay CH3 IN ──── LED Zone 3
│  GPIO 14 ──────── Relay CH4 IN ──── DC Fan 1
│                          │
│  GPIO 32 ──────── Buzzer (+)
│  GND ─────────── Buzzer (-)
│                          │
│  GPIO 21 (SDA) ─── LCD SDA
│  GPIO 22 (SCL) ─── LCD SCL
│
│  GPIO 4  ───────── DHT22 Data
│  3.3V ──────────┬─ DHT22 VCC
│  GND ───────────┴─ DHT22 GND  │
│                          │
│  GPIO 34 ───────── Light Sensor (AO)
│  3.3V ──────────── Light Sensor VCC
│  GND ───────────── Light Sensor GND
│                          │
│  5V (VIN) ─────── LCD VCC ────┘
│  GND ─────────── LCD GND
│                          │
│  5V (VIN) ──────── Relay VCC
│  GND ──────────── Relay GND
│                          │
└──────────────────────────┘
```

### Important Notes
- **Relay module**: Most 4-channel relays are **Active LOW** — `LOW` signal = relay ON
- **I2C bus**: LCD uses I2C bus (SDA=21, SCL=22)
- **1-Wire bus**: DHT22 uses GPIO 4
- **Light sensor**: Analog output connected to GPIO 34
- **LCD address**: Default `0x27`. If it doesn't work, try `0x3F` (update in `config.h`)
- **Power**: Use the 5V pin (VIN) for relay and LCD. DHT22 and Light Sensor run on 3.3V

## Software Setup

### 1. Install Arduino IDE
Download from https://www.arduino.cc/en/software

### 2. Add ESP32 Board Support
1. Go to **File → Preferences**
2. Add to **Additional Board Manager URLs**:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
3. Go to **Tools → Board → Board Manager**
4. Search "ESP32" and install **esp32 by Espressif Systems**

### 3. Install Required Libraries
In **Sketch → Include Library → Manage Libraries**, install:

| Library | Author | Version |
|---------|--------|---------|
| PubSubClient | Nick O'Leary | 2.8+ |
| DHT sensor library | Adafruit | 1.4+ |
| Adafruit Unified Sensor | Adafruit | 1.1+ |
| LiquidCrystal_I2C | Frank de Brabander | 1.1.2+ |
| ArduinoJson | Benoit Blanchon | 6.x |

### 4. Configure
Edit `config.h`:
```cpp
// Your WiFi
#define WIFI_SSID         "YourWiFiName"
#define WIFI_PASSWORD     "YourWiFiPassword"

// IP of the machine running Docker (Mosquitto broker)
#define MQTT_BROKER_IP    "192.168.1.100"
```

> **Finding your Docker host IP**: Run `ipconfig` (Windows) or `ifconfig` (Linux/Mac)
> and use your machine's local IP address on the same WiFi network.

### 5. Flash to ESP32
1. Connect ESP32 via USB
2. **Tools → Board**: "ESP32 Dev Module"
3. **Tools → Port**: Select the COM port
4. **Tools → Upload Speed**: 921600
5. Click **Upload** (→ button)
6. Open **Serial Monitor** at 115200 baud to see logs

## Verification

After flashing, the Serial Monitor should show:
```
╔══════════════════════════════════════╗
║  Smart AI-IoT Classroom - ESP32 Node ║
╚══════════════════════════════════════╝
[SENSOR] DHT22 initialized
[SENSOR] Light sensor initialized
[LCD] 16x2 LCD initialized
[RELAY] 4-channel relay initialized (all OFF)
[BUZZER] Buzzer initialized
[WiFi] Connecting to YourWiFiName... Connected! IP: 192.168.1.200
[MQTT] Connecting to broker... Connected!
[MQTT] Subscribed to all control topics
[READY] System initialized successfully
```

### Test with MQTT CLI
```bash
# See sensor data
docker exec doai_mosquitto mosquitto_sub -t "classroom/sensors/#" -v

# Toggle relay CH1 (LED Zone 1)
docker exec doai_mosquitto mosquitto_pub -t "classroom/actuators/relay/1" -m "ON"

# Trigger buzzer
docker exec doai_mosquitto mosquitto_pub -t "classroom/actuators/buzzer" -m "ALERT"

# Change mode
docker exec doai_mosquitto mosquitto_pub -t "classroom/mode" -m "TESTING"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| WiFi won't connect | Verify SSID/password; ensure 2.4GHz (ESP32 doesn't support 5GHz) |
| MQTT connection failed | Check broker IP; ensure Mosquitto is running; check port 1883 is open |
| LCD shows nothing | Try address `0x3F`; check I2C wiring; run I2C scanner sketch |
| DHT22 read error | Check Data pin wiring; ensure 3.3V power; check pull-up resistor (typically 10kΩ on Data to 3.3V) |
| Relay not switching | Verify Active LOW logic; check 5V power to relay VCC |
