from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from uuid import UUID
from typing import List, Optional
from datetime import datetime

from app.database import get_db
from app.models import RiskIncident, ClassSession, Student, Room, Teacher, User
from app.schemas.common import IncidentResponse, IncidentCreate, IncidentReview
from app.routers.auth import get_current_user, get_user_room_scope, get_user_block_scope, get_user_permissions, is_superuser

router = APIRouter(prefix="/api", tags=["Risk & Incidents"])


def _ensure_incident_role(current_user: User, allowed_roles: set[str]) -> None:
    if is_superuser(current_user):
        return
    if current_user.role not in allowed_roles:
        raise HTTPException(status_code=403, detail="Insufficient role for incident access")


def _ensure_incident_scope(current_user: User, room_id: UUID, db: Session) -> None:
    if is_superuser(current_user):
        return

    if current_user.role == "ACADEMIC_MANAGER":
        return

    if current_user.role in {"INSTRUCTOR"}:
        assigned_rooms = set(get_user_room_scope(current_user, db))
        if room_id not in assigned_rooms:
            raise HTTPException(status_code=403, detail="User not assigned to this room")

    if current_user.role == "ACADEMIC_MANAGER":
        room = db.query(Room).filter(Room.id == room_id).first()
        if not room:
            raise HTTPException(status_code=404, detail="Room not found")

        assigned_blocks = set(get_user_block_scope(current_user, db))
        if room.floor_id not in assigned_blocks:
            raise HTTPException(status_code=403, detail="User not assigned to this block")


def _ensure_incident_permissions(
    current_user: User,
    db: Session,
    required_permissions: set[str],
    require_all: bool = False,
) -> None:
    user_permissions = get_user_permissions(current_user, db)
    if require_all:
        missing_permissions = [perm for perm in required_permissions if perm not in user_permissions]
        if missing_permissions:
            raise HTTPException(
                status_code=403,
                detail=f"Missing required permissions: {','.join(missing_permissions)}",
            )
        return

    if required_permissions.isdisjoint(user_permissions):
        raise HTTPException(
            status_code=403,
            detail=f"Insufficient permissions. Requires one of: {','.join(sorted(required_permissions))}",
        )

# =============================================================================
# INCIDENT MANAGEMENT
# =============================================================================

