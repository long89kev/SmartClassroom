from fastapi import APIRouter, Depends, HTTPException, status, Body
from sqlalchemy.orm import Session
from uuid import UUID
from typing import List, Optional
from datetime import datetime

from app.database import get_db
from app.models import Room, DeviceState, User
from app.schemas.common import DeviceStateResponse, DeviceCreateUpdate, DeviceToggle
import json
import uuid

router = APIRouter(prefix="/api", tags=["Device Management"])

ALLOWED_FB = {"FRONT", "BACK"}
ALLOWED_LR = {"LEFT", "RIGHT"}


def _generate_device_id(existing_ids: set[str]) -> str:
    """Generate a unique device id when client doesn't provide one."""
    while True:
        candidate = f"DEV-{str(uuid.uuid4())[:8].upper()}"
        if candidate not in existing_ids:
            return candidate

# =============================================================================
# DEVICE INVENTORY MANAGEMENT (CRUD on JSONB)
# =============================================================================

@router.get("/rooms/{room_id}/devices")
async def list_room_devices(room_id: UUID, db: Session = Depends(get_db)):
    """Get list of all devices in a room from JSONB"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    devices = room.devices.get("device_list", []) if room.devices else []
    normalized_devices = []

    for device in devices:
        fb = device.get("location_front_back")
        lr = device.get("location_left_right")
        combined = device.get("location")

        if (not fb or not lr) and combined and "_" in str(combined):
            parts = str(combined).upper().split("_", 1)
            if len(parts) == 2:
                fb, lr = parts[0], parts[1]

        if fb not in ALLOWED_FB:
            fb = "FRONT"
        if lr not in ALLOWED_LR:
            lr = "LEFT"

        normalized_devices.append(
            {
                **device,
                "location_front_back": fb,
                "location_left_right": lr,
                "location": f"{fb}_{lr}",
            }
        )
    
    return {
        "room_id": room_id,
        "room_code": room.room_code,
        "device_count": len(normalized_devices),
        "devices": normalized_devices
    }

@router.post("/rooms/{room_id}/devices", status_code=201)
async def add_device_to_room(
    room_id: UUID,
    device: DeviceCreateUpdate,
    db: Session = Depends(get_db)
):
    """Add a new device to room inventory (auto-discovery or manual)"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    # Ensure devices JSONB exists
    if not room.devices:
        room.devices = {"device_list": []}
    
    # Check if device already exists
    device_list = room.devices.get("device_list", [])
    existing_ids = {d["device_id"] for d in device_list if "device_id" in d}

    if device.device_id and any(d["device_id"] == device.device_id for d in device_list):
        raise HTTPException(status_code=400, detail="Device already exists in room")

    device_id = device.device_id or _generate_device_id(existing_ids)
    
    # Add new device
    fb = device.location_front_back.upper()
    lr = device.location_left_right.upper()
    if fb not in ALLOWED_FB or lr not in ALLOWED_LR:
        raise HTTPException(status_code=400, detail="Invalid location values")

    new_device = {
        "device_id": device_id,
        "device_type": device.device_type,
        "location_front_back": fb,
        "location_left_right": lr,
        "location": f"{fb}_{lr}",
        "status": "OFF",
        "mqtt_topic": f"building/*/floor/*/room/{room.room_code}/device/{device_id}/state",
        "power_consumption_watts": device.power_consumption_watts or 0
    }
    
    device_list.append(new_device)
    room.devices["device_list"] = device_list
    
    # Also create entry in device_states table for tracking
    device_state = DeviceState(
        room_id=room_id,
        device_id=device_id,
        device_type=device.device_type,
        status="OFF"
    )
    db.add(device_state)
    db.commit()
    db.refresh(room)
    
    return {
        "message": "Device added successfully",
        "device": new_device,
        "total_devices": len(room.devices["device_list"])
    }

