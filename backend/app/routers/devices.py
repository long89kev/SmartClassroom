from fastapi import APIRouter, Depends, HTTPException, status, Body
from sqlalchemy.orm import Session
from uuid import UUID
from typing import Optional
from datetime import datetime

from app.database import get_db
from app.models import (
    Room,
    DeviceState,
    RoomDevice,
    DeviceType,
    DeviceThresholdProfile,
    RoomDeviceThreshold,
    Teacher,
    User,
)
from app.schemas.common import (
    DeviceCreateUpdate,
    DeviceToggle,
    DeviceTypeResponse,
    ThresholdUpdatePayload,
)
from app.routers.auth import get_current_user, get_user_permissions
import uuid

router = APIRouter(prefix="/api", tags=["Device Management"])

ALLOWED_FB = {"FRONT", "BACK"}
ALLOWED_LR = {"LEFT", "RIGHT"}
EXCLUDED_DEVICE_TYPES = {"PROJECTOR"}
ALLOWED_MUTATION_ROLES = {"SYSTEM_ADMIN", "FACILITY_STAFF", "LECTURER", "EXAM_PROCTOR"}
ALLOWED_TOGGLE_ROLES = {"SYSTEM_ADMIN", "FACILITY_STAFF", "CLEANING_STAFF", "LECTURER", "EXAM_PROCTOR"}


def _require_mutation_role(current_user: User) -> None:
    """Verify user has role required for device mutations"""
    if current_user.role not in ALLOWED_MUTATION_ROLES:
        raise HTTPException(
            status_code=403,
            detail=f"Only {ALLOWED_MUTATION_ROLES} roles can modify devices"
        )


def _require_mutation_permission(current_user: User, db: Session) -> None:
    user_permissions = get_user_permissions(current_user, db)
    required_permissions = {
        "deploy:device_management",
        "env_control:thresholds",
        "deploy:system_settings",
        "env_control:light",
        "env_control:ac",
        "env_control:fan",
    }
    if required_permissions.isdisjoint(user_permissions):
        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Requires one of: {','.join(sorted(required_permissions))}",
        )


def _require_toggle_role(current_user: User) -> None:
    """Verify user has role required for device toggles."""
    if current_user.role not in ALLOWED_TOGGLE_ROLES:
        raise HTTPException(
            status_code=403,
            detail=f"Only {ALLOWED_TOGGLE_ROLES} roles can toggle devices"
        )


def _require_toggle_permission(current_user: User, db: Session) -> None:
    user_permissions = get_user_permissions(current_user, db)
    required_permissions = {
        "deploy:device_management",
        "deploy:system_settings",
        "env_control:light",
        "env_control:ac",
        "env_control:fan",
    }
    if required_permissions.isdisjoint(user_permissions):
        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Requires one of: {','.join(sorted(required_permissions))}",
        )


def _generate_device_id(existing_ids: set[str]) -> str:
    """Generate a unique device id when client doesn't provide one."""
    while True:
        candidate = f"DEV-{str(uuid.uuid4())[:8].upper()}"
        if candidate not in existing_ids:
            return candidate


def _read_room_device_list(room: Room) -> list[dict]:
    """Return a safe copy of room device_list for mutation operations."""
    if not isinstance(room.devices, dict):
        return []

    device_list = room.devices.get("device_list", [])
    if not isinstance(device_list, list):
        return []

    return [dict(device) for device in device_list if isinstance(device, dict)]


def _write_room_device_list(room: Room, device_list: list[dict]) -> None:
    """Assign room.devices at top-level so SQLAlchemy persists JSON updates."""
    current_payload = room.devices if isinstance(room.devices, dict) else {}
    room.devices = {
        **current_payload,
        "device_list": [dict(device) for device in device_list if isinstance(device, dict)],
    }


def _validate_threshold_range(payload: ThresholdUpdatePayload) -> None:
    """Validate threshold range: min <= max and target within [min, max]"""
    if payload.min_value is not None and payload.max_value is not None:
        if payload.min_value > payload.max_value:
            raise HTTPException(status_code=400, detail="min_value must be <= max_value")
    
    # Validate target within range if all three are specified
    if (payload.min_value is not None and payload.max_value is not None and 
        payload.target_value is not None):
        if not (payload.min_value <= payload.target_value <= payload.max_value):
            raise HTTPException(
                status_code=400, 
                detail=f"target_value must be between min_value ({payload.min_value}) and max_value ({payload.max_value})"
            )


