"""
config.py — Attendance Service Configuration
Smart AI-IoT Classroom System

Configure webcam, MQTT, backend, and face recognition settings.
"""

import os


# ─── Webcam ──────────────────────────────────────────────
CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))  # 0 = default webcam, 1 = USB if laptop has built-in
CAMERA_WIDTH = int(os.getenv("CAMERA_WIDTH", "640"))
CAMERA_HEIGHT = int(os.getenv("CAMERA_HEIGHT", "480"))
CAPTURE_INTERVAL_SEC = float(os.getenv("CAPTURE_INTERVAL", "3"))  # seconds between recognition attempts

# ─── MQTT (for LCD display updates) ─────────────────────
MQTT_BROKER_HOST = os.getenv("MQTT_BROKER_HOST", "192.168.1.104")
MQTT_BROKER_PORT = int(os.getenv("MQTT_BROKER_PORT", "1883"))
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
MQTT_CLIENT_ID = os.getenv("MQTT_CLIENT_ID", "attendance_service")

# MQTT Topics (must match ESP32 config.h)
TOPIC_LCD_LINE1 = "classroom/display/line1"
TOPIC_LCD_LINE2 = "classroom/display/line2"
TOPIC_ATTENDANCE_STATUS = "classroom/attendance/status"  # JSON status for live UI

# ─── Backend API ─────────────────────────────────────────
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
BACKEND_USERNAME = os.getenv("BACKEND_USERNAME", "admin")
BACKEND_PASSWORD = os.getenv("BACKEND_PASSWORD", "admin123")
ROOM_CODE = os.getenv("ROOM_CODE", "A1-F1-R04")

# ─── Face Recognition ───────────────────────────────────
FACE_DB_DIR = os.getenv("FACE_DB_DIR", os.path.join(os.path.dirname(__file__), "face_db"))
DETECTOR_BACKEND = os.getenv("DETECTOR_BACKEND", "ssd")  # opencv, retinaface, mtcnn, ssd
MODEL_NAME = os.getenv("MODEL_NAME", "VGG-Face")  # VGG-Face, Facenet, Facenet512, ArcFace
DISTANCE_METRIC = os.getenv("DISTANCE_METRIC", "cosine")  # cosine, euclidean, euclidean_l2
RECOGNITION_THRESHOLD = float(os.getenv("RECOGNITION_THRESHOLD", "0.6"))  # lower = stricter for cosine

# ─── Flask MJPEG Server ─────────────────────────────────
STREAM_HOST = os.getenv("STREAM_HOST", "0.0.0.0")
STREAM_PORT = int(os.getenv("STREAM_PORT", "5051"))
