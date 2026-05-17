from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Room, RoomOccupancy, RoomSensorReading, DeviceState

router = APIRouter(prefix="/api", tags=["Sensors"])


class OccupancyUpdatePayload(BaseModel):
    occupancy_count: int = Field(default=0, ge=0)
    is_occupied: bool = False


class SensorReadingUpsertPayload(BaseModel):
    value: float
    unit: str | None = None
    source_topic: str | None = None
    captured_at: datetime | None = None


@router.put("/rooms/{room_id}/occupancy")
async def upsert_room_occupancy(
    room_id: UUID,
    payload: OccupancyUpdatePayload,
    db: Session = Depends(get_db),
):
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    occupancy = db.query(RoomOccupancy).filter(RoomOccupancy.room_id == room_id).first()
    if not occupancy:
        occupancy = RoomOccupancy(room_id=room_id)
        db.add(occupancy)

    occupancy.occupancy_count = payload.occupancy_count
    occupancy.is_occupied = payload.is_occupied
    occupancy.last_detected = datetime.utcnow()

    db.commit()

    return {
        "room_id": str(room_id),
        "occupancy_count": occupancy.occupancy_count,
        "is_occupied": occupancy.is_occupied,
        "last_detected": occupancy.last_detected,
    }


@router.put("/rooms/{room_id}/sensor-readings/{sensor_key}")
async def upsert_room_sensor_reading(
    room_id: UUID,
    sensor_key: str,
    payload: SensorReadingUpsertPayload,
    db: Session = Depends(get_db),
):
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    normalized_key = sensor_key.strip().upper()
    reading = (
        db.query(RoomSensorReading)
        .filter(RoomSensorReading.room_id == room_id, RoomSensorReading.sensor_key == normalized_key)
        .first()
    )

    if not reading:
        reading = RoomSensorReading(room_id=room_id, sensor_key=normalized_key)
        db.add(reading)

    reading.value = payload.value
    reading.unit = payload.unit
    reading.source_topic = payload.source_topic
    reading.captured_at = payload.captured_at or datetime.utcnow()

    db.commit()

    return {
        "room_id": str(room_id),
        "sensor_key": reading.sensor_key,
        "value": reading.value,
        "unit": reading.unit,
        "source_topic": reading.source_topic,
        "captured_at": reading.captured_at,
    }


@router.get("/rooms/{room_id}/sensor-readings/latest")
async def get_latest_room_sensor_readings(room_id: UUID, db: Session = Depends(get_db)):
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    rows = (
        db.query(RoomSensorReading)
        .filter(RoomSensorReading.room_id == room_id)
        .order_by(RoomSensorReading.sensor_key.asc())
        .all()
    )

    return {
        "room_id": str(room_id),
        "room_code": room.room_code,
        "readings": [
            {
                "sensor_key": row.sensor_key,
                "value": row.value,
                "unit": row.unit,
                "source_topic": row.source_topic,
                "captured_at": row.captured_at,
            }
            for row in rows
        ],
    }


@router.get("/rooms/by-code/{room_code}")
async def get_room_by_code(room_code: str, db: Session = Depends(get_db)):
    """Look up a room by its room_code. Used by MQTT gateway for auto-discovery."""
    room = db.query(Room).filter(Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail=f"Room with code '{room_code}' not found")

    return {
        "room_id": str(room.id),
        "room_code": room.room_code,
        "name": room.name,
        "capacity": room.capacity,
    }


@router.post("/devices/{device_id}/clear-override-internal")
async def clear_device_override_internal(
    device_id: str,
    room_id: UUID,
    db: Session = Depends(get_db)
):
    """
    Internal endpoint used by the MQTT gateway to clear the manual_override flag
    after a toggle command has been applied to the hardware relays.
    No auth required as this is only called by the internal gateway service.
    """
    device_state = db.query(DeviceState).filter(
        DeviceState.room_id == room_id,
        DeviceState.device_id == device_id
    ).first()
    
    if not device_state:
        raise HTTPException(status_code=404, detail="Device not found")
    
    device_state.manual_override = False
    device_state.override_until = None
    device_state.last_updated = datetime.utcnow()
    
    db.commit()
    
    return {
        "message": "Manual override cleared",
        "device_id": device_id,
        "manual_override": False
    }
