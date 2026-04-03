# Embedded System — Smart AI-IoT Classroom

This directory contains all embedded/IoT components for the Smart Classroom system.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Docker Host (Laptop)                      │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  PostgreSQL   │  │    Redis     │  │   Mosquitto MQTT      │  │
│  │  :5432        │  │    :6379     │  │   :1883 (MQTT)        │  │
│  └──────┬───────┘  └──────────────┘  │   :9001 (WebSocket)   │  │
│         │                             └───────────┬───────────┘  │
│         │                                         │              │
│  ┌──────┴───────┐                    ┌────────────┴──────────┐  │
│  │   FastAPI     │◄───── REST ──────►│   MQTT Gateway        │  │
│  │   Backend     │                    │   (Python)            │  │
│  │   :8000       │                    │                       │  │
│  └──────────────┘                    └────────────┬──────────┘  │
│                                                   │              │
└───────────────────────────────────────────────────┼──────────────┘
                                                    │ MQTT (WiFi)
                                    ┌───────────────┼──────────────┐
                                    │               │              │
                              ┌─────┴─────┐  ┌─────┴──────┐       │
                              │  ESP32     │  │ ESP32-CAM  │       │
                              │  Sensor/   │  │ Surveil-   │       │
                              │  Actuator  │  │ lance      │       │
                              │  Node      │  │ Node       │       │
                              └───────────┘  └────────────┘       │
                                    │               │              │
                                    │  Physical Classroom          │
                                    └──────────────────────────────┘
```

## Directory Structure

```
embedded/
├── esp32_node/          # ESP32 Sensor/Actuator firmware (Arduino)
│   ├── config.h         # WiFi, MQTT, pin configuration
│   ├── esp32_node.ino   # Main firmware
│   └── README.md        # Wiring & setup guide
│
├── esp32_cam/           # ESP32-CAM Surveillance firmware (Arduino)
│   ├── config.h         # Camera & MQTT configuration
│   ├── esp32_cam.ino    # Main firmware
│   └── README.md        # Setup guide
│
├── gateway/             # Python MQTT Gateway (runs in Docker)
│   ├── config.py        # MQTT topics, thresholds, mappings
│   ├── device_controller.py  # Control logic (lighting, HVAC, buzzer)
│   ├── mqtt_gateway.py  # Main gateway service
│   ├── requirements.txt
│   └── Dockerfile
│
└── simulator/           # Testing tools
    └── mock_esp32.py    # Simulates ESP32 without hardware
```

## Quick Start

### 1. Start Infrastructure (Docker)

```bash
# From project root
docker-compose up -d postgres redis mosquitto
```

Verify Mosquitto is running:
```bash
# Subscribe to all topics (terminal 1)
docker exec doai_mosquitto mosquitto_sub -t "classroom/#" -v

# Publish a test message (terminal 2)
docker exec doai_mosquitto mosquitto_pub -t "classroom/test" -m "hello"
```

### 2. Option A: Run with Mock Simulator (No Hardware)

```bash
# Terminal 1: Start the mock ESP32
cd embedded/simulator
pip install paho-mqtt
python mock_esp32.py --broker localhost --port 1883

# Terminal 2: Start the gateway
cd embedded/gateway
pip install -r requirements.txt
python mqtt_gateway.py
```

### 2. Option B: Flash Real Hardware

See:
- [ESP32 Sensor Node Setup](esp32_node/README.md)
- [ESP32-CAM Setup](esp32_cam/README.md)

### 3. Start Full Stack

```bash
docker-compose up -d
```

This starts: PostgreSQL, Redis, Mosquitto, Backend, Frontend, and MQTT Gateway.

## MQTT Topic Reference

| Topic | Direction | Payload | Description |
|-------|-----------|---------|-------------|
| `classroom/sensors/temperature` | ESP32 → GW | `{"value": 28.5, "unit": "C"}` | DHT20 temp |
| `classroom/sensors/humidity` | ESP32 → GW | `{"value": 65.0, "unit": "%"}` | DHT20 humidity |
| `classroom/sensors/occupancy` | ESP32 → GW | `{"count": 5, "detected": true}` | Room occupancy |
| `classroom/actuators/relay/1` | GW → ESP32 | `"ON"` / `"OFF"` | LED Zone 1 |
| `classroom/actuators/relay/2` | GW → ESP32 | `"ON"` / `"OFF"` | LED Zone 2 |
| `classroom/actuators/relay/3` | GW → ESP32 | `"ON"` / `"OFF"` | LED Zone 3 |
| `classroom/actuators/relay/4` | GW → ESP32 | `"ON"` / `"OFF"` | DC Fan 1 |
| `classroom/actuators/buzzer` | GW → ESP32 | `"ALERT"` / `"OFF"` | Buzzer |
| `classroom/display/line1` | GW → ESP32 | `"Mode: LEARNING"` | LCD line 1 |
| `classroom/display/line2` | GW → ESP32 | `"T:28.5C H:65%"` | LCD line 2 |
| `classroom/mode` | GW → ESP32 | `"NORMAL"` / `"TESTING"` / `"IDLE"` | System mode |
| `classroom/status/heartbeat` | ESP32 → GW | JSON status | ESP32 alive |
| `classroom/camera/status` | CAM → GW | JSON (IP, URLs) | Camera online |
| `classroom/camera/frame_ready` | CAM → GW | JSON (capture URL) | Frame available |
| `classroom/camera/capture` | GW → CAM | `"NOW"` | Trigger capture |
| `classroom/camera/stream` | GW → CAM | `"START"` / `"STOP"` | Stream control |

## Device Control Logic (PDF Section 7)

### Lighting
- Lights ON only during scheduled class hours
- Zone-based activation based on occupancy
- All lights OFF after 10 minutes of zero occupancy

### HVAC (Fan Control)
- **temp > 28°C** + occupied → Fans ON
- **temp < 26°C** → Fans OFF
- **25°C–27°C** → Fans ON for air circulation only

### Camera Policy
- **Attendance** (first 15 min): frequent captures every 5s
- **Learning mode**: periodic captures every 5 min (occupancy)
- **Testing mode**: active monitoring every 10s

### Buzzer & LCD
- **Testing mode entry**: 2-beep notification
- **Cheat detected**: 3-beep alert
- **LCD**: shows current mode + sensor readings
