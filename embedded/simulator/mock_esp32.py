"""
mock_esp32.py — Mock ESP32 Simulator
Smart AI-IoT Classroom System

Simulates an ESP32 sensor/actuator node by publishing fake sensor
data and subscribing to control commands via MQTT. Use this for
testing without physical hardware.

Usage:
  python mock_esp32.py [--broker HOST] [--port PORT]
"""

import argparse
import json
import logging
import random
import signal
import sys
import time
import paho.mqtt.client as mqtt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("MockESP32")

# ─── Default Settings ────────────────────────────────────
BROKER_HOST = "localhost"
BROKER_PORT = 1883

# Simulated sensor ranges
TEMP_BASE = 27.0
TEMP_VARIANCE = 3.0
HUMIDITY_BASE = 60.0
HUMIDITY_VARIANCE = 15.0
OCCUPANCY_BASE = 25

# Track relay states
relay_states = {1: "OFF", 2: "OFF", 3: "OFF", 4: "OFF"}
buzzer_state = "OFF"
current_mode = "IDLE"
running = True


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        logger.info("✓ Connected to MQTT broker")
        # Subscribe to actuator commands
        client.subscribe("classroom/actuators/relay/+")
        client.subscribe("classroom/actuators/buzzer")
        client.subscribe("classroom/mode")
        client.subscribe("classroom/display/line1")
        client.subscribe("classroom/display/line2")
        logger.info("  Subscribed to control topics")
    else:
        logger.error(f"Connection failed (rc={rc})")


def on_message(client, userdata, msg):
    global current_mode
    topic = msg.topic
    payload = msg.payload.decode("utf-8").strip()

    if topic.startswith("classroom/actuators/relay/"):
        channel = topic.split("/")[-1]
        relay_states[int(channel)] = payload
        logger.info(f"  💡 Relay CH{channel}: {payload}")
        # Publish confirmation
        client.publish(f"{topic}/state", payload)

    elif topic == "classroom/actuators/buzzer":
        logger.info(f"  🔔 Buzzer: {payload}")
        if payload == "ALERT":
            logger.info("  🚨 BEEP BEEP BEEP!")

    elif topic == "classroom/mode":
        current_mode = payload
        logger.info(f"  🔄 Mode changed: {current_mode}")

    elif topic.startswith("classroom/display/"):
        line = "1" if "line1" in topic else "2"
        logger.info(f"  📺 LCD Line {line}: {payload}")


def publish_sensors(client):
    """Publish simulated sensor data."""
    # Temperature with slight random walk
    temp = TEMP_BASE + random.uniform(-TEMP_VARIANCE, TEMP_VARIANCE)
    temp = round(temp, 1)

    humidity = HUMIDITY_BASE + random.uniform(-HUMIDITY_VARIANCE, HUMIDITY_VARIANCE)
    humidity = round(max(30, min(95, humidity)), 1)

    # Publish temperature
    temp_data = json.dumps({"value": temp, "unit": "C", "ts": int(time.time() * 1000)})
    client.publish("classroom/sensors/temperature", temp_data)

    # Publish humidity
    hum_data = json.dumps({"value": humidity, "unit": "%", "ts": int(time.time() * 1000)})
    client.publish("classroom/sensors/humidity", hum_data)

    logger.info(f"  📡 Sensors: {temp}°C, {humidity}%")

    return temp, humidity


def publish_occupancy(client):
    """Publish simulated occupancy data."""
    count = random.randint(0, OCCUPANCY_BASE)
    detected = count > 0

    occ_data = json.dumps({"count": count, "detected": detected})
    client.publish("classroom/sensors/occupancy", occ_data)

    logger.info(f"  👥 Occupancy: {count} people")
    return count


def publish_heartbeat(client, uptime, temp, humidity):
    """Publish simulated heartbeat."""
    heartbeat = json.dumps({
        "uptime_s": uptime,
        "ip": "192.168.1.200",
        "rssi": random.randint(-80, -40),
        "temp": temp,
        "humidity": humidity,
        "mode": current_mode,
        "free_heap": random.randint(150000, 250000),
        "relays": [relay_states[i] for i in range(1, 5)]
    })
    client.publish("classroom/status/heartbeat", heartbeat)
    logger.debug("  ❤️ Heartbeat sent")


def publish_cam_status(client):
    """Publish simulated ESP32-CAM status."""
    status = json.dumps({
        "status": "online",
        "ip": "192.168.1.201",
        "stream_url": "http://192.168.1.201:81/stream",
        "capture_url": "http://192.168.1.201/capture"
    })
    client.publish("classroom/camera/status", status, retain=True)
    logger.info("  📷 ESP32-CAM status published")


def signal_handler(sig, frame):
    global running
    logger.info("Shutting down...")
    running = False


def main():
    global BROKER_HOST, BROKER_PORT, running

    parser = argparse.ArgumentParser(description="Mock ESP32 Simulator")
    parser.add_argument("--broker", default="localhost", help="MQTT broker host")
    parser.add_argument("--port", type=int, default=1883, help="MQTT broker port")
    parser.add_argument("--interval", type=int, default=5, help="Sensor publish interval (sec)")
    args = parser.parse_args()

    BROKER_HOST = args.broker
    BROKER_PORT = args.port

    signal.signal(signal.SIGINT, signal_handler)

    logger.info("=" * 50)
    logger.info("  Mock ESP32 Sensor/Actuator Simulator")
    logger.info(f"  Broker: {BROKER_HOST}:{BROKER_PORT}")
    logger.info(f"  Interval: {args.interval}s")
    logger.info("=" * 50)

    client = mqtt.Client(client_id="mock_esp32_simulator")
    client.on_connect = on_connect
    client.on_message = on_message

    # Connect with retry
    connected = False
    while not connected and running:
        try:
            client.connect(BROKER_HOST, BROKER_PORT, 60)
            connected = True
        except Exception as e:
            logger.error(f"Connection failed: {e}. Retrying in 3s...")
            time.sleep(3)

    if not connected:
        return

    client.loop_start()

    # Publish initial camera status
    time.sleep(1)
    publish_cam_status(client)

    # Main simulation loop
    uptime = 0
    sensor_count = 0

    try:
        while running:
            sensor_count += 1

            # Publish sensor data
            temp, humidity = publish_sensors(client)

            # Publish occupancy every 3rd cycle
            if sensor_count % 3 == 0:
                publish_occupancy(client)

            # Publish heartbeat every 6th cycle
            if sensor_count % 6 == 0:
                uptime += args.interval * 6
                publish_heartbeat(client, uptime, temp, humidity)

            # Simulate periodic camera frame notification
            if current_mode in ("NORMAL", "TESTING") and sensor_count % 12 == 0:
                frame_data = json.dumps({
                    "event": "periodic_capture",
                    "mode": current_mode,
                    "url": "http://192.168.1.201/capture",
                    "ts": int(time.time() * 1000)
                })
                client.publish("classroom/camera/frame_ready", frame_data)
                logger.info("  📷 Camera frame notification sent")

            # Print relay states summary
            relay_summary = " | ".join(
                f"CH{k}:{v}" for k, v in relay_states.items()
            )
            logger.info(f"  ⚡ Relays: {relay_summary}")
            logger.info(f"  Mode: {current_mode}")
            logger.info("─" * 40)

            time.sleep(args.interval)

    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()
        logger.info("Simulator stopped.")


if __name__ == "__main__":
    main()
