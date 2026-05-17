"""
mqtt_gateway.py — MQTT Gateway Service
Smart AI-IoT Classroom System

Bridges Mosquitto MQTT Broker ↔ FastAPI Backend.

Responsibilities:
  1. Subscribe to ESP32 sensor data → update backend database
  2. Receive backend commands (device toggle, mode change) → publish to ESP32
  3. Run device control logic (lighting, HVAC, buzzer)
  4. Fetch ESP32-CAM frames on notification → forward to AI inference

Usage:
  python mqtt_gateway.py
"""

import json
import logging
import signal
import sys
import time
import threading
import requests
import paho.mqtt.client as mqtt

from config import mqtt_config, backend_config, room_config, Topics
from device_controller import DeviceController

# ─── Logging Setup ───────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("MQTTGateway")

# ─── Global State ────────────────────────────────────────
running = True
controller: DeviceController = None
mqtt_client: mqtt.Client = None


# ═══════════════════════════════════════════════════════════
#  MQTT Callbacks
# ═══════════════════════════════════════════════════════════

def on_connect(client, userdata, flags, rc):
    """Called when connected to MQTT broker."""
    if rc == 0:
        logger.info("✓ Connected to MQTT broker")

        # Subscribe to all sensor and status topics
        for topic in Topics.all_subscribe_topics():
            client.subscribe(topic)
            logger.info(f"  Subscribed: {topic}")
        
        client.subscribe("classroom/mode/auto_manual")
        logger.info("  Subscribed: classroom/mode/auto_manual")
    else:
        logger.error(f"✗ MQTT connection failed (rc={rc})")


def on_disconnect(client, userdata, rc):
    """Called when disconnected from MQTT broker."""
    if rc != 0:
        logger.warning(f"Unexpected MQTT disconnect (rc={rc}). Will reconnect...")


def on_message(client, userdata, msg):
    """Route incoming MQTT messages to appropriate handlers."""
    topic = msg.topic
    try:
        payload = msg.payload.decode("utf-8").strip()
    except Exception:
        logger.error(f"Failed to decode payload on {topic}")
        return

    logger.debug(f"[MQTT RX] {topic} → {payload[:100]}")

    try:
        # Parse JSON payload if applicable
        data = None
        if payload.startswith("{"):
            data = json.loads(payload)

        # ─── Sensor Data ─────────────────────────────
        if topic == Topics.TEMPERATURE and data:
            value = data.get("value", 0.0)
            controller.on_temperature(value)
            upsert_sensor_reading_in_backend("TEMPERATURE", value, data.get("unit", "C"), topic)

        elif topic == Topics.HUMIDITY and data:
            value = data.get("value", 0.0)
            controller.on_humidity(value)
            upsert_sensor_reading_in_backend("HUMIDITY", value, data.get("unit", "%"), topic)

        elif topic == Topics.LIGHT and data:
            value = data.get("value", 0.0)
            controller.on_light(value)
            upsert_sensor_reading_in_backend("LIGHT", value, data.get("unit", "%"), topic)

        elif topic == Topics.OCCUPANCY and data:
            count = data.get("count", 0)
            detected = data.get("detected", False)
            controller.on_occupancy(count, detected)
            update_occupancy_in_backend(count, detected)
            upsert_sensor_reading_in_backend("OCCUPANCY", float(count), "people", topic)

        # ─── Heartbeats ──────────────────────────────
        elif topic == Topics.HEARTBEAT and data:
            controller.on_heartbeat(data)

        elif topic == Topics.CAM_HEARTBEAT and data:
            controller.on_cam_heartbeat(data)

        # ─── Camera Events ───────────────────────────
        elif topic == Topics.CAM_STATUS and data:
            logger.info(f"ESP32-CAM status: {data.get('status')} at {data.get('ip')}")

        elif topic == Topics.CAM_FRAME_READY and data:
            handle_frame_ready(data)

        # ─── Relay State Confirmations ───────────────
        elif topic.startswith("classroom/actuators/relay/") and topic.endswith("/state"):
            channel = topic.split("/")[3]
            logger.info(f"Relay CH{channel} confirmed: {payload}")
            
        # ─── Auto/Manual Mode Toggle ───────────────
        elif topic == "classroom/mode/auto_manual":
            is_auto = payload.upper() in ("AUTO", "ON", "1", "TRUE")
            controller.set_auto_mode(is_auto)

    except json.JSONDecodeError:
        logger.error(f"Invalid JSON on {topic}: {payload[:50]}")
    except Exception as e:
        logger.error(f"Error handling {topic}: {e}", exc_info=True)