@router.get("/incidents", response_model=List[IncidentResponse])
async def list_all_incidents(
    room_id: Optional[UUID] = None,
    session_id: Optional[UUID] = None,
    reviewed: Optional[bool] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all risk incidents with optional filters"""
    _ensure_incident_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_incident_permissions(current_user, db, {"incident:view"})

    query = db.query(RiskIncident)
    
    if room_id:
        # Filter by room_id through session
        query = query.join(ClassSession).filter(ClassSession.room_id == room_id)
    
    if session_id:
        query = query.filter(RiskIncident.session_id == session_id)
    
    if reviewed is not None:
        query = query.filter(RiskIncident.reviewed == reviewed)
    
    incidents = query.order_by(RiskIncident.flagged_at.desc()).all()

    if current_user.role == "INSTRUCTOR" and not is_superuser(current_user):
        assigned_rooms = set(get_user_room_scope(current_user, db))
        incidents = [
            incident
            for incident in incidents
            if incident.session and incident.session.room_id in assigned_rooms
        ]

    if current_user.role == "ACADEMIC_MANAGER" and not is_superuser(current_user):
        assigned_blocks = set(get_user_block_scope(current_user, db))
        incidents = [
            incident
            for incident in incidents
            if incident.session and incident.session.room and incident.session.room.floor_id in assigned_blocks
        ]

    return incidents

@router.get("/rooms/{room_id}/incidents", response_model=List[IncidentResponse])
async def list_room_incidents(
    room_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all risk incidents in a room"""
    _ensure_incident_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_incident_permissions(current_user, db, {"incident:view"})
    _ensure_incident_scope(current_user, room_id, db)

    room = db.query(Room).filter(Room.id == room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    
    incidents = (
        db.query(RiskIncident)
        .join(ClassSession)
        .filter(ClassSession.room_id == room_id)
        .order_by(RiskIncident.flagged_at.desc())
        .all()
    )
    
    return incidents

@router.get("/incidents/{incident_id}", response_model=IncidentResponse)
async def get_incident(
    incident_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get specific incident details with snapshot"""
    _ensure_incident_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_incident_permissions(current_user, db, {"incident:view"})

    incident = db.query(RiskIncident).filter(RiskIncident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if not incident.session:
        raise HTTPException(status_code=404, detail="Incident session not found")

    _ensure_incident_scope(current_user, incident.session.room_id, db)
    return incident

@router.post("/incidents", status_code=201)
async def create_incident(
    incident: IncidentCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create/flag a new risk incident (called by grading service when risk detected)"""
    _ensure_incident_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_incident_permissions(current_user, db, {"incident:view", "incident:resolve"})

    session = db.query(ClassSession).filter(ClassSession.id == incident.session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_incident_scope(current_user, session.room_id, db)
    
    student = db.query(Student).filter(Student.id == incident.student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    
    # Determine risk level
    if incident.risk_score >= 75:
        risk_level = "CRITICAL"
    elif incident.risk_score >= 50:
        risk_level = "HIGH"
    elif incident.risk_score >= 25:
        risk_level = "MEDIUM"
    else:
        risk_level = "LOW"
    
    new_incident = RiskIncident(
        session_id=incident.session_id,
        student_id=incident.student_id,
        risk_score=incident.risk_score,
        risk_level=risk_level,
        triggered_behaviors=incident.triggered_behaviors,
        flagged_at=datetime.utcnow()
    )
    
    db.add(new_incident)
    db.commit()
    db.refresh(new_incident)
    
    return {
        "message": "Risk incident flagged",
        "incident_id": new_incident.id,
        "risk_score": new_incident.risk_score,
        "risk_level": new_incident.risk_level
    }

@router.post("/incidents/{incident_id}/review")
async def review_incident(
    incident_id: UUID,
    review: IncidentReview,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Mark incident as reviewed with optional notes"""
    _ensure_incident_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_incident_permissions(current_user, db, {"incident:audit", "incident:resolve", "ai_alerts:acknowledge"})

    incident = db.query(RiskIncident).filter(RiskIncident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if not incident.session:
        raise HTTPException(status_code=404, detail="Incident session not found")

    _ensure_incident_scope(current_user, incident.session.room_id, db)
    
    incident.reviewed = True
    incident.reviewer_id = current_user.id
    incident.reviewer_notes = review.reviewer_notes
    incident.reviewed_at = datetime.utcnow()
    
    db.commit()
    db.refresh(incident)
    
    return {
        "message": "Incident reviewed",
        "incident_id": incident_id,
        "reviewed": True,
        "reviewer_notes": incident.reviewer_notes
    }

@router.get("/rooms/{room_id}/incidents/unreviewed")
async def get_unreviewed_incidents(
    room_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get list of unreviewed incidents in a room"""
    _ensure_incident_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_incident_permissions(current_user, db, {"incident:view"})
    _ensure_incident_scope(current_user, room_id, db)

    incidents = (
        db.query(RiskIncident)
        .join(ClassSession)
        .filter(
            ClassSession.room_id == room_id,
            RiskIncident.reviewed == False
        )
        .order_by(RiskIncident.risk_score.desc())
        .all()
    )
    
    return {
        "room_id": room_id,
        "unreviewed_count": len(incidents),
        "incidents": [
            {
                "incident_id": i.id,
                "student_id": i.student_id,
                "risk_score": i.risk_score,
                "risk_level": i.risk_level,
                "flagged_at": i.flagged_at
            }
            for i in incidents
        ]
    }

@router.get("/incidents/{incident_id}/snapshot")
async def get_incident_snapshot(
    incident_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Download snapshot image from incident"""
    _ensure_incident_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_incident_permissions(current_user, db, {"camera:view_recorded", "camera:view_live"})

    incident = db.query(RiskIncident).filter(RiskIncident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    if not incident.session:
        raise HTTPException(status_code=404, detail="Incident session not found")

    _ensure_incident_scope(current_user, incident.session.room_id, db)
    
    if not incident.frame_snapshot:
        raise HTTPException(status_code=404, detail="No snapshot available")
    
    # Return as binary image
    from fastapi.responses import StreamingResponse
    import io
    
    return StreamingResponse(
        iter([incident.frame_snapshot]),
        media_type="image/jpeg"
    )
