#include <Wire.h>
#include "DFRobot_DHT20.h"

DFRobot_DHT20 dht20;

void setup() {
  Serial.begin(115200);
  delay(1500); // Give the sensor time to power up
  while (!dht20.begin()) {
    Serial.println("Failed to initialize!");
    delay(1000);
  }
}

void loop() {
  float temperature = dht20.getTemperature();
  float humidity = dht20.getHumidity();
  Serial.print("Temperature: ");
  Serial.print(temperature, 1);
  Serial.println(" °C");
  Serial.print("Humidity: ");
  Serial.print(humidity * 100, 1);
  Serial.println(" %");
  delay(2000);
}