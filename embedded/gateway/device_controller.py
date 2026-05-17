"""
device_controller.py — Device Control Logic Engine
Smart AI-IoT Classroom System

Implements the control logic from PDF Section 7:
  - Lighting: zone-based, off after 10 min idle
  - HVAC: temp > 28°C → fans ON, < 26°C → fans OFF
  - Buzzer: cheat alert in testing mode
  - LCD: mode + sensor display

Thresholds are fetched dynamically from the backend API so that
changes made through the frontend Dashboard take effect in real time.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Callable

from config import thresholds as default_thresholds, room_config, Topics

logger = logging.getLogger(__name__)


@dataclass
class DynamicThreshold:
    """Threshold values for a single device type, fetched from the backend."""
    device_type: str = ""
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    target_value: Optional[float] = None
    enabled: bool = True


@dataclass
class RoomState:
    """Current state of the classroom."""
    temperature: float = 0.0
    humidity: float = 0.0
    light: float = 0.0
    is_occupied: bool = False
    occupancy_count: int = 0
    mode: str = "IDLE"              # IDLE, NORMAL, TESTING
    session_active: bool = False

    # Relay states (True = ON)
    relay_states: Dict[int, bool] = field(default_factory=lambda: {
        1: False, 2: False, 3: False, 4: False
    })
    
    # Control Mode
    is_auto: bool = True

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
        self._ac_was_on = False

        # Dynamic thresholds keyed by device_type (e.g. "AC", "FAN", "LIGHT")
        # Initialised from the static defaults so control works before the
        # first backend fetch completes.
        self._thresholds: Dict[str, DynamicThreshold] = {
            "AC": DynamicThreshold(
                device_type="AC",
                min_value=default_thresholds.temp_low,
                max_value=default_thresholds.temp_high,
                target_value=(default_thresholds.temp_low + default_thresholds.temp_high) / 2,
                enabled=True,
            ),
            "FAN": DynamicThreshold(
                device_type="FAN",
                min_value=default_thresholds.temp_moderate_low,
                max_value=default_thresholds.temp_moderate_high,
                target_value=(default_thresholds.temp_moderate_low + default_thresholds.temp_moderate_high) / 2,
                enabled=True,
            ),
            "LIGHT": DynamicThreshold(
                device_type="LIGHT",
                min_value=None,
                max_value=None,
                target_value=None,
                enabled=True,
            ),
        }

    # ─── Dynamic Threshold Management ────────────────────

    def get_threshold(self, device_type: str) -> Optional[DynamicThreshold]:
        """Return the current dynamic threshold for a device type."""
        return self._thresholds.get(device_type.upper())

    def update_thresholds(self, backend_thresholds: list[dict]):
        """
        Replace the in-memory thresholds with values fetched from the backend.
        Each item: {device_type_code, min_value, max_value, target_value, enabled}

        After updating, immediately re-evaluate all device states so that
        relay changes take effect without waiting for the next sensor reading.
        """
        changed = False
        for item in backend_thresholds:
            key = item.get("device_type_code", "").upper()
            if not key:
                continue

            new_th = DynamicThreshold(
                device_type=key,
                min_value=item.get("min_value"),
                max_value=item.get("max_value"),
                target_value=item.get("target_value"),
                enabled=bool(item.get("enabled", True)),
            )

            old_th = self._thresholds.get(key)
            if old_th is None or (
                old_th.min_value != new_th.min_value
                or old_th.max_value != new_th.max_value
                or old_th.target_value != new_th.target_value
                or old_th.enabled != new_th.enabled
            ):
                self._thresholds[key] = new_th
                if old_th is not None:
                    logger.info(
                        f"Threshold updated: {key} → "
                        f"min={new_th.min_value}, target={new_th.target_value}, "
                        f"max={new_th.max_value}, enabled={new_th.enabled}"
                    )
                changed = True

        if changed:
            logger.info("Re-evaluating all device states after threshold change")
            self._evaluate_all()

    def _evaluate_all(self):
        """Re-evaluate every control rule. Called after threshold changes."""
        self._evaluate_ac()
        self._evaluate_fan()
        self._evaluate_light_level()
        self._evaluate_lighting()

    # ─── Sensor Update Handlers ──────────────────────────

    def on_temperature(self, value: float):
        """Handle temperature reading from DHT22."""
        self.state.temperature = value
        self.state.last_sensor_update = time.time()
        logger.debug(f"Temperature updated: {value}°C")
        self._evaluate_ac()

    def on_humidity(self, value: float):
        """Handle humidity reading from DHT22."""
        self.state.humidity = value
        logger.debug(f"Humidity updated: {value}%")
        self._evaluate_fan()

    def on_light(self, value: float):
        """Handle light reading."""
        self.state.light = value
        logger.debug(f"Light updated: {value}%")
        self._evaluate_light_level()

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

        if not default_thresholds.cheat_alert_enabled:
            return

        logger.warning(f"🚨 CHEAT ALERT! Student: {student_id or 'unknown'}")
        self.publish(Topics.BUZZER, "ALERT")

        # Update LCD
        self.publish(Topics.LCD_LINE2, "!ALERT DETECTED!")

    # ─── Control Logic: Lighting (Section 7.1) ──────────

    def _has_light_sensor_thresholds(self) -> bool:
        """Return True when a LIGHT threshold with min/max is configured,
        meaning the light-sensor control should take priority."""
        light_th = self.get_threshold("LIGHT")
        if not light_th or not light_th.enabled:
            return False
        return light_th.min_value is not None or light_th.max_value is not None

    def _evaluate_lighting(self):
        """
        Occupancy-based Lighting Control (Section 7.1).
        Turns off lights if room is empty for > timeout.
        """
        if not self.state.is_auto:
            return

        light_th = self.get_threshold("LIGHT")
        if light_th and not light_th.enabled:
            # Threshold disabled -> allow manual control (do nothing)
            return

        # If sensor-based thresholds are active, let _evaluate_light_level
        # handle all lighting decisions to avoid the two systems conflicting.
        if self._has_light_sensor_thresholds():
            return

        if not self.state.session_active:
            # No session — check idle timeout
            if self.state.is_occupied:
                # Someone in room but no session — keep lights on
                self._set_all_lights(True)
            else:
                idle_seconds = time.time() - self.state.last_occupied_time
                idle_minutes = idle_seconds / 60.0

                if idle_minutes >= default_thresholds.idle_lights_off_minutes:
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
            if idle_seconds / 60.0 >= default_thresholds.idle_lights_off_minutes:
                self._set_all_lights(False)

    def _evaluate_light_level(self):
        """
        Light-sensor threshold control.
        If a LIGHT threshold with min/max is configured from the dashboard,
        turn lights ON when ambient light drops below min (too dark),
        and OFF when it rises above max (bright enough).
        """
        light_th = self.get_threshold("LIGHT")
        if not light_th or not light_th.enabled:
            return
        if light_th.min_value is None and light_th.max_value is None:
            return

        reading = self.state.light  # 0–100 %

        if light_th.min_value is not None and reading < light_th.min_value:
            # Ambient light is too low → turn lights ON
            if not self._lights_were_on:
                logger.info(
                    f"Lights ON — ambient light {reading}% < min threshold {light_th.min_value}%"
                )
                self._set_all_lights(True)

        elif light_th.max_value is not None and reading > light_th.max_value:
            # Ambient light is high enough → turn lights OFF
            if self._lights_were_on:
                logger.info(
                    f"Lights OFF — ambient light {reading}% > max threshold {light_th.max_value}%"
                )
                self._set_all_lights(False)

    def _set_all_lights(self, on: bool):
        """Control all lighting relay channels."""
        light_channels = [ch for ch, dtype in room_config.relay_device_type.items()
                         if dtype == "LIGHT"]

        for ch in light_channels:
            if self.state.relay_states.get(ch) != on:
                self._set_relay(ch, on)

        self._lights_were_on = on

    # ─── Control Logic: HVAC (AC & FAN) ───────────────

    def _evaluate_ac(self):
        """
        AC Control Logic using dynamic thresholds from the dashboard.
        The AC threshold drives AC behaviour based on temperature.
        """
        if not self.state.is_auto:
            return

        ac_th = self.get_threshold("AC")

        # If threshold is explicitly disabled, allow manual control (do nothing)
        if ac_th and not ac_th.enabled:
            return

        temp = self.state.temperature

        # Resolve effective min / max
        if ac_th and ac_th.max_value is not None and ac_th.min_value is not None:
            eff_max = ac_th.max_value
            eff_min = ac_th.min_value
        else:
            eff_max = default_thresholds.temp_high
            eff_min = default_thresholds.temp_low

        if temp > eff_max:
            if not self._ac_was_on:
                logger.info(f"AC ON — temperature {temp}°C > max threshold {eff_max}°C")
                self._set_all_acs(True)
        elif temp < eff_min:
            if self._ac_was_on:
                logger.info(f"AC OFF — temperature {temp}°C < min threshold {eff_min}°C")
                self._set_all_acs(False)

    def _evaluate_fan(self):
        """
        FAN Control Logic using dynamic thresholds from the dashboard.
        The FAN threshold drives FAN behaviour based on humidity.
        """
        if not self.state.is_auto:
            return

        fan_th = self.get_threshold("FAN")

        # If threshold is explicitly disabled, allow manual control (do nothing)
        if fan_th and not fan_th.enabled:
            return

        humidity = self.state.humidity

        # We'll use the dynamic threshold, or fallback to some hardcoded values if missing
        if fan_th and fan_th.max_value is not None and fan_th.min_value is not None:
            eff_max = fan_th.max_value
            eff_min = fan_th.min_value
        else:
            eff_max = 70.0  # Fallback high humidity
            eff_min = 60.0  # Fallback low humidity

        if humidity > eff_max:
            if not self._fan_was_on:
                logger.info(f"Fans ON — humidity {humidity}% > max threshold {eff_max}%")
                self._set_all_fans(True)
        elif humidity < eff_min:
            if self._fan_was_on:
                logger.info(f"Fans OFF — humidity {humidity}% < min threshold {eff_min}%")
                self._set_all_fans(False)

    def _set_all_acs(self, on: bool):
        """Control all AC relay channels."""
        ac_channels = [ch for ch, dtype in room_config.relay_device_type.items()
                       if dtype == "AC"]

        for ch in ac_channels:
            if self.state.relay_states.get(ch) != on:
                self._set_relay(ch, on)

        self._ac_was_on = on

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

    def set_auto_mode(self, is_auto: bool):
        """Toggle hardcoded auto/manual mode from MQTT."""
        if self.state.is_auto != is_auto:
            self.state.is_auto = is_auto
            logger.info(f"Control Mode changed to: {'AUTO' if is_auto else 'MANUAL'}")
            if is_auto:
                logger.info("Re-evaluating rules on entering AUTO mode.")
                self._evaluate_all()

    def periodic_check(self):
        """
        Run periodic control evaluations.
        Called every ~10 seconds from the gateway main loop.
        """
        # Re-evaluate lighting idle timeout
        if not self.state.is_occupied and self._lights_were_on:
            self._evaluate_lighting()

        # Re-evaluate light-level threshold in case reading is stale
        self._evaluate_light_level()

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
            "light": self.state.light,
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
