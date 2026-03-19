from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from uuid import UUID
from typing import List, Optional
from datetime import datetime

from app.database import get_db
from app.models import RiskIncident, ClassSession, Student, Room, Teacher
from app.schemas.common import IncidentResponse, IncidentCreate, IncidentReview

router = APIRouter(prefix="/api", tags=["Risk & Incidents"])

# =============================================================================
# INCIDENT MANAGEMENT
# =============================================================================

@router.get("/incidents", response_model=List[IncidentResponse])
async def list_all_incidents(
    room_id: Optional[UUID] = None,
    session_id: Optional[UUID] = None,
    reviewed: Optional[bool] = None,
    db: Session = Depends(get_db)
):
    """List all risk incidents with optional filters"""
    query = db.query(RiskIncident)
    
    if room_id:
        # Filter by room_id through session
        query = query.join(ClassSession).filter(ClassSession.room_id == room_id)
    
    if session_id:
        query = query.filter(RiskIncident.session_id == session_id)
    
    if reviewed is not None:
        query = query.filter(RiskIncident.reviewed == reviewed)
    
    incidents = query.order_by(RiskIncident.flagged_at.desc()).all()
    return incidents

@router.get("/rooms/{room_id}/incidents", response_model=List[IncidentResponse])
async def list_room_incidents(
    room_id: UUID,
    db: Session = Depends(get_db)
):
    """List all risk incidents in a room"""
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
async def get_incident(incident_id: UUID, db: Session = Depends(get_db)):
    """Get specific incident details with snapshot"""
    incident = db.query(RiskIncident).filter(RiskIncident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    return incident

@router.post("/incidents", status_code=201)
async def create_incident(
    incident: IncidentCreate,
    db: Session = Depends(get_db)
):
    """Create/flag a new risk incident (called by grading service when risk detected)"""
    session = db.query(ClassSession).filter(ClassSession.id == incident.session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
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
    reviewer_id: Optional[UUID] = None,  # Lecturer/Teacher ID
    db: Session = Depends(get_db)
):
    """Mark incident as reviewed with optional notes"""
    incident = db.query(RiskIncident).filter(RiskIncident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    
    incident.reviewed = True
    incident.reviewer_id = reviewer_id
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
async def get_unreviewed_incidents(room_id: UUID, db: Session = Depends(get_db)):
    """Get list of unreviewed incidents in a room"""
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
async def get_incident_snapshot(incident_id: UUID, db: Session = Depends(get_db)):
    """Download snapshot image from incident"""
    incident = db.query(RiskIncident).filter(RiskIncident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    
    if not incident.frame_snapshot:
        raise HTTPException(status_code=404, detail="No snapshot available")
    
    # Return as binary image
    from fastapi.responses import StreamingResponse
    import io
    
    return StreamingResponse(
        iter([incident.frame_snapshot]),
        media_type="image/jpeg"
    )
