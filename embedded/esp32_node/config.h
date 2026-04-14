/*
 * config.h — ESP32 Sensor/Actuator Node Configuration
 * Smart AI-IoT Classroom System
 *
 * Update these values to match your network and hardware setup.
 */

#ifndef CONFIG_H
#define CONFIG_H

// ─── WiFi Configuration ─────────────────────────────────
#define WIFI_SSID "Hoang Tam Long"
#define WIFI_PASSWORD "33110035"

// ─── MQTT Broker (Mosquitto in Docker) ──────────────────
#define MQTT_BROKER_IP "192.168.1.104" // IP of the machine running Docker
#define MQTT_BROKER_PORT 1883
#define MQTT_CLIENT_ID "esp32_sensor_node"
#define MQTT_USERNAME "" // Leave empty if anonymous
#define MQTT_PASSWORD ""

// ─── MQTT Topics ────────────────────────────────────────
// Publish (ESP32 → Broker)
#define TOPIC_TEMPERATURE "classroom/sensors/temperature"
#define TOPIC_HUMIDITY "classroom/sensors/humidity"
#define TOPIC_LIGHT "classroom/sensors/light"
#define TOPIC_HEARTBEAT "classroom/status/heartbeat"

// Subscribe (Broker → ESP32)
#define TOPIC_RELAY_PREFIX "classroom/actuators/relay/" // + channel (1-4)
#define TOPIC_RELAY_1 "classroom/actuators/relay/1"
#define TOPIC_RELAY_2 "classroom/actuators/relay/2"
#define TOPIC_RELAY_3 "classroom/actuators/relay/3"
#define TOPIC_RELAY_4 "classroom/actuators/relay/4"
#define TOPIC_ALERT_LED "classroom/actuators/alert_led"
#define TOPIC_MODE "classroom/mode"
#define TOPIC_LCD_LINE1 "classroom/display/line1"
#define TOPIC_LCD_LINE2 "classroom/display/line2"

// ─── GPIO Pin Assignments ───────────────────────────────
// Relay Module (Active LOW — common for relay modules)
#define RELAY_1_PIN 25 // LED Zone 1
#define RELAY_2_PIN 26 // LED Zone 2
#define RELAY_3_PIN 27 // LED Zone 3
#define RELAY_4_PIN 14 // DC Fan 1

// Alert LED
#define ALERT_LED_PIN 32

// DHT20 Sensor (I2C)
// Uses default I2C: SDA = GPIO 21, SCL = GPIO 22

// Light Sensor
#define LIGHT_SENSOR_PIN 34

// LCD 16x2 (I2C)
// Shares I2C bus: SDA = GPIO 21, SCL = GPIO 22
#define LCD_I2C_ADDR 0x27 // Common address; try 0x3F if not working
#define LCD_COLS 16
#define LCD_ROWS 2

// ─── Timing Configuration ───────────────────────────────
#define SENSOR_READ_INTERVAL_MS 5000 // Read DHT20 every 1 second
#define HEARTBEAT_INTERVAL_MS 30000  // Heartbeat every 30 seconds
#define MQTT_RECONNECT_DELAY_MS 5000 // Retry MQTT connection every 5s
#define WIFI_RECONNECT_DELAY_MS 5000 // Retry WiFi every 5s
#define LCD_UPDATE_INTERVAL_MS 2000  // LCD refresh every 2 seconds

// ─── Device Control Thresholds ──────────────────────────
#define TEMP_HIGH_THRESHOLD 28.0     // °C — activate fans
#define TEMP_LOW_THRESHOLD 26.0      // °C — deactivate fans
#define ALERT_LED_DURATION_MS 500 // Alert LED flash duration
#define ALERT_LED_REPEAT 3        // Number of flashes

#endif // CONFIG_H