# ═══════════════════════════════════════════════════════════
#  Backend API Integration
# ═══════════════════════════════════════════════════════════

def upsert_sensor_reading_in_backend(sensor_key: str, value: float, unit: str | None, source_topic: str):
    """Upsert latest room-scoped sensor reading in the backend database."""
    if not room_config.room_id:
        return

    try:
        url = f"{backend_config.api_url}/rooms/{room_config.room_id}/sensor-readings/{sensor_key}"
        data = {
            "value": value,
            "unit": unit,
            "source_topic": source_topic,
        }
        resp = requests.put(url, json=data, timeout=5)
        if resp.status_code == 200:
            logger.debug(f"Sensor reading updated: {sensor_key}={value} {unit or ''}")
        else:
            logger.warning(f"Sensor update failed ({resp.status_code}): {resp.text[:100]}")
    except requests.RequestException as e:
        logger.error(f"Backend sensor connection error: {e}")


def update_occupancy_in_backend(count: int, detected: bool):
    """Update room occupancy in the backend."""
    if not room_config.room_id:
        return

    try:
        url = f"{backend_config.api_url}/rooms/{room_config.room_id}/occupancy"
        data = {
            "occupancy_count": count,
            "is_occupied": detected,
        }
        resp = requests.put(url, json=data, timeout=5)
        if resp.status_code == 200:
            logger.debug(f"Occupancy updated: count={count}, occupied={detected}")
    except requests.RequestException as e:
        logger.error(f"Backend occupancy update error: {e}")


def fetch_active_session():
    """Check backend for active session and sync mode."""
    if not room_config.room_id:
        return None

    try:
        url = f"{backend_config.api_url}/rooms/{room_config.room_id}/sessions/active"
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            sessions = data.get("sessions", [])
            if sessions:
                session = sessions[0]
                mode = session.get("mode", "NORMAL")
                return {"session_id": session.get("session_id"), "mode": mode}
        return None
    except requests.RequestException:
        return None


def fetch_room_thresholds() -> list[dict] | None:
    """
    Fetch the effective thresholds for the configured room from the backend.
    Returns the merged list (room overrides + global defaults) or None on error.
    """
    if not room_config.room_id:
        return None

    try:
        url = f"{backend_config.api_url}/rooms/{room_config.room_id}/thresholds"
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            return resp.json()  # list of {device_type_code, min_value, max_value, ...}
        else:
            logger.warning(f"Threshold fetch failed ({resp.status_code}): {resp.text[:100]}")
            return None
    except requests.RequestException as e:
        logger.error(f"Threshold fetch connection error: {e}")
        return None

def fetch_auto_mode() -> bool | None:
    """Fetch the hardcoded auto/manual mode from the backend."""
    if not room_config.room_id:
        return None
    try:
        url = f"{backend_config.api_url}/rooms/{room_config.room_id}/auto-mode"
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            return resp.json().get("is_auto", True)
        return None
    except requests.RequestException:
        return None


