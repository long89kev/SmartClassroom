/*
 * esp32_node.ino — Smart AI-IoT Classroom Sensor/Actuator Node
 *
 * Hardware:
 *   - ESP32 DevKit V1
 *   - DHT22 (1-Wire) — Temperature & Humidity sensor
 *   - 4-Channel Relay Module (Active LOW)
 *   - 16x2 I2C LCD Display
 *   - 5V Buzzer
 *
 * Communication:
 *   - WiFi → Mosquitto MQTT Broker (Docker)
 *
 * Required Libraries (install via Arduino Library Manager):
 *   - WiFi (built-in)
 *   - PubSubClient by Nick O'Leary
 *   - DHT sensor library by Adafruit
 *   - Adafruit Unified Sensor
 *   - LiquidCrystal_I2C by Frank de Brabander
 *   - ArduinoJson by Benoit Blanchon
 *   - Wire (built-in)
 */

#include "config.h"
#include <ArduinoJson.h>
#include <DHT.h>
#include <LiquidCrystal_I2C.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <Wire.h>

// ─── Global Objects ─────────────────────────────────────
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
DHT dht(DHT_PIN, DHT_TYPE);
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, LCD_COLS, LCD_ROWS);

// ─── State Variables ────────────────────────────────────
float currentTemp = 0.0;
float currentHumidity = 0.0;
float currentLight = 0.0;
String currentMode = "IDLE";
bool relayStates[4] = {false, false, false, false};
unsigned long lastSensorRead = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastLcdUpdate = 0;
unsigned long uptimeSeconds = 0;
String lcdLine1 = "Smart Classroom";
String lcdLine2 = "Initializing...";

// ─── Function Declarations ──────────────────────────────
void setupWiFi();
void setupMQTT();
void mqttCallback(char *topic, byte *payload, unsigned int length);
void reconnectMQTT();
void readSensors();
void publishSensorData();
void publishHeartbeat();
void updateLCD();
void setRelay(int channel, bool state);
void triggerBuzzer(int repeats, int durationMs);
void handleRelayCommand(int channel, String command);
void handleBuzzerCommand(String command);
void handleModeChange(String newMode);

// ─── Setup ──────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("╔══════════════════════════════════════╗");
  Serial.println("║  Smart AI-IoT Classroom - ESP32 Node ║");
  Serial.println("╚══════════════════════════════════════╝");

  // Initialize I2C
  Wire.begin();

  // Initialize DHT22
  dht.begin();
  Serial.println("[SENSOR] DHT22 initialized");

  // Initialize LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Smart Classroom");
  lcd.setCursor(0, 1);
  lcd.print("Starting...");
  Serial.println("[LCD] 16x2 LCD initialized");

  // Initialize Relay pins (Active LOW)
  int relayPins[] = {RELAY_1_PIN, RELAY_2_PIN, RELAY_3_PIN, RELAY_4_PIN};
  for (int i = 0; i < 4; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], HIGH); // HIGH = OFF for active-low relay
  }
  Serial.println("[RELAY] 4-channel relay initialized (all OFF)");

  // Initialize Buzzer
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  Serial.println("[BUZZER] Buzzer initialized");

  // Initialize Light Sensor
  pinMode(LIGHT_SENSOR_PIN, INPUT);
  Serial.println("[SENSOR] Light sensor initialized");

  // Connect WiFi
  setupWiFi();

  // Connect MQTT
  setupMQTT();

  // Startup beep
  triggerBuzzer(1, 100);

  Serial.println("[READY] System initialized successfully");
  lcdLine1 = "Mode: IDLE";
  lcdLine2 = "Connecting...";
}

// ─── Main Loop ──────────────────────────────────────────
void loop() {
  // Maintain MQTT connection
  if (!mqtt.connected()) {
    reconnectMQTT();
  }
  mqtt.loop();

  unsigned long now = millis();

  // Read sensors periodically
  if (now - lastSensorRead >= SENSOR_READ_INTERVAL_MS) {
    lastSensorRead = now;
    readSensors();
    publishSensorData();
  }

  // Send heartbeat periodically
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    uptimeSeconds = now / 1000;
    publishHeartbeat();
  }

  // Update LCD periodically
  if (now - lastLcdUpdate >= LCD_UPDATE_INTERVAL_MS) {
    lastLcdUpdate = now;
    updateLCD();
  }
}

