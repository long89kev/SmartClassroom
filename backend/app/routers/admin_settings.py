from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Building, RefreshIntervalSetting, Room, User
from app.routers.auth import get_current_user, get_user_permissions

router = APIRouter(prefix="/api", tags=["Admin Settings"])

GROUP_KEYS = {"A", "B", "C", "LABS"}
SCOPE_TYPES = {"GROUP", "BUILDING", "ROOM"}
MODES = {"NORMAL", "TESTING"}
FALLBACK_INTERVALS = {"NORMAL": 30000, "TESTING": 2000}
MIN_INTERVAL_MS = 1000
MAX_INTERVAL_MS = 120000


class IntervalUpdatePayload(BaseModel):
    interval_ms: int = Field(..., ge=MIN_INTERVAL_MS, le=MAX_INTERVAL_MS)


def _ensure_admin_settings_access(current_user: User, db: Session) -> None:
    if current_user.role != "ACADEMIC_MANAGER":
        raise HTTPException(status_code=403, detail="Only ACADEMIC_MANAGER can update refresh interval settings")

    user_permissions = get_user_permissions(current_user, db)
    if "deploy:system_settings" not in user_permissions:
        raise HTTPException(status_code=403, detail="Missing deploy:system_settings permission")


def _ensure_dashboard_view_access(current_user: User, db: Session) -> None:
    user_permissions = get_user_permissions(current_user, db)
    required = {
        "dashboard:view_classroom",
        "dashboard:view_block",
        "dashboard:view_university",
        "dashboard:view_minimal",
    }
    if required.isdisjoint(user_permissions):
        raise HTTPException(status_code=403, detail="Insufficient dashboard permissions")


def _normalize_mode(mode: str) -> str:
    normalized = mode.strip().upper()
    if normalized not in MODES:
        raise HTTPException(status_code=400, detail="Mode must be NORMAL or TESTING")
    return normalized


def _resolve_group_key(building: Building) -> str | None:
    code = (building.code or "").strip().upper()
    if code.startswith("LAB"):
        return "LABS"
    if code.startswith("A"):
        return "A"
    if code.startswith("B"):
        return "B"
    if code.startswith("C"):
        return "C"
    return None


def _get_setting(db: Session, scope_type: str, scope_id: str, mode: str) -> RefreshIntervalSetting | None:
    return (
        db.query(RefreshIntervalSetting)
        .filter(
            RefreshIntervalSetting.scope_type == scope_type,
            RefreshIntervalSetting.scope_id == scope_id,
            RefreshIntervalSetting.mode == mode,
        )
        .first()
    )


def _upsert_setting(
    db: Session,
    *,
    scope_type: str,
    scope_id: str,
    mode: str,
    interval_ms: int,
    updated_by: UUID,
) -> RefreshIntervalSetting:
    setting = _get_setting(db, scope_type, scope_id, mode)
    if setting is None:
        setting = RefreshIntervalSetting(
            scope_type=scope_type,
            scope_id=scope_id,
            mode=mode,
            interval_ms=interval_ms,
            updated_by=updated_by,
        )
        db.add(setting)
    else:
        setting.interval_ms = interval_ms
        setting.updated_by = updated_by
        setting.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(setting)
    return setting


def _resolve_effective_interval(
    db: Session,
    *,
    building: Building,
    mode: str,
    room_id: UUID | None = None,
) -> dict:
    group_key = _resolve_group_key(building)

    if room_id is not None:
        room_setting = _get_setting(db, "ROOM", str(room_id), mode)
        if room_setting is not None:
            return {
                "mode": mode,
                "interval_ms": room_setting.interval_ms,
                "source_scope": "ROOM",
                "source_scope_id": room_setting.scope_id,
            }

    building_setting = _get_setting(db, "BUILDING", str(building.id), mode)
    if building_setting is not None:
        return {
            "mode": mode,
            "interval_ms": building_setting.interval_ms,
            "source_scope": "BUILDING",
            "source_scope_id": building_setting.scope_id,
        }

    if group_key:
        group_setting = _get_setting(db, "GROUP", group_key, mode)
        if group_setting is not None:
            return {
                "mode": mode,
                "interval_ms": group_setting.interval_ms,
                "source_scope": "GROUP",
                "source_scope_id": group_setting.scope_id,
            }

    return {
        "mode": mode,
        "interval_ms": FALLBACK_INTERVALS[mode],
        "source_scope": "FALLBACK",
        "source_scope_id": None,
    }