def fetch_device_states() -> list[dict] | None:
    """
    Fetch device states from the backend to detect manual overrides
    triggered by the frontend toggle buttons.
    """
    if not room_config.room_id:
        return None

    try:
        url = f"{backend_config.api_url}/rooms/{room_config.room_id}/devices/status/all"
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            return data.get("device_states", [])
        else:
            logger.warning(f"Device states fetch failed ({resp.status_code})")
            return None
    except requests.RequestException as e:
        logger.error(f"Device states fetch connection error: {e}")
        return None


def clear_manual_override(device_id: str) -> bool:
    """
    Clear the manual_override flag on a device after we've applied it.
    This prevents the gateway from re-applying the same override repeatedly.
    """
    if not room_config.room_id:
        return False

    try:
        url = f"{backend_config.api_url}/devices/{device_id}/clear-override-internal"
        resp = requests.post(url, params={"room_id": room_config.room_id}, timeout=5)
        return resp.status_code == 200
    except requests.RequestException:
        return False


def handle_frame_ready(data: dict):
    """
    Handle frame ready notification from ESP32-CAM.
    Fetches the frame via HTTP and forwards to AI inference endpoint.
    """
    capture_url = data.get("url", "")
    mode = data.get("mode", "NORMAL")

    if not capture_url:
        return

    try:
        # Fetch the JPEG frame from ESP32-CAM
        resp = requests.get(capture_url, timeout=10)
        if resp.status_code != 200:
            logger.error(f"Failed to fetch frame from {capture_url}")
            return

        frame_bytes = resp.content
        logger.info(f"Fetched frame: {len(frame_bytes)} bytes from ESP32-CAM")

        # Forward to AI inference endpoint based on mode
        session = fetch_active_session()
        if not session:
            logger.debug("No active session — frame not forwarded to AI")
            return

        session_id = session["session_id"]

        if mode == "NORMAL":
            # Learning mode: send to behavior detection
            forward_to_learning_inference(session_id, frame_bytes)
        elif mode == "TESTING":
            # Testing mode: send to cheat detection
            forward_to_testing_inference(session_id, frame_bytes)

    except requests.RequestException as e:
        logger.error(f"Frame fetch error: {e}")


def forward_to_learning_inference(session_id: str, frame_bytes: bytes):
    """Forward frame to learning behavior detection endpoint."""
    try:
        url = f"{backend_config.api_url}/sessions/{session_id}/ingest/learning"
        files = {"file": ("frame.jpg", frame_bytes, "image/jpeg")}
        params = {"confidence_threshold": 0.5}
        resp = requests.post(url, files=files, params=params, timeout=30)
        if resp.status_code == 200:
            result = resp.json()
            detections = result.get("detections_count", 0)
            logger.info(f"Learning inference: {detections} detections")
        else:
            logger.warning(f"Learning inference failed: {resp.status_code}")
    except requests.RequestException as e:
        logger.error(f"Learning inference error: {e}")


def forward_to_testing_inference(session_id: str, frame_bytes: bytes):
    """Forward frame to testing/cheat detection endpoint."""
    try:
        url = f"{backend_config.api_url}/sessions/{session_id}/ingest/testing"
        files = {"file": ("frame.jpg", frame_bytes, "image/jpeg")}
        params = {"confidence_threshold": 0.5}
        resp = requests.post(url, files=files, params=params, timeout=30)
        if resp.status_code == 200:
            result = resp.json()
            if result.get("detection_count", 0) > 0:
                logger.warning(f"🚨 {result.get('detection_count')} suspicious behaviors detected!")
                controller.trigger_cheat_alert()

            logger.info(f"Testing inference complete: {len(risk_analysis.get('student_risks', []))} students analyzed")
        else:
            logger.warning(f"Testing inference failed: {resp.status_code}")
    except requests.RequestException as e:
        logger.error(f"Testing inference error: {e}")


# ═══════════════════════════════════════════════════════════
#  Backend Polling (Session Mode Sync)
# ═══════════════════════════════════════════════════════════

