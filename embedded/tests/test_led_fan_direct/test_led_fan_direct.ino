// Direct LED and Fan Control Test (No Relay)

// ⚠️ HARDWARE WARNING ⚠️
// DO NOT connect a 5V DC fan directly to an ESP32 GPIO pin! 
// An ESP32 pin can only safely supply ~40mA. A motor draws much more 
// and will instantly destroy the pin or the board.
// To run a fan safely without a relay, use an NPN transistor (e.g., 2N2222, TIP120) 
// or a MOSFET alongside a flyback diode.
//
// Miniature LEDs are safe to connect directly, but ALWAYS use a current-limiting 
// resistor (e.g., 220Ω - 330Ω) in series with each LED.

const int LED_ZONE_1 = 25;
const int LED_ZONE_2 = 26;
const int LED_ZONE_3 = 27;
const int FAN_PIN    = 14;

void setup() {
  Serial.begin(115200);
  Serial.println("Direct LED & Fan Control Test Initialized");

  // Configure pins as Outputs
  pinMode(LED_ZONE_1, OUTPUT);
  pinMode(LED_ZONE_2, OUTPUT);
  pinMode(LED_ZONE_3, OUTPUT);
  pinMode(FAN_PIN,    OUTPUT);

  // Turn everything OFF initially (Active HIGH logic)
  digitalWrite(LED_ZONE_1, LOW);
  digitalWrite(LED_ZONE_2, LOW);
  digitalWrite(LED_ZONE_3, LOW);
  digitalWrite(FAN_PIN,    LOW);
}

void loop() {
  // 1. Turn on LEDs sequentially
  Serial.println("Turning on LED Zone 1...");
  digitalWrite(LED_ZONE_1, HIGH);
  delay(1000);

  Serial.println("Turning on LED Zone 2...");
  digitalWrite(LED_ZONE_2, HIGH);
  delay(1000);

  Serial.println("Turning on LED Zone 3...");
  digitalWrite(LED_ZONE_3, HIGH);
  delay(1000);

  // 2. Turn on Fan
  Serial.println("Activating Fan...");
  digitalWrite(FAN_PIN, HIGH);
  delay(3000); // Leave everything on for 3 seconds

  // 3. Turn everything off
  Serial.println("Turning OFF Everything...");
  digitalWrite(LED_ZONE_1, LOW);
  digitalWrite(LED_ZONE_2, LOW);
  digitalWrite(LED_ZONE_3, LOW);
  digitalWrite(FAN_PIN,    LOW);
  
  Serial.println("Waiting 2 seconds before repeating...");
  delay(2000);
}
