"""Quick test: publish sensor data to local MQTT broker for room A1-F1-R02."""
import json
import time
import paho.mqtt.client as mqtt

MQTT_BROKER = "localhost"
MQTT_PORT = 1883

try:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
except AttributeError:
    client = mqtt.Client()

client.connect(MQTT_BROKER, MQTT_PORT, 60)
client.loop_start()
time.sleep(0.5)

# Publish test sensor data
client.publish("classroom/sensors/temperature", json.dumps({"value": 25.4, "unit": "C"}))
client.publish("classroom/sensors/humidity", json.dumps({"value": 65.2, "unit": "%"}))
client.publish("classroom/sensors/light", json.dumps({"value": 420.0, "unit": "%"}))

time.sleep(1)
client.loop_stop()
client.disconnect()
print("✓ Published temperature=25.4°C, humidity=65.2%, light=420.0%")