@router.get("/refresh-intervals/effective")
async def get_effective_refresh_interval(
    building_id: UUID,
    mode: str,
    room_id: UUID | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_dashboard_view_access(current_user, db)
    normalized_mode = _normalize_mode(mode)

    building = db.query(Building).filter(Building.id == building_id).first()
    if building is None:
        raise HTTPException(status_code=404, detail="Building not found")

    if room_id is not None:
        room = db.query(Room).filter(Room.id == room_id).first()
        if room is None:
            raise HTTPException(status_code=404, detail="Room not found")
        if room.floor is None or room.floor.building_id != building.id:
            raise HTTPException(status_code=400, detail="Room does not belong to building")

    resolved = _resolve_effective_interval(db, building=building, mode=normalized_mode, room_id=room_id)
    return {
        **resolved,
        "building_id": str(building.id),
        "room_id": str(room_id) if room_id else None,
        "min_interval_ms": MIN_INTERVAL_MS,
        "max_interval_ms": MAX_INTERVAL_MS,
    }


@router.get("/admin/refresh-intervals/groups")
async def list_group_refresh_intervals(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    rows = []
    for group_code in sorted(GROUP_KEYS):
        row = {"group_code": group_code}
        for mode in sorted(MODES):
            setting = _get_setting(db, "GROUP", group_code, mode)
            row[f"{mode.lower()}_interval_ms"] = setting.interval_ms if setting else FALLBACK_INTERVALS[mode]
        rows.append(row)

    return {
        "groups": rows,
        "min_interval_ms": MIN_INTERVAL_MS,
        "max_interval_ms": MAX_INTERVAL_MS,
    }


@router.put("/admin/refresh-intervals/groups/{group_code}/{mode}")
async def upsert_group_refresh_interval(
    group_code: str,
    mode: str,
    payload: IntervalUpdatePayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    normalized_group = group_code.strip().upper()
    if normalized_group not in GROUP_KEYS:
        raise HTTPException(status_code=400, detail="Group must be one of A, B, C, LABS")

    normalized_mode = _normalize_mode(mode)
    setting = _upsert_setting(
        db,
        scope_type="GROUP",
        scope_id=normalized_group,
        mode=normalized_mode,
        interval_ms=payload.interval_ms,
        updated_by=current_user.id,
    )
    return {
        "scope_type": setting.scope_type,
        "scope_id": setting.scope_id,
        "mode": setting.mode,
        "interval_ms": setting.interval_ms,
    }


@router.get("/admin/refresh-intervals/buildings/{building_id}")
async def get_building_refresh_intervals(
    building_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    building = db.query(Building).filter(Building.id == building_id).first()
    if building is None:
        raise HTTPException(status_code=404, detail="Building not found")

    group_code = _resolve_group_key(building)
    values = []
    for mode in sorted(MODES):
        override = _get_setting(db, "BUILDING", str(building.id), mode)
        resolved = _resolve_effective_interval(db, building=building, mode=mode)
        values.append(
            {
                "mode": mode,
                "interval_ms": resolved["interval_ms"],
                "is_override": override is not None,
                "source_scope": resolved["source_scope"],
                "source_scope_id": resolved["source_scope_id"],
            }
        )

    return {
        "building_id": str(building.id),
        "building_name": building.name,
        "building_code": building.code,
        "group_code": group_code,
        "values": values,
        "min_interval_ms": MIN_INTERVAL_MS,
        "max_interval_ms": MAX_INTERVAL_MS,
    }


@router.put("/admin/refresh-intervals/buildings/{building_id}/{mode}")
async def upsert_building_refresh_interval(
    building_id: UUID,
    mode: str,
    payload: IntervalUpdatePayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    building = db.query(Building).filter(Building.id == building_id).first()
    if building is None:
        raise HTTPException(status_code=404, detail="Building not found")

    normalized_mode = _normalize_mode(mode)
    setting = _upsert_setting(
        db,
        scope_type="BUILDING",
        scope_id=str(building.id),
        mode=normalized_mode,
        interval_ms=payload.interval_ms,
        updated_by=current_user.id,
    )
    return {
        "scope_type": setting.scope_type,
        "scope_id": setting.scope_id,
        "mode": setting.mode,
        "interval_ms": setting.interval_ms,
    }


@router.delete("/admin/refresh-intervals/buildings/{building_id}/{mode}")
async def reset_building_refresh_interval(
    building_id: UUID,
    mode: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    building = db.query(Building).filter(Building.id == building_id).first()
    if building is None:
        raise HTTPException(status_code=404, detail="Building not found")

    normalized_mode = _normalize_mode(mode)
    (
        db.query(RefreshIntervalSetting)
        .filter(
            RefreshIntervalSetting.scope_type == "BUILDING",
            RefreshIntervalSetting.scope_id == str(building.id),
            RefreshIntervalSetting.mode == normalized_mode,
        )
        .delete()
    )
    db.commit()

    return {"message": "Building override removed"}


@router.get("/admin/refresh-intervals/rooms/{room_id}")
async def get_room_refresh_intervals(
    room_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    room = db.query(Room).filter(Room.id == room_id).first()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.floor is None:
        raise HTTPException(status_code=400, detail="Room floor context missing")

    building = room.floor.building
    values = []
    for mode in sorted(MODES):
        override = _get_setting(db, "ROOM", str(room.id), mode)
        resolved = _resolve_effective_interval(db, building=building, mode=mode, room_id=room.id)
        values.append(
            {
                "mode": mode,
                "interval_ms": resolved["interval_ms"],
                "is_override": override is not None,
                "source_scope": resolved["source_scope"],
                "source_scope_id": resolved["source_scope_id"],
            }
        )

    return {
        "room_id": str(room.id),
        "room_code": room.room_code,
        "building_id": str(building.id),
        "building_code": building.code,
        "values": values,
        "min_interval_ms": MIN_INTERVAL_MS,
        "max_interval_ms": MAX_INTERVAL_MS,
    }


@router.put("/admin/refresh-intervals/rooms/{room_id}/{mode}")
async def upsert_room_refresh_interval(
    room_id: UUID,
    mode: str,
    payload: IntervalUpdatePayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    room = db.query(Room).filter(Room.id == room_id).first()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    normalized_mode = _normalize_mode(mode)
    setting = _upsert_setting(
        db,
        scope_type="ROOM",
        scope_id=str(room.id),
        mode=normalized_mode,
        interval_ms=payload.interval_ms,
        updated_by=current_user.id,
    )
    return {
        "scope_type": setting.scope_type,
        "scope_id": setting.scope_id,
        "mode": setting.mode,
        "interval_ms": setting.interval_ms,
    }


@router.delete("/admin/refresh-intervals/rooms/{room_id}/{mode}")
async def reset_room_refresh_interval(
    room_id: UUID,
    mode: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_admin_settings_access(current_user, db)

    room = db.query(Room).filter(Room.id == room_id).first()
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")

    normalized_mode = _normalize_mode(mode)
    (
        db.query(RefreshIntervalSetting)
        .filter(
            RefreshIntervalSetting.scope_type == "ROOM",
            RefreshIntervalSetting.scope_id == str(room.id),
            RefreshIntervalSetting.mode == normalized_mode,
        )
        .delete()
    )
    db.commit()

    return {"message": "Room override removed"}
