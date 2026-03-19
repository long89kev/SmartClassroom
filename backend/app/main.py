from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from app.config import get_settings
from app.database import engine, Base, SessionLocal
from app.models import *  # Import all models to register with SQLAlchemy
from app.services import YOLOInferenceService
from app.seed import seed_buildings
import logging

logger = logging.getLogger(__name__)

# Create tables
Base.metadata.create_all(bind=engine)

settings = get_settings()

# Initialize FastAPI app
app = FastAPI(
    title=settings.app_name,
    description="Smart AI-IoT Classroom System API",
    version="0.1.0",
    debug=settings.debug
)

# Middleware: CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Middleware: Trusted Hosts
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["localhost", "127.0.0.1", "0.0.0.0"]
)

# Include routers
from app.routers import buildings, devices, sessions, incidents, rules, auth
app.include_router(buildings.router)
app.include_router(devices.router)
app.include_router(sessions.router)
app.include_router(incidents.router)
app.include_router(rules.router)
app.include_router(auth.router)

# Startup event: Initialize AI services
@app.on_event("startup")
async def startup_event():
    """Initialize YOLO and other AI services on startup."""
    logger.info("=" * 60)
    logger.info("STARTUP: Initializing AI Services")
    logger.info("=" * 60)
    
    # Initialize YOLO
    try:
        yolo_service = YOLOInferenceService()
        if yolo_service.is_ready():
            logger.info("✓ YOLO Model: LOADED")
            logger.info("  - Model: YOLOv8")
            logger.info("  - Path: /app/models/yolo_weights/best.pt")
            logger.info("  - Features: Behavior detection, cheat detection")
        else:
            logger.warning("✗ YOLO Model: FAILED TO LOAD")
            logger.warning("  - Continuing without YOLO")
    except Exception as e:
        logger.error(f"✗ YOLO Startup Error: {e}")
    
    # Database status and seeding
    try:
        db = SessionLocal()
        from app.models import BehaviorClass
        behavior_count = db.query(BehaviorClass).count()
        logger.info(f"✓ Database: Connected ({behavior_count} behavior classes)")
        
        # Seed database with buildings, floors, and rooms
        seed_buildings(db)
        db.close()
    except Exception as e:
        logger.error(f"✗ Database Error: {e}")
    
    logger.info("=" * 60)
    logger.info("STARTUP: Complete")
    logger.info("=" * 60)

# Health check endpoint
@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "app": settings.app_name,
        "debug": settings.debug
    }

@app.get("/")
async def root():
    return {
        "message": "Smart AI-IoT Classroom System API",
        "version": "0.1.0",
        "docs": "/docs"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
