const int BUZZER_PIN = 32;

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  Serial.println("Buzzer Test Initialized");
}

void loop() {
  Serial.println("Buzzer Beep");
  digitalWrite(BUZZER_PIN, HIGH);
  delay(200); // 200ms ON
  digitalWrite(BUZZER_PIN, LOW);
  
  delay(2000); // Wait 2s
}