// ─── WiFi Setup ─────────────────────────────────────────
void setupWiFi() {
  Serial.print("[WiFi] Connecting to ");
  Serial.print(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("[WiFi] Connected! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("[WiFi] FAILED to connect. Restarting...");
    ESP.restart();
  }
}

// ─── MQTT Setup ─────────────────────────────────────────
void setupMQTT() {
  mqtt.setServer(MQTT_BROKER_IP, MQTT_BROKER_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512); // Increase for JSON payloads
  reconnectMQTT();
}

void reconnectMQTT() {
  int attempts = 0;
  while (!mqtt.connected() && attempts < 5) {
    Serial.print("[MQTT] Connecting to broker...");

    bool connected;
    if (strlen(MQTT_USERNAME) > 0) {
      connected = mqtt.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD);
    } else {
      connected = mqtt.connect(MQTT_CLIENT_ID);
    }

    if (connected) {
      Serial.println(" Connected!");

      // Subscribe to control topics
      mqtt.subscribe(TOPIC_RELAY_1);
      mqtt.subscribe(TOPIC_RELAY_2);
      mqtt.subscribe(TOPIC_RELAY_3);
      mqtt.subscribe(TOPIC_RELAY_4);
      mqtt.subscribe(TOPIC_BUZZER);
      mqtt.subscribe(TOPIC_MODE);
      mqtt.subscribe(TOPIC_LCD_LINE1);
      mqtt.subscribe(TOPIC_LCD_LINE2);

      Serial.println("[MQTT] Subscribed to all control topics");
      lcdLine2 = "MQTT Connected";
    } else {
      Serial.print(" Failed (rc=");
      Serial.print(mqtt.state());
      Serial.println("). Retrying...");
      delay(MQTT_RECONNECT_DELAY_MS);
    }
    attempts++;
  }
}

// ─── MQTT Callback (Incoming Messages) ─────────────────
void mqttCallback(char *topic, byte *payload, unsigned int length) {
  // Convert payload to string
  String message;
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  message.trim();

  Serial.print("[MQTT RX] ");
  Serial.print(topic);
  Serial.print(" → ");
  Serial.println(message);

  String topicStr = String(topic);

  // Handle relay commands
  if (topicStr == TOPIC_RELAY_1) {
    handleRelayCommand(1, message);
  } else if (topicStr == TOPIC_RELAY_2) {
    handleRelayCommand(2, message);
  } else if (topicStr == TOPIC_RELAY_3) {
    handleRelayCommand(3, message);
  } else if (topicStr == TOPIC_RELAY_4) {
    handleRelayCommand(4, message);
  }
  // Handle buzzer
  else if (topicStr == TOPIC_BUZZER) {
    handleBuzzerCommand(message);
  }
  // Handle mode change
  else if (topicStr == TOPIC_MODE) {
    handleModeChange(message);
  }
  // Handle LCD text
  else if (topicStr == TOPIC_LCD_LINE1) {
    lcdLine1 = message.substring(0, LCD_COLS);
  } else if (topicStr == TOPIC_LCD_LINE2) {
    lcdLine2 = message.substring(0, LCD_COLS);
  }
}

// ─── Sensor Reading ─────────────────────────────────────
void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  int rawLight = analogRead(LIGHT_SENSOR_PIN);
  currentLight = (rawLight / 4095.0) * 100.0;
  Serial.print("%  Light: ");
  Serial.println(currentLight, 1);

  if (currentLight >= 80.0) {
    setRelay(1, true);
    setRelay(2, true);
    setRelay(3, true);
  }

  if (!isnan(t) && !isnan(h)) {
    currentTemp = t;
    currentHumidity = h;

    Serial.print("[SENSOR] Temp: ");
    Serial.print(currentTemp, 1);
    Serial.print("°C  Humidity: ");
    Serial.print(currentHumidity, 1);
    Serial.println("%");
  } else {
    Serial.println("[SENSOR] DHT22 read error");
  }
}

// ─── Publish Sensor Data ────────────────────────────────
void publishSensorData() {
  // Publish temperature
  StaticJsonDocument<128> tempDoc;
  tempDoc["value"] = round(currentTemp * 10.0) / 10.0;
  tempDoc["unit"] = "C";
  tempDoc["ts"] = millis();
  char tempBuf[128];
  serializeJson(tempDoc, tempBuf);
  mqtt.publish(TOPIC_TEMPERATURE, tempBuf);

  // Publish humidity
  StaticJsonDocument<128> humDoc;
  humDoc["value"] = round(currentHumidity * 10.0) / 10.0;
  humDoc["unit"] = "%";
  humDoc["ts"] = millis();
  char humBuf[128];
  serializeJson(humDoc, humBuf);
  mqtt.publish(TOPIC_HUMIDITY, humBuf);

  // Publish light
  StaticJsonDocument<128> lightDoc;
  lightDoc["value"] = round(currentLight * 10.0) / 10.0;
  lightDoc["unit"] = "%";
  lightDoc["ts"] = millis();
  char lightBuf[128];
  serializeJson(lightDoc, lightBuf);
  mqtt.publish(TOPIC_LIGHT, lightBuf);
}

