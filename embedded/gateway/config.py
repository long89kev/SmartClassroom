"""
config.py — MQTT Gateway Configuration
Smart AI-IoT Classroom System
"""

import os
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class MQTTConfig:
    """Mosquitto MQTT Broker settings."""
    broker_host: str = os.getenv("MQTT_BROKER_HOST", "localhost")
    broker_port: int = int(os.getenv("MQTT_BROKER_PORT", "1883"))
    username: str = os.getenv("MQTT_USERNAME", "")
    password: str = os.getenv("MQTT_PASSWORD", "")
    client_id: str = os.getenv("MQTT_CLIENT_ID", "gateway_python")
    keepalive: int = 60


@dataclass
class BackendConfig:
    """FastAPI Backend connection."""
    base_url: str = os.getenv("BACKEND_URL", "http://localhost:8000")
    api_prefix: str = "/api"

    @property
    def api_url(self) -> str:
        return f"{self.base_url}{self.api_prefix}"


@dataclass
class RoomConfig:
    """Room-to-device mapping for the classroom."""
    room_id: str = os.getenv("ROOM_ID", "")  # UUID from database
    room_code: str = os.getenv("ROOM_CODE", "B1-103")

    # Device ID → Relay channel mapping
    device_relay_map: Dict[str, int] = field(default_factory=lambda: {
        "light_zone1": 1,    # Relay CH1 → LED Zone 1
        "light_zone2": 2,    # Relay CH2 → LED Zone 2
        "light_zone3": 3,    # Relay CH3 → LED Zone 3
        "fan_1": 4,          # Relay CH4 → DC Fan 1
    })

    # Device types for each relay channel
    relay_device_type: Dict[int, str] = field(default_factory=lambda: {
        1: "LIGHT",
        2: "LIGHT",
        3: "LIGHT",
        4: "FAN",
    })


# ─── MQTT Topic Schema ──────────────────────────────────

class Topics:
    """MQTT topic constants matching ESP32 firmware."""

    # Sensor topics (ESP32 → Gateway)
    TEMPERATURE = "classroom/sensors/temperature"
    HUMIDITY = "classroom/sensors/humidity"
    OCCUPANCY = "classroom/sensors/occupancy"

    # Actuator topics (Gateway → ESP32)
    RELAY_PREFIX = "classroom/actuators/relay/"
    BUZZER = "classroom/actuators/buzzer"

    # Display topics (Gateway → ESP32)
    LCD_LINE1 = "classroom/display/line1"
    LCD_LINE2 = "classroom/display/line2"

    # System topics
    MODE = "classroom/mode"
    HEARTBEAT = "classroom/status/heartbeat"

    # Camera topics (ESP32-CAM)
    CAM_STATUS = "classroom/camera/status"
    CAM_HEARTBEAT = "classroom/camera/heartbeat"
    CAM_FRAME_READY = "classroom/camera/frame_ready"
    CAM_CAPTURE = "classroom/camera/capture"
    CAM_STREAM = "classroom/camera/stream"

    @classmethod
    def relay(cls, channel: int) -> str:
        return f"{cls.RELAY_PREFIX}{channel}"

    @classmethod
    def all_subscribe_topics(cls) -> List[str]:
        """Topics the gateway should subscribe to."""
        return [
            cls.TEMPERATURE,
            cls.HUMIDITY,
            cls.OCCUPANCY,
            cls.HEARTBEAT,
            cls.CAM_STATUS,
            cls.CAM_HEARTBEAT,
            cls.CAM_FRAME_READY,
            # Also subscribe to relay state confirmations
            "classroom/actuators/relay/+/state",
        ]


# ─── Control Thresholds ─────────────────────────────────

@dataclass
class ControlThresholds:
    """Device control logic thresholds from PDF Section 7."""
    # HVAC
    temp_high: float = 28.0    # °C — activate fans + AC
    temp_low: float = 26.0     # °C — deactivate fans
    temp_moderate_low: float = 25.0
    temp_moderate_high: float = 27.0

    # Lighting
    idle_lights_off_minutes: int = 10  # Turn off lights after 10 min empty

    # Camera
    attendance_duration_minutes: int = 15  # Camera active first 15 min

    # Buzzer
    cheat_alert_enabled: bool = True


# ─── Singleton Instances ─────────────────────────────────

mqtt_config = MQTTConfig()
backend_config = BackendConfig()
room_config = RoomConfig()
thresholds = ControlThresholds()