@router.put("/rooms/{room_id}/devices/{device_id}")
async def update_device_metadata(
    room_id: UUID,
    device_id: str,
    updates: dict = Body(...),
    db: Session = Depends(get_db)
):
    """Update device metadata (location, power consumption, etc.)"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    device_list = room.devices.get("device_list", [])
    device = next((d for d in device_list if d["device_id"] == device_id), None)
    
    if not device:
        raise HTTPException(status_code=404, detail="Device not found in room")
    
    # Update allowed fields with validation
    if "location_front_back" in updates:
        fb = str(updates["location_front_back"]).upper()
        if fb not in ALLOWED_FB:
            raise HTTPException(status_code=400, detail="Invalid location_front_back. Use FRONT or BACK")
        device["location_front_back"] = fb

    if "location_left_right" in updates:
        lr = str(updates["location_left_right"]).upper()
        if lr not in ALLOWED_LR:
            raise HTTPException(status_code=400, detail="Invalid location_left_right. Use LEFT or RIGHT")
        device["location_left_right"] = lr

    if "location" in updates and "_" in str(updates["location"]):
        parts = str(updates["location"]).upper().split("_", 1)
        if len(parts) == 2 and parts[0] in ALLOWED_FB and parts[1] in ALLOWED_LR:
            device["location_front_back"] = parts[0]
            device["location_left_right"] = parts[1]

    fb = str(device.get("location_front_back", "FRONT")).upper()
    lr = str(device.get("location_left_right", "LEFT")).upper()
    if fb not in ALLOWED_FB:
        fb = "FRONT"
    if lr not in ALLOWED_LR:
        lr = "LEFT"
    device["location_front_back"] = fb
    device["location_left_right"] = lr
    device["location"] = f"{fb}_{lr}"

    if "power_consumption_watts" in updates:
        device["power_consumption_watts"] = int(updates["power_consumption_watts"])
    
    db.commit()
    db.refresh(room)
    
    return {
        "message": "Device updated successfully",
        "device": device
    }

@router.delete("/rooms/{room_id}/devices/{device_id}", status_code=204)
async def remove_device_from_room(
    room_id: UUID,
    device_id: str,
    db: Session = Depends(get_db)
):
    """Remove device from room inventory"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    device_list = room.devices.get("device_list", [])
    initial_count = len(device_list)
    
    # Filter out the device
    room.devices["device_list"] = [d for d in device_list if d["device_id"] != device_id]
    
    if len(room.devices["device_list"]) == initial_count:
        raise HTTPException(status_code=404, detail="Device not found")
    
    # Remove from device_states table too
    device_state = db.query(DeviceState).filter(
        DeviceState.room_id == room_id,
        DeviceState.device_id == device_id
    ).first()
    if device_state:
        db.delete(device_state)
    
    db.commit()
    
    return None  # 204 No Content

# =============================================================================
# DEVICE CONTROL (MANUAL TOGGLE)
# =============================================================================

@router.post("/devices/{device_id}/toggle")
async def toggle_device(
    device_id: str,
    toggle: DeviceToggle,
    room_id: UUID,
    user_id: Optional[UUID] = None,  # Lecturer/Admin ID
    db: Session = Depends(get_db)
):
    """
    Manually toggle device ON/OFF (manual override).
    Admin or Lecturer can toggle.
    """
    device_state = db.query(DeviceState).filter(
        DeviceState.room_id == room_id,
        DeviceState.device_id == device_id
    ).first()
    
    if not device_state:
        raise HTTPException(status_code=404, detail="Device not found")
    
    # Update device status
    device_state.status = toggle.action.upper()  # ON or OFF
    device_state.last_toggled_by = user_id
    device_state.manual_override = True
    
    # Set override duration if specified
    if toggle.duration_minutes:
        from datetime import timedelta
        device_state.override_until = datetime.utcnow() + timedelta(minutes=toggle.duration_minutes)
    
    device_state.last_updated = datetime.utcnow()
    device_state.updated_at = datetime.utcnow()
    
    db.commit()
    db.refresh(device_state)
    
    return {
        "message": f"Device toggled {toggle.action.upper()}",
        "device_id": device_id,
        "status": device_state.status,
        "manual_override": True,
        "override_until": device_state.override_until,
        "timestamp": device_state.updated_at
    }

@router.post("/devices/{device_id}/auto")
async def clear_manual_override(
    device_id: str,
    room_id: UUID,
    db: Session = Depends(get_db)
):
    """Clear manual override to re-enable auto-rules"""
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
        "message": "Manual override cleared, auto-rules re-enabled",
        "device_id": device_id,
        "manual_override": False
    }

@router.get("/rooms/{room_id}/devices/status/all")
async def get_all_device_states(room_id: UUID, db: Session = Depends(get_db)):
    """Get real-time status of all devices in room (from device_states table)"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    devices = db.query(DeviceState).filter(DeviceState.room_id == room_id).all()
    
    return {
        "room_id": room_id,
        "device_states": [
            {
                "device_id": d.device_id,
                "device_type": d.device_type,
                "status": d.status,
                "manual_override": d.manual_override,
                "override_until": d.override_until,
                "last_updated": d.last_updated
            }
            for d in devices
        ]
    }
