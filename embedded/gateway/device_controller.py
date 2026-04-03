"""
device_controller.py — Device Control Logic Engine
Smart AI-IoT Classroom System

Implements the control logic from PDF Section 7:
  - Lighting: zone-based, off after 10 min idle
  - HVAC: temp > 28°C → fans ON, < 26°C → fans OFF
  - Buzzer: cheat alert in testing mode
  - LCD: mode + sensor display
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Callable

from config import thresholds, room_config, Topics

logger = logging.getLogger(__name__)


@dataclass
class RoomState:
    """Current state of the classroom."""
    temperature: float = 0.0
    humidity: float = 0.0
    is_occupied: bool = False
    occupancy_count: int = 0
    mode: str = "IDLE"              # IDLE, NORMAL, TESTING
    session_active: bool = False

    # Relay states (True = ON)
    relay_states: Dict[int, bool] = field(default_factory=lambda: {
        1: False, 2: False, 3: False, 4: False
    })

    # Timing
    last_occupied_time: float = 0.0
    session_start_time: float = 0.0
    last_sensor_update: float = 0.0

    # ESP32 health
    esp32_online: bool = False
    esp32_last_heartbeat: float = 0.0
    esp32_cam_online: bool = False
    esp32_cam_last_heartbeat: float = 0.0


class DeviceController:
    """
    Evaluates device control rules based on sensor data and session state.
    Returns a list of MQTT commands to publish.
    """

    def __init__(self, publish_fn: Callable[[str, str], None]):
        """
        Args:
            publish_fn: Function to publish MQTT messages (topic, payload)
        """
        self.state = RoomState()
        self.publish = publish_fn
        self._fan_was_on = False
        self._lights_were_on = False

    # ─── Sensor Update Handlers ──────────────────────────

    def on_temperature(self, value: float):
        """Handle temperature reading from DHT20."""
        self.state.temperature = value
        self.state.last_sensor_update = time.time()
        logger.debug(f"Temperature updated: {value}°C")
        self._evaluate_hvac()

    def on_humidity(self, value: float):
        """Handle humidity reading from DHT20."""
        self.state.humidity = value
        logger.debug(f"Humidity updated: {value}%")

    def on_occupancy(self, count: int, detected: bool):
        """Handle occupancy detection update."""
        self.state.occupancy_count = count
        self.state.is_occupied = detected

        if detected:
            self.state.last_occupied_time = time.time()

        logger.info(f"Occupancy: {count} people, occupied={detected}")
        self._evaluate_lighting()
        self._evaluate_hvac()

    def on_mode_change(self, new_mode: str):
        """Handle system mode change."""
        old_mode = self.state.mode
        self.state.mode = new_mode.upper()

        if self.state.mode in ("NORMAL", "TESTING"):
            self.state.session_active = True
            if old_mode == "IDLE":
                self.state.session_start_time = time.time()
        elif self.state.mode == "IDLE":
            self.state.session_active = False
            self.state.session_start_time = 0

        logger.info(f"Mode changed: {old_mode} → {self.state.mode}")

        # Push mode to ESP32
        self.publish(Topics.MODE, self.state.mode)

        # Mode-specific actions
        if self.state.mode == "TESTING":
            self._enter_testing_mode()
        elif self.state.mode == "NORMAL":
            self._enter_learning_mode()
        elif self.state.mode == "IDLE":
            self._enter_idle_mode()

        self._update_lcd()

    def on_heartbeat(self, data: dict):
        """Handle ESP32 heartbeat."""
        self.state.esp32_online = True
        self.state.esp32_last_heartbeat = time.time()
        logger.debug(f"ESP32 heartbeat: uptime={data.get('uptime_s', '?')}s")

    def on_cam_heartbeat(self, data: dict):
        """Handle ESP32-CAM heartbeat."""
        self.state.esp32_cam_online = True
        self.state.esp32_cam_last_heartbeat = time.time()
        logger.debug(f"ESP32-CAM heartbeat: uptime={data.get('uptime_s', '?')}s")

    # ─── Cheat Alert (Testing Mode) ─────────────────────

    def trigger_cheat_alert(self, student_id: str = None):
        """Trigger buzzer alert for suspected cheating."""
        if self.state.mode != "TESTING":
            logger.warning("Cheat alert ignored — not in TESTING mode")
            return

        if not thresholds.cheat_alert_enabled:
            return

        logger.warning(f"🚨 CHEAT ALERT! Student: {student_id or 'unknown'}")
        self.publish(Topics.BUZZER, "ALERT")

        # Update LCD
        self.publish(Topics.LCD_LINE2, "!ALERT DETECTED!")

    # ─── Control Logic: Lighting (Section 7.1) ──────────

    def _evaluate_lighting(self):
        """
        Lighting Control Logic:
        - Lights ON only during active session
        - Zone-based (all zones on when occupied)
        - OFF after 10 minutes with no occupancy
        """
        if not self.state.session_active:
            # No session — check idle timeout
            if self.state.is_occupied:
                # Someone in room but no session — keep lights on
                self._set_all_lights(True)
            else:
                idle_seconds = time.time() - self.state.last_occupied_time
                idle_minutes = idle_seconds / 60.0

                if idle_minutes >= thresholds.idle_lights_off_minutes:
                    if self._lights_were_on:
                        logger.info(f"Lights OFF — idle for {idle_minutes:.0f} min")
                        self._set_all_lights(False)
            return

        # Active session — lights follow occupancy
        if self.state.is_occupied:
            self._set_all_lights(True)
        else:
            # Session active but no one detected — wait for idle timeout
            idle_seconds = time.time() - self.state.last_occupied_time
            if idle_seconds / 60.0 >= thresholds.idle_lights_off_minutes:
                self._set_all_lights(False)

    def _set_all_lights(self, on: bool):
        """Control all lighting relay channels."""
        light_channels = [ch for ch, dtype in room_config.relay_device_type.items()
                         if dtype == "LIGHT"]

        for ch in light_channels:
            if self.state.relay_states.get(ch) != on:
                self._set_relay(ch, on)

        self._lights_were_on = on

    # ─── Control Logic: HVAC (Section 7.2) ───────────────

    def _evaluate_hvac(self):
        """
        HVAC Control Logic:
        - temp > 28°C + occupied → fans ON
        - temp < 26°C → fans OFF
        - 25-27°C → fans only for air circulation
        """
        if not self.state.is_occupied:
            # No occupancy — turn off HVAC
            if self._fan_was_on:
                logger.info("Fans OFF — room unoccupied")
                self._set_all_fans(False)
            return

        temp = self.state.temperature

        if temp > thresholds.temp_high:
            # Hot — fans ON
            if not self._fan_was_on:
                logger.info(f"Fans ON — temperature {temp}°C > {thresholds.temp_high}°C")
                self._set_all_fans(True)

        elif temp < thresholds.temp_low:
            # Cool enough — fans OFF
            if self._fan_was_on:
                logger.info(f"Fans OFF — temperature {temp}°C < {thresholds.temp_low}°C")
                self._set_all_fans(False)

        elif thresholds.temp_moderate_low <= temp <= thresholds.temp_moderate_high:
            # Moderate — fans on for air circulation
            if not self._fan_was_on:
                logger.info(f"Fans ON (moderate) — temperature {temp}°C")
                self._set_all_fans(True)

    def _set_all_fans(self, on: bool):
        """Control all fan relay channels."""
        fan_channels = [ch for ch, dtype in room_config.relay_device_type.items()
                       if dtype == "FAN"]

        for ch in fan_channels:
            if self.state.relay_states.get(ch) != on:
                self._set_relay(ch, on)

        self._fan_was_on = on

    # ─── Mode Transition Actions ─────────────────────────

    def _enter_learning_mode(self):
        """Actions when entering NORMAL (learning) mode."""
        logger.info("── Entering LEARNING mode ──")
        # Turn on lights
        self._set_all_lights(True)
        # Update LCD
        self.publish(Topics.LCD_LINE1, "Mode: LEARNING")
        self.publish(Topics.LCD_LINE2, "Session Active")
        # Enable camera periodic captures
        self.publish(Topics.CAM_STREAM, "START")

    def _enter_testing_mode(self):
        """
        Actions when entering TESTING mode (Section 7.4):
        - Buzzer authorized for alerts
        - LCD shows exam status
        - Camera switches to active monitoring
        """
        logger.info("── Entering TESTING mode ──")
        # Alert buzzer: mode switch notification
        self.publish(Topics.BUZZER, "ALERT")
        # LCD lockdown display
        self.publish(Topics.LCD_LINE1, "Mode: TESTING")
        self.publish(Topics.LCD_LINE2, "EXAM IN PROGRESS")
        # Camera to active monitoring
        self.publish(Topics.CAM_STREAM, "START")

    def _enter_idle_mode(self):
        """Actions when entering IDLE mode."""
        logger.info("── Entering IDLE mode ──")
        self.publish(Topics.LCD_LINE1, "Mode: IDLE")
        self.publish(Topics.LCD_LINE2, "Standby")
        self.publish(Topics.CAM_STREAM, "STOP")

    # ─── Relay Helpers ───────────────────────────────────

    def _set_relay(self, channel: int, on: bool):
        """Set a single relay channel and track state."""
        state_str = "ON" if on else "OFF"
        self.state.relay_states[channel] = on
        self.publish(Topics.relay(channel), state_str)

        device_type = room_config.relay_device_type.get(channel, "UNKNOWN")
        logger.info(f"Relay CH{channel} ({device_type}): {state_str}")

    # ─── Manual Override from Backend ────────────────────

    def manual_device_toggle(self, device_id: str, action: str):
        """
        Handle manual device toggle from the backend/dashboard.
        Overrides automatic control.
        """
        channel = room_config.device_relay_map.get(device_id)
        if channel is None:
            logger.warning(f"Unknown device: {device_id}")
            return

        on = action.upper() == "ON"
        self._set_relay(channel, on)
        logger.info(f"Manual override: {device_id} → {action}")

    # ─── LCD Update ──────────────────────────────────────

    def _update_lcd(self):
        """Update LCD with current sensor data."""
        temp_str = f"T:{self.state.temperature:.1f}C"
        hum_str = f"H:{self.state.humidity:.0f}%"
        line2 = f"{temp_str} {hum_str}"
        self.publish(Topics.LCD_LINE2, line2)

    # ─── Periodic Check (called from gateway loop) ───────

    def periodic_check(self):
        """
        Run periodic control evaluations.
        Called every ~10 seconds from the gateway main loop.
        """
        # Re-evaluate lighting idle timeout
        if not self.state.is_occupied and self._lights_were_on:
            self._evaluate_lighting()

        # Check ESP32 health (offline if no heartbeat for 2 minutes)
        now = time.time()
        if self.state.esp32_online and (now - self.state.esp32_last_heartbeat > 120):
            self.state.esp32_online = False
            logger.warning("ESP32 sensor node: OFFLINE (no heartbeat)")

        if self.state.esp32_cam_online and (now - self.state.esp32_cam_last_heartbeat > 120):
            self.state.esp32_cam_online = False
            logger.warning("ESP32-CAM: OFFLINE (no heartbeat)")

        # Update LCD with sensor data periodically
        if self.state.session_active:
            self._update_lcd()

    def get_status(self) -> dict:
        """Return current controller state summary."""
        return {
            "mode": self.state.mode,
            "temperature": self.state.temperature,
            "humidity": self.state.humidity,
            "is_occupied": self.state.is_occupied,
            "occupancy_count": self.state.occupancy_count,
            "relay_states": {
                f"CH{k} ({room_config.relay_device_type.get(k, '?')})": ("ON" if v else "OFF")
                for k, v in self.state.relay_states.items()
            },
            "esp32_online": self.state.esp32_online,
            "esp32_cam_online": self.state.esp32_cam_online,
            "session_active": self.state.session_active,
        }
