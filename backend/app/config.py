from pydantic_settings import BaseSettings
from functools import lru_cache
import os

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
    yolo_weights_path: str = "backend/models/yolo_weights/"
    yolo_confidence_threshold: float = 0.5
    
    # MQTT (Mosquitto Broker in Docker)
    mqtt_broker_host: str = "localhost"
    mqtt_broker_port: int = 1883
    mqtt_use_mock: bool = True
    mqtt_topic_prefix: str = "classroom"
    
    # App
    debug: bool = True
    app_name: str = "Smart AI-IoT Classroom System"
    
    class Config:
        env_file = ".env"
        case_sensitive = False

@lru_cache
def get_settings():
    return Settings()
