from fastapi import APIRouter, Depends, HTTPException, status, Body
from sqlalchemy import and_, case, or_
from sqlalchemy.orm import Session
from uuid import UUID
from typing import List, Optional
from datetime import datetime

from app.database import get_db
from app.models import IoTRule, Room, Floor, Building, User
from app.schemas.common import IoTRuleCreate, IoTRuleUpdate, IoTRuleResponse
from app.routers.auth import get_current_user, get_user_permissions

router = APIRouter(prefix="/api", tags=["IoT Auto-Rules"])


def _ensure_rule_mutation_role(current_user: User) -> None:
    if current_user.role not in {"ACADEMIC_MANAGER", "FACILITY_STAFF"}:
        raise HTTPException(status_code=403, detail="Only ACADEMIC_MANAGER or FACILITY_STAFF can modify rules")


def _ensure_rule_permissions(current_user: User, db: Session, required_permissions: set[str]) -> None:
    user_permissions = get_user_permissions(current_user, db)
    if required_permissions.isdisjoint(user_permissions):
        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Requires one of: {','.join(sorted(required_permissions))}",
        )


def _get_room_and_building_ids(db: Session, room_id: UUID) -> tuple[Room, UUID]:
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    building_id = db.query(Floor.building_id).filter(Floor.id == room.floor_id).scalar()
    if not building_id:
        raise HTTPException(status_code=404, detail="Building not found for room")

    return room, building_id


def _scope_order_expression():
    return case(
        (IoTRule.scope_type == "GLOBAL", 0),
        (IoTRule.scope_type == "BUILDING", 1),
        (IoTRule.scope_type == "ROOM", 2),
        else_=3,
    )


def _validate_rule_scope(scope_type: str, building_id: Optional[UUID], room_id: Optional[UUID], db: Session) -> None:
    if scope_type == "GLOBAL":
        if building_id is not None or room_id is not None:
            raise HTTPException(status_code=400, detail="GLOBAL rules cannot set building_id or room_id")
        return

    if scope_type == "BUILDING":
        if building_id is None or room_id is not None:
            raise HTTPException(status_code=400, detail="BUILDING rules require building_id and must not set room_id")
        building_exists = db.query(Building.id).filter(Building.id == building_id).first()
        if not building_exists:
            raise HTTPException(status_code=404, detail="Building not found")
        return

    if scope_type == "ROOM":
        if room_id is None or building_id is not None:
            raise HTTPException(status_code=400, detail="ROOM rules require room_id and must not set building_id")
        room_exists = db.query(Room.id).filter(Room.id == room_id).first()
        if not room_exists:
            raise HTTPException(status_code=404, detail="Room not found")
        return

    raise HTTPException(status_code=400, detail="scope_type must be one of: GLOBAL, BUILDING, ROOM")

# =============================================================================
# IOT RULE MANAGEMENT
# =============================================================================