def _validate_device_type_supported(db: Session, device_type: str) -> DeviceType:
    normalized = device_type.strip().upper()
    if normalized in EXCLUDED_DEVICE_TYPES:
        raise HTTPException(status_code=400, detail=f"{normalized} is not supported")

    entry = db.query(DeviceType).filter(DeviceType.code == normalized, DeviceType.is_active == True).first()
    if not entry:
        raise HTTPException(status_code=400, detail=f"Unsupported device_type: {normalized}")
    return entry

# =============================================================================
# DEVICE INVENTORY MANAGEMENT (CRUD on JSONB)
# =============================================================================

@router.get("/rooms/{room_id}/devices")
async def list_room_devices(room_id: UUID, db: Session = Depends(get_db)):
    """Get list of all devices in a room from JSONB"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    devices = _read_room_device_list(room)
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Add a new device to room inventory (auto-discovery or manual)"""
    _require_mutation_role(current_user)
    _require_mutation_permission(current_user, db)
    
    try:
        room = db.query(Room).filter(Room.id == room_id).first()
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")
        
        validated_type = _validate_device_type_supported(db, device.device_type)

        # Check if device already exists
        device_list = _read_room_device_list(room)
        existing_ids = {d["device_id"] for d in device_list if "device_id" in d}

        if device.device_id and any(d.get("device_id") == device.device_id for d in device_list):
            raise HTTPException(status_code=400, detail="Device already exists in room")

        device_id = device.device_id or _generate_device_id(existing_ids)
        
        # Add new device
        fb = device.location_front_back.upper()
        lr = device.location_left_right.upper()
        if fb not in ALLOWED_FB or lr not in ALLOWED_LR:
            raise HTTPException(status_code=400, detail="Invalid location values")

        new_device = {
            "device_id": device_id,
            "device_type": validated_type.code,
            "location_front_back": fb,
            "location_left_right": lr,
            "location": f"{fb}_{lr}",
            "status": "OFF",
            "mqtt_topic": f"building/*/floor/*/room/{room.room_code}/device/{device_id}/state",
            "power_consumption_watts": device.power_consumption_watts or 0
        }

        device_list.append(new_device)
        _write_room_device_list(room, device_list)
        
        # Also create entry in device_states table for tracking
        device_state = DeviceState(
            room_id=room_id,
            device_id=device_id,
            device_type=validated_type.code,
            status="OFF",
            last_updated=datetime.utcnow(),
        )
        room_device = RoomDevice(
            room_id=room_id,
            device_id=device_id,
            device_type=validated_type.code,
            location_front_back=fb,
            location_left_right=lr,
            power_consumption_watts=device.power_consumption_watts or 0,
            is_active=True,
            source="MANUAL",
        )
        db.add(room_device)
        db.add(device_state)
        db.commit()
        db.refresh(room)

        return {
            "message": "Device added successfully",
            "device": new_device,
            "total_devices": len(device_list)
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to add device: {str(e)}")

@router.put("/rooms/{room_id}/devices/{device_id}")
async def update_device_metadata(
    room_id: UUID,
    device_id: str,
    updates: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update device metadata (location, power consumption, etc.)"""
    _require_mutation_role(current_user)
    _require_mutation_permission(current_user, db)
    
    try:
        room = db.query(Room).filter(Room.id == room_id).first()
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")

        device_list = _read_room_device_list(room)
        device_index = next((index for index, item in enumerate(device_list) if item.get("device_id") == device_id), -1)
        if device_index < 0:
            raise HTTPException(status_code=404, detail="Device not found in room")

        device = dict(device_list[device_index])
        
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

        device_list[device_index] = device
        _write_room_device_list(room, device_list)

        room_device = db.query(RoomDevice).filter(
            RoomDevice.room_id == room_id,
            RoomDevice.device_id == device_id,
        ).first()
        if room_device:
            room_device.location_front_back = device["location_front_back"]
            room_device.location_left_right = device["location_left_right"]
            room_device.power_consumption_watts = int(device.get("power_consumption_watts", 0) or 0)
            room_device.updated_at = datetime.utcnow()

        device_state = db.query(DeviceState).filter(
            DeviceState.room_id == room_id,
            DeviceState.device_id == device_id,
        ).first()
        if device_state:
            now = datetime.utcnow()
            device_state.last_updated = now
            device_state.updated_at = now
        
        db.commit()
        db.refresh(room)
        
        return {
            "message": "Device updated successfully",
            "device": device
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update device: {str(e)}")

@router.delete("/rooms/{room_id}/devices/{device_id}", status_code=204)
async def remove_device_from_room(
    room_id: UUID,
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Remove device from room inventory"""
    _require_mutation_role(current_user)
    _require_mutation_permission(current_user, db)
    
    try:
        room = db.query(Room).filter(Room.id == room_id).first()
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")

        device_list = _read_room_device_list(room)
        initial_count = len(device_list)

        # Filter out the device
        filtered_devices = [d for d in device_list if d.get("device_id") != device_id]
        if len(filtered_devices) == initial_count:
            raise HTTPException(status_code=404, detail="Device not found")

        _write_room_device_list(room, filtered_devices)
        
        # Remove from device_states table too
        device_state = db.query(DeviceState).filter(
            DeviceState.room_id == room_id,
            DeviceState.device_id == device_id
        ).first()
        if device_state:
            db.delete(device_state)

        room_device = db.query(RoomDevice).filter(
            RoomDevice.room_id == room_id,
            RoomDevice.device_id == device_id,
        ).first()
        if room_device:
            db.delete(room_device)
        
        db.commit()
        
        return None  # 204 No Content
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to remove device: {str(e)}")

# =============================================================================
# DEVICE CONTROL (MANUAL TOGGLE)
# =============================================================================

@router.post("/devices/{device_id}/toggle")
async def toggle_device(
    device_id: str,
    toggle: DeviceToggle,
    room_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Manually toggle device ON/OFF (manual override).
    SYSTEM_ADMIN or FACILITY_STAFF can toggle.
    """
    _require_toggle_role(current_user)
    _require_toggle_permission(current_user, db)
    
    try:
        device_state = db.query(DeviceState).filter(
            DeviceState.room_id == room_id,
            DeviceState.device_id == device_id
        ).first()
        
        if not device_state:
            raise HTTPException(status_code=404, detail="Device not found")
        
        # Update device status
        device_state.status = toggle.action.upper()  # ON or OFF
        toggled_by_teacher = db.query(Teacher.id).filter(Teacher.id == current_user.id).first()
        device_state.last_toggled_by = current_user.id if toggled_by_teacher else None
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
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to toggle device: {str(e)}")

@router.post("/devices/{device_id}/auto")
async def clear_manual_override(
    device_id: str,
    room_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Clear manual override to re-enable auto-rules"""
    _require_toggle_role(current_user)
    _require_toggle_permission(current_user, db)
    
    try:
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
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to clear override: {str(e)}")

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


# =============================================================================
# DEVICE TYPE CATALOG + THRESHOLD SETTINGS
# =============================================================================

@router.get("/device-types")
async def list_device_types(db: Session = Depends(get_db)):
    items = (
        db.query(DeviceType)
        .filter(DeviceType.is_active == True)
        .filter(~DeviceType.code.in_(EXCLUDED_DEVICE_TYPES))
        .order_by(DeviceType.code.asc())
        .all()
    )

    return [
        DeviceTypeResponse(
            code=item.code,
            display_name=item.display_name,
            unit=item.unit,
            default_min=item.default_min,
            default_max=item.default_max,
            default_target=item.default_target,
            is_active=bool(item.is_active),
        )
        for item in items
    ]


@router.get("/thresholds/global")
async def get_global_thresholds(db: Session = Depends(get_db)):
    profiles = db.query(DeviceThresholdProfile).all()
    profile_map = {p.device_type_code: p for p in profiles}

    result = []
    for device_type in (
        db.query(DeviceType)
        .filter(DeviceType.is_active == True)
        .filter(~DeviceType.code.in_(EXCLUDED_DEVICE_TYPES))
        .order_by(DeviceType.code.asc())
        .all()
    ):
        profile = profile_map.get(device_type.code)
        result.append(
            {
                "device_type_code": device_type.code,
                "min_value": profile.min_value if profile else device_type.default_min,
                "max_value": profile.max_value if profile else device_type.default_max,
                "target_value": profile.target_value if profile else device_type.default_target,
                "enabled": bool(profile.enabled) if profile else True,
            }
        )

    return result


@router.put("/thresholds/global/{device_type_code}")
async def upsert_global_threshold(
    device_type_code: str,
    payload: ThresholdUpdatePayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_mutation_role(current_user)
    _require_mutation_permission(current_user, db)
    
    try:
        _validate_threshold_range(payload)
        device_type = _validate_device_type_supported(db, device_type_code)

        profile = db.query(DeviceThresholdProfile).filter(
            DeviceThresholdProfile.device_type_code == device_type.code
        ).first()

        if profile is None:
            profile = DeviceThresholdProfile(
                device_type_code=device_type.code,
                min_value=payload.min_value,
                max_value=payload.max_value,
                target_value=payload.target_value,
                enabled=bool(payload.enabled),
            )
            db.add(profile)
        else:
            profile.min_value = payload.min_value
            profile.max_value = payload.max_value
            profile.target_value = payload.target_value
            profile.enabled = bool(payload.enabled)
            profile.updated_at = datetime.utcnow()

        db.commit()

        return {
            "message": "Global threshold updated",
            "device_type_code": device_type.code,
            "min_value": profile.min_value,
            "max_value": profile.max_value,
            "target_value": profile.target_value,
            "enabled": bool(profile.enabled),
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update global threshold: {str(e)}")


@router.get("/rooms/{room_id}/thresholds")
async def get_room_thresholds(room_id: UUID, db: Session = Depends(get_db)):
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    profiles = db.query(DeviceThresholdProfile).all()
    profile_map = {p.device_type_code: p for p in profiles}
    room_overrides = db.query(RoomDeviceThreshold).filter(RoomDeviceThreshold.room_id == room_id).all()
    override_map = {o.device_type_code: o for o in room_overrides}

    result = []
    for device_type in (
        db.query(DeviceType)
        .filter(DeviceType.is_active == True)
        .filter(~DeviceType.code.in_(EXCLUDED_DEVICE_TYPES))
        .order_by(DeviceType.code.asc())
        .all()
    ):
        override = override_map.get(device_type.code)
        base = profile_map.get(device_type.code)
        result.append(
            {
                "room_id": str(room_id),
                "device_type_code": device_type.code,
                "min_value": (override.min_value if override else (base.min_value if base else device_type.default_min)),
                "max_value": (override.max_value if override else (base.max_value if base else device_type.default_max)),
                "target_value": (override.target_value if override else (base.target_value if base else device_type.default_target)),
                "enabled": bool(override.enabled) if override else (bool(base.enabled) if base else True),
                "is_override": override is not None,
            }
        )

    return result


@router.put("/rooms/{room_id}/thresholds/{device_type_code}")
async def upsert_room_threshold(
    room_id: UUID,
    device_type_code: str,
    payload: ThresholdUpdatePayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_mutation_role(current_user)
    _require_mutation_permission(current_user, db)
    
    try:
        room = db.query(Room).filter(Room.id == room_id).first()
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")

        _validate_threshold_range(payload)
        device_type = _validate_device_type_supported(db, device_type_code)

        override = db.query(RoomDeviceThreshold).filter(
            RoomDeviceThreshold.room_id == room_id,
            RoomDeviceThreshold.device_type_code == device_type.code,
        ).first()

        if override is None:
            override = RoomDeviceThreshold(
                room_id=room_id,
                device_type_code=device_type.code,
                min_value=payload.min_value,
                max_value=payload.max_value,
                target_value=payload.target_value,
                enabled=bool(payload.enabled),
            )
            db.add(override)
        else:
            override.min_value = payload.min_value
            override.max_value = payload.max_value
            override.target_value = payload.target_value
            override.enabled = bool(payload.enabled)
            override.updated_at = datetime.utcnow()

        db.commit()

        return {
            "message": "Room threshold updated",
            "room_id": str(room_id),
            "device_type_code": device_type.code,
            "min_value": override.min_value,
            "max_value": override.max_value,
            "target_value": override.target_value,
            "enabled": bool(override.enabled),
            "is_override": True,
        }
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update room threshold: {str(e)}")
