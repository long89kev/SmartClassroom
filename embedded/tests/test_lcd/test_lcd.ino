#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// Try address 0x3F if 0x27 doesn't work
LiquidCrystal_I2C lcd(0x27, 16, 2); 

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22); // SDA = 21, SCL = 22
  
  lcd.init();
  lcd.backlight();
  
  lcd.setCursor(0, 0);
  lcd.print("LCD Initialized");
  lcd.setCursor(0, 1);
  lcd.print("Smart Classroom");
  Serial.println("LCD Test Initialized");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("Uptime: ");
  lcd.print(millis() / 1000);
  lcd.print("s  ");
  delay(1000);
}
