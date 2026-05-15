from pathlib import Path

from pydantic_settings import BaseSettings
from functools import lru_cache
import os

# Compute backend directory from this file's location (backend/app/config.py → backend/)
_BACKEND_DIR = Path(__file__).resolve().parents[1]

class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://doai_user:doai_password@localhost:5432/doai_classroom"
    
    # Redis
    redis_url: str = "redis://localhost:6379/0"
    
    # JWT
    jwt_secret: str = "your-secret-key-change-in-production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    
    # YOLO
    yolo_model_version: str = "v8"
    yolo_weights_path: str = str(_BACKEND_DIR / "models" / "yolo_weights")
    yolo_confidence_threshold: float = 0.5

    # Local storage for temp frames (browsing/replays)
    temp_frames_dir: str = "app/services/Temp"
    temp_frames_enabled: bool = True
    
    # MQTT (Mosquitto Broker in Docker)
    mqtt_broker_host: str = "localhost"
    mqtt_broker_port: int = 1883
    mqtt_use_mock: bool = True
    mqtt_topic_prefix: str = "classroom"
    
    # App
    debug: bool = True
    app_name: str = "Smart AI-IoT Classroom System"

    # Attendance stream bridge
    attendance_service_url: str = "http://localhost:5051"
    
    class Config:
        env_file = ".env"
        case_sensitive = False

@lru_cache
def get_settings():
    return Settings()
