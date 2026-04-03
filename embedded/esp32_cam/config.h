/*
 * config.h — ESP32-CAM Surveillance Node Configuration
 * Smart AI-IoT Classroom System
 *
 * Board: AI-Thinker ESP32-CAM
 * Camera: OV2640
 */

#ifndef CONFIG_H
#define CONFIG_H

// ─── WiFi Configuration ─────────────────────────────────
#define WIFI_SSID         "Hcmut4"
#define WIFI_PASSWORD     "08092005long"

// ─── MQTT Broker (Mosquitto in Docker) ──────────────────
#define MQTT_BROKER_IP    "192.168.43.234"   // IP of the machine running Docker
#define MQTT_BROKER_PORT  1883
#define MQTT_CLIENT_ID    "esp32_cam_node"
#define MQTT_USERNAME     ""
#define MQTT_PASSWORD     ""

// ─── MQTT Topics ────────────────────────────────────────
// Publish (ESP32-CAM → Broker)
#define TOPIC_CAM_STATUS        "classroom/camera/status"
#define TOPIC_CAM_HEARTBEAT     "classroom/camera/heartbeat"
#define TOPIC_CAM_FRAME_READY   "classroom/camera/frame_ready"

// Subscribe (Broker → ESP32-CAM)
#define TOPIC_CAM_CAPTURE       "classroom/camera/capture"     // Trigger single capture
#define TOPIC_CAM_STREAM        "classroom/camera/stream"      // Start/stop streaming
#define TOPIC_CAM_CONFIG        "classroom/camera/config"      // Config changes
#define TOPIC_MODE              "classroom/mode"               // System mode

// ─── Camera Pin Definitions (AI-Thinker ESP32-CAM) ──────
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// Flash LED
#define FLASH_GPIO_NUM     4

// ─── HTTP Streaming Server ──────────────────────────────
#define STREAM_PORT       81    // HTTP stream at http://<ESP32_IP>:81/stream
#define CAPTURE_PORT      80    // Single capture at http://<ESP32_IP>/capture

// ─── Camera Settings ────────────────────────────────────
#define FRAME_SIZE        FRAMESIZE_VGA    // 640x480 (good balance)
#define JPEG_QUALITY      12               // 0-63, lower = better quality
#define FB_COUNT          2                // Frame buffer count

// ─── Timing Configuration ───────────────────────────────
#define HEARTBEAT_INTERVAL_MS     30000    // Heartbeat every 30s
#define MQTT_RECONNECT_DELAY_MS   5000
#define WIFI_RECONNECT_DELAY_MS   5000

// ─── Capture Modes ──────────────────────────────────────
// Learning mode: periodic capture every N seconds
#define LEARNING_CAPTURE_INTERVAL_MS  300000   // Every 5 minutes
// Testing mode: capture on demand or continuous
#define TESTING_CAPTURE_INTERVAL_MS   10000    // Every 10 seconds
// Attendance: first 15 minutes continuous
#define ATTENDANCE_DURATION_MS        900000   // 15 minutes

#endif // CONFIG_H
