import tkinter as tk
from tkinter import ttk
import paho.mqtt.client as mqtt
import json

# ==========================================
# CONFIGURATION
# Match this to your ESP32's config.h
# ==========================================
MQTT_BROKER = "192.168.0.177" 
MQTT_PORT = 1883

TOPIC_TEMP   = "classroom/sensors/temperature"
TOPIC_HUM    = "classroom/sensors/humidity"
TOPIC_LIGHT  = "classroom/sensors/light"
TOPIC_ACTUATORS = [
    "classroom/actuators/relay/1",
    "classroom/actuators/relay/2",
    "classroom/actuators/relay/3",
    "classroom/actuators/relay/4",
    "classroom/actuators/alert_led",
]

class SmartClassroomInterface:
    def __init__(self, root):
        self.root = root
        self.root.title("Smart Classroom Controller")
        self.root.geometry("450x430")
        self.root.configure(bg="#1E1E2E") # Very dark aesthetic blue/grey
        
        # Aesthetics & Styling
        font_title = ("Segoe UI", 20, "bold")
        font_main = ("Segoe UI", 12)
        font_btn = ("Segoe UI", 13, "bold")
        
        # Header
        tk.Label(root, text="Classroom Interface", font=font_title, bg="#1E1E2E", fg="#CDD6F4").pack(pady=15)
        
        # Sensor Panel
        sensor_frame = tk.Frame(root, bg="#313244", highlightbackground="#45475A", highlightthickness=2)
        sensor_frame.pack(fill="x", padx=25, pady=5)
        
        self.lbl_temp = tk.Label(sensor_frame, text="🌡️ Temp: -- °C", font=font_main, bg="#313244", fg="#F38BA8")
        self.lbl_temp.pack(side="left", padx=5, pady=15, expand=True)
        
        self.lbl_hum = tk.Label(sensor_frame, text="💧 Humidity: -- %", font=font_main, bg="#313244", fg="#89B4FA")
        self.lbl_hum.pack(side="left", padx=5, pady=15, expand=True)
        
        self.lbl_light = tk.Label(sensor_frame, text="☀️ Light: -- %", font=font_main, bg="#313244", fg="#F9E2AF")
        self.lbl_light.pack(side="left", padx=5, pady=15, expand=True)
        
        # Actuator Controls Panel
        tk.Label(root, text="Control Panel", font=font_main, bg="#1E1E2E", fg="#A6ADC8").pack(pady=(15, 5))
        
        control_frame = tk.Frame(root, bg="#1E1E2E")
        control_frame.pack(fill="both", expand=True, padx=20)
        
        # Create buttons
        self.buttons = []
        self.states = [False, False, False, False, False]
        labels = ["LED Zone 1", "LED Zone 2", "LED Zone 3", "Fan", "Alert LED"]
        
        for i in range(5):
            btn = tk.Button(
                control_frame, 
                text=f"{labels[i]}: OFF", 
                font=font_btn, width=13,
                bg="#45475A", fg="#CDD6F4", activebackground="#585B70",
                command=lambda idx=i: self.toggle_actuator(idx)
            )
            # Layout in a 2x2 Grid (last button will be bottom center)
            btn.grid(row=i//2, column=i%2, padx=10, pady=7)
            self.buttons.append(btn)
            
        # Add Auto/Manual Toggle Button
        self.is_auto = True
        self.btn_auto_manual = tk.Button(
            control_frame,
            text="Mode: AUTO",
            font=font_btn, width=13,
            bg="#A6E3A1", fg="#1E1E2E", activebackground="#89DCEB",
            command=self.toggle_auto_manual
        )
        self.btn_auto_manual.grid(row=2, column=1, padx=10, pady=7)
            
        # Optional: configure grid to center the buttons
        control_frame.grid_columnconfigure(0, weight=1)
        control_frame.grid_columnconfigure(1, weight=1)

        # Connection Status Label
        self.lbl_status = tk.Label(root, text="Connecting to MQTT broker...", bg="#1E1E2E", fg="#F9E2AF")
        self.lbl_status.pack(side="bottom", pady=15)

        # Setup MQTT
        self.setup_mqtt()

    def setup_mqtt(self):
        # We try to use an isolated client wrapper to avoid blocking Tkinter mainloop
        try:
            # Depending on paho-mqtt version, we pass CallbackAPIVersion.VERSION2 if available, else omit
            try:
                self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
            except AttributeError:
                self.client = mqtt.Client()
                
            self.client.on_connect = self.on_connect
            self.client.on_message = self.on_message
            self.client.connect(MQTT_BROKER, MQTT_PORT, 60)
            self.client.loop_start()  # Runs the network loop in a background thread
        except Exception as e:
            self.lbl_status.config(text=f"Connection Error: {e}", fg="#F38BA8")

    def toggle_auto_manual(self):
        self.is_auto = not self.is_auto
        mode_text = "AUTO" if self.is_auto else "MANUAL"
        color_bg = "#A6E3A1" if self.is_auto else "#F9E2AF"
        
        self.btn_auto_manual.config(text=f"Mode: {mode_text}", bg=color_bg)
        self.client.publish("classroom/mode/auto_manual", "ON" if self.is_auto else "OFF")

    def toggle_actuator(self, idx):
        # Toggle mathematical state
        self.states[idx] = not self.states[idx]
        new_state = "ON" if self.states[idx] else "OFF"
        
        labels = ["LED Zone 1", "LED Zone 2", "LED Zone 3", "Fan", "Alert LED"]
        
        # Dynamic aesthetic colors (Green for ON, Grey/Dark for OFF)
        color_bg = "#A6E3A1" if self.states[idx] else "#45475A"
        color_fg = "#1E1E2E" if self.states[idx] else "#CDD6F4"
        
        # Apply to button
        self.buttons[idx].config(text=f"{labels[idx]}: {new_state}", bg=color_bg, fg=color_fg)
        
        # Publish MQTT command directly to the node
        if idx < 4:
            # Relay modules are hardware-inverted (or wired NC), sending "OFF" turns physical ON
            mqtt_payload = "OFF" if self.states[idx] else "ON"
        else:
            # Alert LED behaves with standard logic
            mqtt_payload = "ON" if self.states[idx] else "OFF"
            
        self.client.publish(TOPIC_ACTUATORS[idx], mqtt_payload)

    def on_connect(self, client, userdata, flags, result_code, properties=None):
        # result_code indicates success. Compatibility signature.
        if result_code == 0:
            # We must use the Tkinter root methods to safely update the UI from this background thread
            self.root.after(0, lambda: self.lbl_status.config(text="✅ Connected to MQTT Broker", fg="#A6E3A1"))
            # Subscribe to the ESP32 sensor topic streams
            client.subscribe(TOPIC_TEMP)
            client.subscribe(TOPIC_HUM)
            client.subscribe(TOPIC_LIGHT)
            
            # Sync physical devices to match default dashboard OFF state
            for idx in range(5):
                initial_payload = "ON" if idx < 4 else "OFF"
                client.publish(TOPIC_ACTUATORS[idx], initial_payload)
        else:
            self.root.after(0, lambda: self.lbl_status.config(text="❌ Failed to connect", fg="#F38BA8"))

    def on_message(self, client, userdata, msg):
        try:
            # The ESP32 node outputs payload such as: {"value": 25.4, "unit": "C"}
            payload_str = msg.payload.decode()
            data = json.loads(payload_str)
            val = data.get("value", "--")
            
            # Using after() because Tkinter updates should originate from the main thread
            if msg.topic == TOPIC_TEMP:
                self.root.after(0, lambda: self.lbl_temp.config(text=f"🌡️ Temp: {val} °C"))
            elif msg.topic == TOPIC_HUM:
                self.root.after(0, lambda: self.lbl_hum.config(text=f"💧 Humidity: {val} %"))
            elif msg.topic == TOPIC_LIGHT:
                self.root.after(0, lambda: self.lbl_light.config(text=f"☀️ Light: {val} %"))
        except:
            pass

if __name__ == "__main__":
    root = tk.Tk()
    app = SmartClassroomInterface(root)
    # Ensure background threads are cleaned up properly
    root.protocol("WM_DELETE_WINDOW", lambda: (app.client.loop_stop(), root.destroy()))
    root.mainloop()