// ─── Publish Heartbeat ──────────────────────────────────
void publishHeartbeat() {
  StaticJsonDocument<256> doc;
  doc["uptime_s"] = uptimeSeconds;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["temp"] = currentTemp;
  doc["humidity"] = currentHumidity;
  doc["light"] = currentLight;
  doc["mode"] = currentMode;
  doc["free_heap"] = ESP.getFreeHeap();

  JsonArray relays = doc.createNestedArray("relays");
  for (int i = 0; i < 4; i++) {
    relays.add(relayStates[i] ? "ON" : "OFF");
  }

  char buf[256];
  serializeJson(doc, buf);
  mqtt.publish(TOPIC_HEARTBEAT, buf);

  Serial.print("[HEARTBEAT] Uptime: ");
  Serial.print(uptimeSeconds);
  Serial.print("s | Free heap: ");
  Serial.println(ESP.getFreeHeap());
}

// ─── Relay Control ──────────────────────────────────────
void handleRelayCommand(int channel, String command) {
  bool state = (command == "ON" || command == "1" || command == "on");
  setRelay(channel, state);
}

void setRelay(int channel, bool state) {
  if (channel < 1 || channel > 4)
    return;

  int pins[] = {RELAY_1_PIN, RELAY_2_PIN, RELAY_3_PIN, RELAY_4_PIN};
  int pin = pins[channel - 1];

  // Active LOW relay: LOW = ON, HIGH = OFF
  digitalWrite(pin, state ? LOW : HIGH);
  relayStates[channel - 1] = state;

  const char *deviceNames[] = {"LED Zone 1", "LED Zone 2", "LED Zone 3",
                               "DC Fan 1"};
  Serial.print("[RELAY] ");
  Serial.print(deviceNames[channel - 1]);
  Serial.print(" (CH");
  Serial.print(channel);
  Serial.print("): ");
  Serial.println(state ? "ON" : "OFF");

  // Publish state confirmation back
  String stateTopic = String(TOPIC_RELAY_PREFIX) + String(channel) + "/state";
  mqtt.publish(stateTopic.c_str(), state ? "ON" : "OFF");
}

// ─── Buzzer Control ─────────────────────────────────────
void handleBuzzerCommand(String command) {
  if (command == "ALERT" || command == "ON" || command == "1") {
    Serial.println("[BUZZER] ALERT triggered!");
    triggerBuzzer(BUZZER_ALERT_REPEAT, BUZZER_ALERT_DURATION_MS);
  } else if (command == "OFF" || command == "0") {
    digitalWrite(BUZZER_PIN, LOW);
    Serial.println("[BUZZER] OFF");
  }
}

void triggerBuzzer(int repeats, int durationMs) {
  for (int i = 0; i < repeats; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(durationMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < repeats - 1) {
      delay(durationMs); // Gap between beeps
    }
  }
}

// ─── Mode Change Handler ────────────────────────────────
void handleModeChange(String newMode) {
  newMode.toUpperCase();
  currentMode = newMode;

  Serial.print("[MODE] Changed to: ");
  Serial.println(currentMode);

  // Update LCD line 1 with mode
  lcdLine1 = "Mode: " + currentMode;

  // Mode-specific actions
  if (currentMode == "TESTING") {
    // Testing mode: alert beep
    triggerBuzzer(2, 200);
    lcdLine2 = "EXAM IN PROGRESS";
  } else if (currentMode == "NORMAL") {
    lcdLine2 = "Learning Active";
  } else {
    // IDLE
    lcdLine2 = "Standby";
  }
}

// ─── LCD Update ─────────────────────────────────────────
void updateLCD() {
  // Line 1: Mode or custom text
  lcd.setCursor(0, 0);
  String line1 = lcdLine1;
  // Pad to 16 chars to clear old text
  while (line1.length() < LCD_COLS)
    line1 += " ";
  lcd.print(line1.substring(0, LCD_COLS));

  // Line 2: Sensor data or custom text
  lcd.setCursor(0, 1);
  String line2;
  if (lcdLine2 == "" || lcdLine2 == "auto") {
    // Auto mode: show sensor data
    line2 = String(currentTemp, 1) + "C " + String(currentHumidity, 0) + "%";
  } else {
    line2 = lcdLine2;
  }
  while (line2.length() < LCD_COLS)
    line2 += " ";
  lcd.print(line2.substring(0, LCD_COLS));
}