def backend_poll_loop():
    """
    Periodically poll the backend for session changes.
    Syncs the mode to ESP32 when sessions start/end or mode changes.
    """
    last_mode = "IDLE"

    while running:
        try:
            session = fetch_active_session()

            if session:
                current_mode = session["mode"]
                if current_mode != last_mode:
                    logger.info(f"Session mode change detected: {last_mode} → {current_mode}")
                    controller.on_mode_change(current_mode)
                    last_mode = current_mode
            else:
                if last_mode != "IDLE":
                    logger.info("No active session — switching to IDLE")
                    controller.on_mode_change("IDLE")
                    last_mode = "IDLE"

        except Exception as e:
            logger.error(f"Backend poll error: {e}")

        time.sleep(10)  # Poll every 10 seconds


def threshold_poll_loop():
    """
    Periodically fetch room thresholds from the backend and push
    into the device controller.  When the user changes min/max on
    the dashboard, the controller will pick up the new values here
    and immediately re-evaluate relay states.
    """
    while running:
        try:
            thresholds_data = fetch_room_thresholds()
            if thresholds_data is not None:
                controller.update_thresholds(thresholds_data)
                
            auto_mode = fetch_auto_mode()
            if auto_mode is not None:
                controller.set_auto_mode(auto_mode)
        except Exception as e:
            logger.error(f"Threshold poll error: {e}")

        time.sleep(10)  # Check every 10 seconds


def device_state_poll_loop():
    """
    Periodically fetch device states from the backend and apply any
    manual overrides triggered by the frontend toggle buttons.

    Flow:
      1. Frontend user clicks ON/OFF button
      2. Backend sets device_state.status + manual_override = True
      3. This loop detects the manual_override flag
      4. Maps device_type → relay channels and publishes MQTT commands
      5. Clears the manual_override flag so it isn't re-applied
    """
    while running:
        try:
            device_states = fetch_device_states()
            if device_states:
                for ds in device_states:
                    if not ds.get("manual_override", False):
                        continue

                    device_id = ds.get("device_id", "")
                    device_type = ds.get("device_type", "").upper()
                    desired_status = ds.get("status", "OFF").upper()
                    on = desired_status == "ON"

                    # Find the specific relay channel for this device ID
                    channel = room_config.device_relay_map.get(device_id)

                    if channel is not None:
                        logger.info(
                            f"Manual override: {device_id} ({device_type}) → {desired_status} "
                            f"(channel: {channel})"
                        )
                        state_str = "ON" if on else "OFF"
                        mqtt_client.publish(Topics.relay(channel), state_str)
                        controller.state.relay_states[channel] = on
                        logger.info(f"  Relay CH{channel} → {state_str}")

                        # Update controller tracking flags
                        if device_type == "AC":
                            controller._ac_was_on = on
                        elif device_type == "FAN":
                            controller._fan_was_on = on
                        elif device_type == "LIGHT":
                            controller._lights_were_on = on
                    else:
                        logger.warning(
                            f"Manual override: {device_id} ({device_type}) — "
                            f"no relay channel mapped for this device ID"
                        )

                    # Clear the override so we don't re-apply it
                    clear_manual_override(device_id)

        except Exception as e:
            logger.error(f"Device state poll error: {e}")

        time.sleep(5)  # Check every 5 seconds for responsive toggle


# ═══════════════════════════════════════════════════════════
#  Periodic Control Loop
# ═══════════════════════════════════════════════════════════

def control_loop():
    """Run periodic device control evaluations."""
    while running:
        try:
            controller.periodic_check()
        except Exception as e:
            logger.error(f"Control loop error: {e}")
        time.sleep(10)


# ═══════════════════════════════════════════════════════════
#  MQTT Publish Helper
# ═══════════════════════════════════════════════════════════

def publish_message(topic: str, payload: str):
    """Publish a message to the MQTT broker."""
    if mqtt_client and mqtt_client.is_connected():
        mqtt_client.publish(topic, payload)
        logger.debug(f"[MQTT TX] {topic} ← {payload[:80]}")
    else:
        logger.warning(f"Cannot publish to {topic} — MQTT not connected")