@router.get("/rules", response_model=List[IoTRuleResponse])
async def list_rules(
    room_id: Optional[UUID] = None,
    building_id: Optional[UUID] = None,
    active_only: bool = True,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List IoT auto-rules with scope-aware filtering."""
    _ensure_rule_permissions(
        current_user,
        db,
        {"env_control:light", "env_control:fan", "env_control:ac", "dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university"},
    )

    query = db.query(IoTRule)
    
    if room_id:
        _, resolved_building_id = _get_room_and_building_ids(db, room_id)
        query = query.filter(
            or_(
                IoTRule.scope_type == "GLOBAL",
                and_(IoTRule.scope_type == "BUILDING", IoTRule.building_id == resolved_building_id),
                and_(IoTRule.scope_type == "ROOM", IoTRule.room_id == room_id),
            )
        )
    elif building_id:
        query = query.filter(
            or_(
                IoTRule.scope_type == "GLOBAL",
                and_(IoTRule.scope_type == "BUILDING", IoTRule.building_id == building_id),
            )
        )
    
    if active_only:
        query = query.filter(IoTRule.is_active == True)
    
    rules = query.order_by(_scope_order_expression(), IoTRule.priority.desc(), IoTRule.created_at.desc()).all()
    return rules

@router.get("/rooms/{room_id}/rules", response_model=List[IoTRuleResponse])
async def list_room_rules(
    room_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all active rules that apply to a specific room."""
    _ensure_rule_permissions(
        current_user,
        db,
        {"env_control:light", "env_control:fan", "env_control:ac", "dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university"},
    )

    _, building_id = _get_room_and_building_ids(db, room_id)
    
    rules = db.query(IoTRule).filter(
        IoTRule.is_active == True,
        or_(
            IoTRule.scope_type == "GLOBAL",
            and_(IoTRule.scope_type == "BUILDING", IoTRule.building_id == building_id),
            and_(IoTRule.scope_type == "ROOM", IoTRule.room_id == room_id),
        )
    ).order_by(_scope_order_expression(), IoTRule.priority.desc(), IoTRule.created_at.desc()).all()
    
    return rules

@router.post("/rules", response_model=IoTRuleResponse, status_code=201)
async def create_rule(
    rule: IoTRuleCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new IoT auto-rule"""
    _ensure_rule_mutation_role(current_user)
    _ensure_rule_permissions(current_user, db, {"deploy:device_management", "deploy:system_settings"})

    room = db.query(Room).filter(Room.id == rule.room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    # Validate condition_type
    valid_types = ["OCCUPANCY", "TIMETABLE", "ZERO_OCCUPANCY", "TIME_BASED"]
    if rule.condition_type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"condition_type must be one of: {', '.join(valid_types)}"
        )

    _validate_rule_scope(rule.scope_type, rule.building_id, rule.room_id, db)
    
    new_rule = IoTRule(
        rule_name=rule.rule_name,
        scope_type=rule.scope_type,
        building_id=rule.building_id,
        room_id=rule.room_id,
        condition_type=rule.condition_type,
        condition_params=rule.condition_params,
        actions=rule.actions,
        priority=rule.priority,
        is_active=True
    )
    
    db.add(new_rule)
    db.commit()
    db.refresh(new_rule)
    
    return new_rule

@router.get("/rules/{rule_id}", response_model=IoTRuleResponse)
async def get_rule(
    rule_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get specific rule details"""
    _ensure_rule_permissions(
        current_user,
        db,
        {"env_control:light", "env_control:fan", "env_control:ac", "dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university"},
    )

    rule = db.query(IoTRule).filter(IoTRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule

@router.put("/rules/{rule_id}", response_model=IoTRuleResponse)
async def update_rule(
    rule_id: UUID,
    updates: IoTRuleUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update an existing rule"""
    _ensure_rule_mutation_role(current_user)
    _ensure_rule_permissions(current_user, db, {"deploy:device_management", "deploy:system_settings"})

    rule = db.query(IoTRule).filter(IoTRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    
    # Update allowed fields
    if updates.rule_name:
        rule.rule_name = updates.rule_name
    if "scope_type" in updates.model_fields_set:
        rule.scope_type = updates.scope_type
    if "building_id" in updates.model_fields_set:
        rule.building_id = updates.building_id
    if "room_id" in updates.model_fields_set:
        rule.room_id = updates.room_id
    if updates.condition_params:
        rule.condition_params = updates.condition_params
    if updates.actions:
        rule.actions = updates.actions
    if updates.is_active is not None:
        rule.is_active = updates.is_active
    if updates.priority is not None:
        rule.priority = updates.priority

    _validate_rule_scope(rule.scope_type, rule.building_id, rule.room_id, db)
    
    db.commit()
    db.refresh(rule)
    
    return rule

@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete (deactivate) a rule"""
    _ensure_rule_mutation_role(current_user)
    _ensure_rule_permissions(current_user, db, {"deploy:device_management", "deploy:system_settings"})

    rule = db.query(IoTRule).filter(IoTRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    
    db.delete(rule)
    db.commit()
    
    return None  # 204 No Content

@router.post("/rules/{rule_id}/toggle")
async def toggle_rule_active(
    rule_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Toggle rule active/inactive status"""
    _ensure_rule_mutation_role(current_user)
    _ensure_rule_permissions(current_user, db, {"deploy:device_management", "deploy:system_settings"})

    rule = db.query(IoTRule).filter(IoTRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    
    rule.is_active = not rule.is_active
    db.commit()
    db.refresh(rule)
    
    return {
        "message": f"Rule {rule.rule_name} is now {'active' if rule.is_active else 'inactive'}",
        "rule_id": rule_id,
        "is_active": rule.is_active
    }

# =============================================================================
# EXAMPLE RULE CREATION HELPERS
# =============================================================================

@router.post("/rooms/{room_id}/rules/occupancy-template")
async def create_occupancy_rule(
    room_id: UUID,
    min_occupancy: int = 1,
    duration_minutes: int = 2,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Helper: Create occupancy-based auto-rule template"""
    _ensure_rule_mutation_role(current_user)
    _ensure_rule_permissions(current_user, db, {"deploy:device_management", "deploy:system_settings"})

    rule = IoTRuleCreate(
        rule_name=f"Occupancy rule for room {room_id}",
        scope_type="ROOM",
        room_id=room_id,
        condition_type="OCCUPANCY",
        condition_params={
            "min_occupancy": min_occupancy,
            "duration_minutes": duration_minutes
        },
        actions=[
            {"device_type": "LIGHT", "action": "ON"},
            {"device_type": "FAN", "action": "ON"}
        ],
        priority=1
    )
    
    new_rule = IoTRule(**rule.dict())
    db.add(new_rule)
    db.commit()
    db.refresh(new_rule)
    
    return new_rule

@router.post("/rooms/{room_id}/rules/zero-occupancy-template")
async def create_zero_occupancy_rule(
    room_id: UUID,
    idle_minutes: int = 30,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Helper: Create zero-occupancy auto-rule template (shutdown)"""
    _ensure_rule_mutation_role(current_user)
    _ensure_rule_permissions(current_user, db, {"deploy:device_management", "deploy:system_settings"})

    rule = IoTRuleCreate(
        rule_name=f"Zero occupancy shutdown for room {room_id}",
        scope_type="ROOM",
        room_id=room_id,
        condition_type="ZERO_OCCUPANCY",
        condition_params={
            "idle_minutes": idle_minutes
        },
        actions=[
            {"device_type": "LIGHT", "action": "OFF"},
            {"device_type": "AC", "action": "OFF"},
            {"device_type": "FAN", "action": "OFF"}
        ],
        priority=0
    )
    
    new_rule = IoTRule(**rule.dict())
    db.add(new_rule)
    db.commit()
    db.refresh(new_rule)
    
    return new_rule
