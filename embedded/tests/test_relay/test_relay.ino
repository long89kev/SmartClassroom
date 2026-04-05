// 4-Channel Relay (Active LOW)
// Channel 1: LED Zone 1 (GPIO 25)
// Channel 2: LED Zone 2 (GPIO 26)
// Channel 3: LED Zone 3 (GPIO 27)
// Channel 4: DC Fan    (GPIO 14)

const int RELAY_PINS[] = {25, 26, 27, 14};
const int NUM_RELAYS = 4;

void setup() {
  Serial.begin(115200);
  Serial.println("Relay Test Initialized");
  
  for (int i = 0; i < NUM_RELAYS; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], HIGH); // Turn OFF (Active LOW logic)
  }
}

void loop() {
  for (int i = 0; i < NUM_RELAYS; i++) {
    Serial.print("Relay ");
    Serial.print(i + 1);
    Serial.println(" ON");
    digitalWrite(RELAY_PINS[i], LOW);
    delay(1000);
    
    Serial.print("Relay ");
    Serial.print(i + 1);
    Serial.println(" OFF");
    digitalWrite(RELAY_PINS[i], HIGH);
    delay(1000);
  }
}