# ═══════════════════════════════════════════════════════════
#  Main Entry Point
# ═══════════════════════════════════════════════════════════

def signal_handler(sig, frame):
    """Graceful shutdown on Ctrl+C."""
    global running
    logger.info("Shutting down...")
    running = False
    if mqtt_client:
        mqtt_client.disconnect()
    sys.exit(0)


def main():
    global mqtt_client, controller, running

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("=" * 60)
    logger.info("  Smart AI-IoT Classroom — MQTT Gateway")
    logger.info("=" * 60)
    logger.info(f"  MQTT Broker : {mqtt_config.broker_host}:{mqtt_config.broker_port}")
    logger.info(f"  Backend     : {backend_config.api_url}")
    logger.info(f"  Room        : {room_config.room_code} ({room_config.room_id or 'not set'})")
    logger.info("=" * 60)

    # Initialize device controller
    controller = DeviceController(publish_fn=publish_message)

    # Auto-discover room_id from backend if not set
    if not room_config.room_id and room_config.room_code:
        logger.info(f"ROOM_ID not set — resolving from backend using ROOM_CODE={room_config.room_code}...")
        resolved = False
        for attempt in range(10):
            try:
                url = f"{backend_config.api_url}/rooms/by-code/{room_config.room_code}"
                resp = requests.get(url, timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    room_config.room_id = data["room_id"]
                    logger.info(f"✓ Resolved ROOM_ID: {room_config.room_id}")
                    resolved = True
                    break
                else:
                    logger.warning(f"Room lookup attempt {attempt+1} failed ({resp.status_code}): {resp.text[:100]}")
            except requests.RequestException as e:
                logger.warning(f"Room lookup attempt {attempt+1} error: {e}")
            time.sleep(3)

        if not resolved:
            logger.error("✗ Could not resolve ROOM_ID from backend. Sensor data will NOT be forwarded.")
    elif not room_config.room_code:
        logger.warning("No ROOM_CODE configured — sensor data forwarding disabled")

    # Initialize MQTT client
    mqtt_client = mqtt.Client(
        client_id=mqtt_config.client_id,
        protocol=mqtt.MQTTv311
    )

    if mqtt_config.username:
        mqtt_client.username_pw_set(mqtt_config.username, mqtt_config.password)

    mqtt_client.on_connect = on_connect
    mqtt_client.on_disconnect = on_disconnect
    mqtt_client.on_message = on_message

    # Connect to MQTT broker with retry
    connected = False
    while not connected and running:
        try:
            logger.info("Connecting to MQTT broker...")
            mqtt_client.connect(
                mqtt_config.broker_host,
                mqtt_config.broker_port,
                mqtt_config.keepalive
            )
            connected = True
        except Exception as e:
            logger.error(f"MQTT connection failed: {e}. Retrying in 5s...")
            time.sleep(5)

    # Start background threads
    poll_thread = threading.Thread(target=backend_poll_loop, daemon=True)
    poll_thread.start()
    logger.info("✓ Backend poll thread started")

    threshold_thread = threading.Thread(target=threshold_poll_loop, daemon=True)
    threshold_thread.start()
    logger.info("✓ Threshold poll thread started")

    device_state_thread = threading.Thread(target=device_state_poll_loop, daemon=True)
    device_state_thread.start()
    logger.info("✓ Device state poll thread started")

    control_thread = threading.Thread(target=control_loop, daemon=True)
    control_thread.start()
    logger.info("✓ Device control thread started")

    # Start MQTT loop (blocking)
    logger.info("✓ MQTT gateway running — press Ctrl+C to stop")
    try:
        mqtt_client.loop_forever()
    except KeyboardInterrupt:
        pass
    finally:
        running = False
        mqtt_client.disconnect()
        logger.info("Gateway stopped.")


if __name__ == "__main__":
    main()
