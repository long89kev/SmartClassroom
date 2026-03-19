from fastapi import APIRouter, Depends, HTTPException, status, Body
from sqlalchemy.orm import Session
from uuid import UUID
from typing import List, Optional
from datetime import datetime

from app.database import get_db
from app.models import IoTRule, Room
from app.schemas.common import IoTRuleCreate, IoTRuleUpdate, IoTRuleResponse

router = APIRouter(prefix="/api", tags=["IoT Auto-Rules"])

# =============================================================================
# IOT RULE MANAGEMENT
# =============================================================================

@router.get("/rules", response_model=List[IoTRuleResponse])
async def list_rules(
    room_id: Optional[UUID] = None,
    active_only: bool = True,
    db: Session = Depends(get_db)
):
    """List all IoT auto-rules with optional filters"""
    query = db.query(IoTRule)
    
    if room_id:
        query = query.filter(IoTRule.room_id == room_id)
    
    if active_only:
        query = query.filter(IoTRule.is_active == True)
    
    rules = query.order_by(IoTRule.priority.desc(), IoTRule.created_at.desc()).all()
    return rules

@router.get("/rooms/{room_id}/rules", response_model=List[IoTRuleResponse])
async def list_room_rules(room_id: UUID, db: Session = Depends(get_db)):
    """List all active rules for a specific room"""
    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    rules = db.query(IoTRule).filter(
        IoTRule.room_id == room_id,
        IoTRule.is_active == True
    ).order_by(IoTRule.priority.desc()).all()
    
    return rules

@router.post("/rules", response_model=IoTRuleResponse, status_code=201)
async def create_rule(
    rule: IoTRuleCreate,
    db: Session = Depends(get_db)
):
    """Create a new IoT auto-rule"""
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
    
    new_rule = IoTRule(
        rule_name=rule.rule_name,
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
async def get_rule(rule_id: UUID, db: Session = Depends(get_db)):
    """Get specific rule details"""
    rule = db.query(IoTRule).filter(IoTRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule

@router.put("/rules/{rule_id}", response_model=IoTRuleResponse)
async def update_rule(
    rule_id: UUID,
    updates: IoTRuleUpdate,
    db: Session = Depends(get_db)
):
    """Update an existing rule"""
    rule = db.query(IoTRule).filter(IoTRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    
    # Update allowed fields
    if updates.rule_name:
        rule.rule_name = updates.rule_name
    if updates.condition_params:
        rule.condition_params = updates.condition_params
    if updates.actions:
        rule.actions = updates.actions
    if updates.is_active is not None:
        rule.is_active = updates.is_active
    if updates.priority is not None:
        rule.priority = updates.priority
    
    db.commit()
    db.refresh(rule)
    
    return rule

@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(rule_id: UUID, db: Session = Depends(get_db)):
    """Delete (deactivate) a rule"""
    rule = db.query(IoTRule).filter(IoTRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    
    db.delete(rule)
    db.commit()
    
    return None  # 204 No Content

@router.post("/rules/{rule_id}/toggle")
async def toggle_rule_active(rule_id: UUID, db: Session = Depends(get_db)):
    """Toggle rule active/inactive status"""
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
    db: Session = Depends(get_db)
):
    """Helper: Create occupancy-based auto-rule template"""
    rule = IoTRuleCreate(
        rule_name=f"Occupancy rule for room {room_id}",
        room_id=room_id,
        condition_type="OCCUPANCY",
        condition_params={
            "min_occupancy": min_occupancy,
            "duration_minutes": duration_minutes
        },
        actions=[
            {"device_type": "LIGHT", "action": "ON"},
            {"device_type": "PROJECTOR", "action": "ON"}
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
    db: Session = Depends(get_db)
):
    """Helper: Create zero-occupancy auto-rule template (shutdown)"""
    rule = IoTRuleCreate(
        rule_name=f"Zero occupancy shutdown for room {room_id}",
        room_id=room_id,
        condition_type="ZERO_OCCUPANCY",
        condition_params={
            "idle_minutes": idle_minutes
        },
        actions=[
            {"device_type": "LIGHT", "action": "OFF"},
            {"device_type": "AC", "action": "OFF"},
            {"device_type": "PROJECTOR", "action": "OFF"},
            {"device_type": "FAN", "action": "OFF"}
        ],
        priority=0
    )
    
    new_rule = IoTRule(**rule.dict())
    db.add(new_rule)
    db.commit()
    db.refresh(new_rule)
    
    return new_rule
