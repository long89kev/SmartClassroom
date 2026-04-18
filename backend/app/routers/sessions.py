from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from uuid import UUID
from typing import List, Optional
from datetime import datetime, time
import base64

from app.database import get_db
from app.models import ClassSession, Room, Teacher, Subject, Timetable, BehaviorLog, RiskIncident, PerformanceAggregate, User
from app.schemas.common import (
    SessionCreate, SessionResponse, SessionModeChange, 
    BehaviorIngest, SessionAnalyticsResponse,
    LearningModeIngest, TestingModeIngest,
    LearningModeResponse, TestingModeResponse
)
from app.routers.auth import get_current_user, get_user_room_scope, get_user_permissions, check_mode_access
from app.services.grading_engine import PerformanceScorer, RiskDetector
from app.services.yolo_inference import YOLOInferenceService

router = APIRouter(prefix="/api", tags=["Sessions & AI"])

# Initialize AI services (YOLO only, RiskDetector created per-request)
yolo_service = YOLOInferenceService()


def _ensure_session_role(current_user: User, allowed_roles: set[str]) -> None:
    if current_user.role not in allowed_roles:
        raise HTTPException(status_code=403, detail="Insufficient role for this session action")


def _ensure_room_scope(current_user: User, room_id: UUID, db: Session) -> None:
    if current_user.role == "SYSTEM_ADMIN":
        return

    if current_user.role in {"LECTURER", "EXAM_PROCTOR"}:
        allowed_rooms = set(get_user_room_scope(current_user, db))
        if room_id not in allowed_rooms:
            raise HTTPException(status_code=403, detail="User not assigned to this room")


def _ensure_session_permissions(
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


def _parse_timetable_time(raw_value: object) -> Optional[time]:
    if raw_value is None:
        return None
    if isinstance(raw_value, time):
        return raw_value

    value = str(raw_value).strip()
    if not value:
        return None

    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(value, fmt).time()
        except ValueError:
            continue
    return None


def _serialize_session_target(session: ClassSession, fallback_reason: str) -> dict:
    building_id = None
    if session.room and session.room.floor:
        building_id = session.room.floor.building_id

    return {
        "session_id": session.id,
        "room_id": session.room_id,
        "room_code": session.room.room_code if session.room else None,
        "building_id": building_id,
        "mode": session.mode,
        "fallback_reason": fallback_reason,
        "start_time": session.start_time,
    }


def _serialize_session_summary(session: ClassSession, risk_alerts_count: int) -> dict:
    return {
        "id": session.id,
        "room_id": session.room_id,
        "room_code": session.room.room_code if session.room else None,
        "teacher_id": session.teacher_id,
        "teacher_name": session.teacher.name if session.teacher else None,
        "subject_id": session.subject_id,
        "subject_name": session.subject.name if session.subject else None,
        "mode": session.mode,
        "status": session.status,
        "start_time": session.start_time,
        "end_time": session.end_time,
        "students_present": session.students_present or [],
        "risk_alerts_count": risk_alerts_count,
    }


def _resolve_teacher_for_user(current_user: User, db: Session) -> Optional[Teacher]:
    teacher = db.query(Teacher).filter(Teacher.user_id == current_user.id).first()
    if teacher:
        return teacher
    if current_user.email:
        return db.query(Teacher).filter(Teacher.email == current_user.email).first()
    return None


def _get_latest_active_session_for_room(room_id: UUID, db: Session) -> Optional[ClassSession]:
    return (
        db.query(ClassSession)
        .filter(
            ClassSession.room_id == room_id,
            ClassSession.status == "ACTIVE",
        )
        .order_by(ClassSession.start_time.desc())
        .first()
    )

# =============================================================================
# SESSION MANAGEMENT
# =============================================================================

@router.post("/sessions", response_model=SessionResponse, status_code=201)
async def create_session(
    session: SessionCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Start a new class session (NORMAL or TESTING mode)"""
    _ensure_session_role(current_user, {"LECTURER", "EXAM_PROCTOR", "SYSTEM_ADMIN"})
    _ensure_session_permissions(current_user, db, {"mode:switch_learning", "mode:switch_testing"})

    # Validate room, teacher, subject exist
    room = db.query(Room).filter(Room.id == session.room_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    _ensure_room_scope(current_user, room.id, db)
    
    teacher = db.query(Teacher).filter(Teacher.id == session.teacher_id).first()
    if not teacher:
        raise HTTPException(status_code=404, detail="Teacher not found")
    
    subject = db.query(Subject).filter(Subject.id == session.subject_id).first()
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found")

    existing_active_session = _get_latest_active_session_for_room(session.room_id, db)
    if existing_active_session:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Room already has an active session ({existing_active_session.id}). "
                "End the active session before creating a new one."
            ),
        )
    
    # Create session
    students_present = [str(student_id) for student_id in (session.students_present or [])]

    new_session = ClassSession(
        room_id=session.room_id,
        teacher_id=session.teacher_id,
        subject_id=session.subject_id,
        students_present=students_present,
        mode="NORMAL",  # NORMAL or TESTING
        status="ACTIVE",
        start_time=datetime.utcnow()
    )
    
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    
    return new_session

@router.get("/sessions")
async def list_sessions(
    status_filter: Optional[str] = None,
    mode: Optional[str] = None,
    room_id: Optional[UUID] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List sessions for dashboard views with optional filters."""
    _ensure_session_permissions(
        current_user,
        db,
        {"dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university", "dashboard:view_minimal"},
    )

    query = db.query(ClassSession)

    if current_user.role in {"LECTURER", "EXAM_PROCTOR"}:
        allowed_rooms = get_user_room_scope(current_user, db)
        query = query.filter(ClassSession.room_id.in_(allowed_rooms if allowed_rooms else [UUID("00000000-0000-0000-0000-000000000000")]))

    if status_filter:
        query = query.filter(ClassSession.status == status_filter.upper())

    if mode:
        query = query.filter(ClassSession.mode == mode.upper())

    if room_id:
        query = query.filter(ClassSession.room_id == room_id)

    sessions = query.order_by(ClassSession.start_time.desc()).all()

    results = []
    for session in sessions:
        risk_alerts_count = (
            db.query(RiskIncident)
            .filter(RiskIncident.session_id == session.id)
            .count()
        )
        results.append({
            "id": session.id,
            "room_id": session.room_id,
            "room_code": session.room.room_code if session.room else None,
            "teacher_id": session.teacher_id,
            "teacher_name": session.teacher.name if session.teacher else None,
            "subject_id": session.subject_id,
            "subject_name": session.subject.name if session.subject else None,
            "mode": session.mode,
            "status": session.status,
            "start_time": session.start_time,
            "end_time": session.end_time,
            "students_present": session.students_present or [],
            "risk_alerts_count": risk_alerts_count
        })

    return results


@router.get("/sessions/me/room-context")
async def get_tutor_room_context(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Resolve a fixed tutor room context and active sessions scoped to that room."""
    _ensure_session_permissions(
        current_user,
        db,
        {"dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university", "dashboard:view_minimal"},
    )
    _ensure_session_role(current_user, {"LECTURER", "EXAM_PROCTOR"})

    allowed_room_ids = get_user_room_scope(current_user, db)
    if not allowed_room_ids:
        return {
            "building_id": None,
            "floor_id": None,
            "room_id": None,
            "room_code": None,
            "active_sessions": [],
            "selected_session_id": None,
            "selection_reason": "no_assigned_room",
        }

    rooms = (
        db.query(Room)
        .filter(Room.id.in_(allowed_room_ids))
        .all()
    )
    if not rooms:
        return {
            "building_id": None,
            "floor_id": None,
            "room_id": None,
            "room_code": None,
            "active_sessions": [],
            "selected_session_id": None,
            "selection_reason": "no_assigned_room",
        }

    rooms_by_id = {room.id: room for room in rooms}
    sorted_rooms = sorted(rooms, key=lambda room: room.room_code or "")
    selected_room = sorted_rooms[0]
    selection_reason = "first_assigned_room"

    teacher = _resolve_teacher_for_user(current_user, db)
    if teacher:
        now_local = datetime.now()
        now_weekday = now_local.weekday()
        now_time = now_local.time()

        timetable_slots = (
            db.query(Timetable)
            .filter(
                Timetable.teacher_id == teacher.id,
                Timetable.day_of_week == now_weekday,
                Timetable.room_id.in_(allowed_room_ids),
            )
            .all()
        )
        for slot in timetable_slots:
            slot_start = _parse_timetable_time(slot.start_time)
            slot_end = _parse_timetable_time(slot.end_time)
            if not slot_start or not slot_end:
                continue
            if slot_start <= now_time <= slot_end and slot.room_id in rooms_by_id:
                selected_room = rooms_by_id[slot.room_id]
                selection_reason = "timetable_room"
                break

    active_sessions = (
        db.query(ClassSession)
        .filter(
            ClassSession.room_id == selected_room.id,
            ClassSession.status == "ACTIVE",
        )
        .order_by(ClassSession.start_time.desc())
        .all()
    )

    active_summaries = []
    for active_session in active_sessions:
        risk_alerts_count = (
            db.query(RiskIncident)
            .filter(RiskIncident.session_id == active_session.id)
            .count()
        )
        active_summaries.append(_serialize_session_summary(active_session, risk_alerts_count))

    selected_session_id = None
    if teacher:
        teacher_owned = next((session for session in active_sessions if session.teacher_id == teacher.id), None)
        if teacher_owned:
            selected_session_id = teacher_owned.id
            selection_reason = "teacher_owned_active"

    if selected_session_id is None and active_sessions:
        selected_session_id = active_sessions[0].id
        if selection_reason == "first_assigned_room":
            selection_reason = "room_recent_active"

    building_id = selected_room.floor.building_id if selected_room.floor else None

    return {
        "building_id": building_id,
        "floor_id": selected_room.floor_id,
        "room_id": selected_room.id,
        "room_code": selected_room.room_code,
        "active_sessions": active_summaries,
        "selected_session_id": selected_session_id,
        "selection_reason": selection_reason,
    }


@router.get("/sessions/me/current")
async def get_current_session_target(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Resolve the best current session target for the authenticated user."""
    _ensure_session_permissions(
        current_user,
        db,
        {"dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university", "dashboard:view_minimal"},
    )

    if current_user.role not in {"LECTURER", "EXAM_PROCTOR", "SYSTEM_ADMIN"}:
        raise HTTPException(status_code=403, detail="Role cannot resolve session target")

    room_scope = get_user_room_scope(current_user, db)
    scoped_query = db.query(ClassSession).filter(ClassSession.status == "ACTIVE")

    if current_user.role in {"LECTURER", "EXAM_PROCTOR"}:
        if not room_scope:
            return {
                "session_id": None,
                "room_id": None,
                "room_code": None,
                "building_id": None,
                "mode": None,
                "fallback_reason": "none",
                "start_time": None,
            }
        scoped_query = scoped_query.filter(ClassSession.room_id.in_(room_scope))

    if current_user.role == "LECTURER":
        teacher = _resolve_teacher_for_user(current_user, db)
        if teacher:
            now_local = datetime.now()
            now_weekday = now_local.weekday()
            now_time = now_local.time()

            timetable_query = db.query(Timetable).filter(
                Timetable.teacher_id == teacher.id,
                Timetable.day_of_week == now_weekday,
            )
            if room_scope:
                timetable_query = timetable_query.filter(Timetable.room_id.in_(room_scope))

            for slot in timetable_query.all():
                slot_start = _parse_timetable_time(slot.start_time)
                slot_end = _parse_timetable_time(slot.end_time)
                if not slot_start or not slot_end:
                    continue
                if not (slot_start <= now_time <= slot_end):
                    continue

                slot_session = (
                    scoped_query.filter(
                        ClassSession.teacher_id == teacher.id,
                        ClassSession.room_id == slot.room_id,
                    )
                    .order_by(ClassSession.start_time.desc())
                    .first()
                )
                if slot_session:
                    return _serialize_session_target(slot_session, "timetable")

                existing_room_active = _get_latest_active_session_for_room(slot.room_id, db)
                if existing_room_active:
                    return _serialize_session_target(existing_room_active, "timetable")

                # Auto-create a session when timetable slot is active but no runtime session exists.
                new_session = ClassSession(
                    room_id=slot.room_id,
                    teacher_id=slot.teacher_id,
                    subject_id=slot.subject_id,
                    timetable_id=slot.id,
                    mode="NORMAL",
                    status="ACTIVE",
                    start_time=datetime.utcnow(),
                )
                db.add(new_session)
                db.commit()
                db.refresh(new_session)
                return _serialize_session_target(new_session, "auto_created_from_timetable")

            teacher_recent_active = (
                scoped_query.filter(ClassSession.teacher_id == teacher.id)
                .order_by(ClassSession.start_time.desc())
                .first()
            )
            if teacher_recent_active:
                return _serialize_session_target(teacher_recent_active, "recent_active")

    recent_active = scoped_query.order_by(ClassSession.start_time.desc()).first()
    if recent_active:
        return _serialize_session_target(recent_active, "recent_active")

    return {
        "session_id": None,
        "room_id": None,
        "room_code": None,
        "building_id": None,
        "mode": None,
        "fallback_reason": "none",
        "start_time": None,
    }

@router.get("/sessions/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get session details"""
    _ensure_session_permissions(
        current_user,
        db,
        {"dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university"},
    )

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)
    return session

@router.put("/sessions/{session_id}/mode")
async def change_session_mode(
    session_id: UUID,
    mode_change: SessionModeChange,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Switch session between NORMAL and TESTING mode"""
    _ensure_session_role(current_user, {"LECTURER", "SYSTEM_ADMIN"})

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)
    
    if session.status != "ACTIVE":
        raise HTTPException(status_code=400, detail="Can only change mode of active sessions")
    
    if mode_change.mode.upper() not in ["NORMAL", "TESTING"]:
        raise HTTPException(status_code=400, detail="Mode must be NORMAL or TESTING")

    target_mode = "LEARNING" if mode_change.mode.upper() == "NORMAL" else "TESTING"
    required_mode_permission = "mode:switch_learning" if target_mode == "LEARNING" else "mode:switch_testing"
    _ensure_session_permissions(current_user, db, {required_mode_permission})

    if not check_mode_access(current_user, target_mode, db):
        raise HTTPException(status_code=403, detail=f"Role {current_user.role} cannot switch to {target_mode}")
    
    session.mode = mode_change.mode.upper()
    db.commit()
    db.refresh(session)
    
    return {
        "message": f"Session mode changed to {session.mode}",
        "session_id": session_id,
        "mode": session.mode
    }

# =============================================================================
# LEARNING MODE - Performance Grading with AI
# =============================================================================

@router.post("/sessions/{session_id}/learn", response_model=LearningModeResponse, status_code=201)
async def ingest_learning_mode(
    session_id: UUID,
    behavior: LearningModeIngest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Learning Mode: AI detects behaviors and calculates performance scores.
    
    1. YOLO runs inference on image
    2. Detections mapped to behavior classes
    3. Performance scored per student using weights
    4. Results returned with annotated image
    """
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_session_role(current_user, {"LECTURER", "SYSTEM_ADMIN"})
    _ensure_room_scope(current_user, session.room_id, db)
    
    if session.status != "ACTIVE":
        raise HTTPException(status_code=400, detail="Session is not active")

    if session.mode != "NORMAL":
        raise HTTPException(status_code=400, detail="Session must be in NORMAL mode")

    _ensure_session_permissions(
        current_user,
        db,
        {"mode:switch_learning", "ai_alerts:view"},
        require_all=True,
    )
    
    try:
        if not yolo_service.is_ready():
            raise HTTPException(status_code=503, detail="YOLO model not loaded")

        # Run YOLO inference on image
        frame_result = yolo_service.process_frame(
            behavior.image_base64,
            conf_threshold=behavior.confidence_threshold,
            student_id=behavior.student_id,
            mode="LEARNING",
        )
        
        # Store detections as behavior logs
        detections = frame_result["detections"]
        stored_detections = []
        
        for detection in detections:
            student_id = detection.get("student_id", behavior.student_id)
            if not student_id:
                continue
            
            log = BehaviorLog(
                session_id=session_id,
                actor_id=student_id,
                actor_type="STUDENT",
                behavior_class=detection["behavior_class"],
                count=1,
                duration_seconds=0,
                frame_snapshot=behavior.image_base64,
                yolo_confidence=detection["confidence"],
                detected_at=datetime.utcnow()
            )
            db.add(log)
            stored_detections.append(detection)
        
        db.commit()
        
        # Calculate performance scores
        performance_scorer = PerformanceScorer(db)
        analyzed_students = []
        
        # Get unique students in detections
        unique_students = set(d.get("student_id", behavior.student_id) for d in detections if d.get("student_id") or behavior.student_id)
        
        for student_id in unique_students:
            perf_score = performance_scorer.calculate_performance(
                session_id=session_id,
                actor_id=student_id,
                actor_type="STUDENT",
                subject_id=session.subject_id
            )
            
            # Update aggregate
            performance_scorer.update_performance_aggregate(
                session_id=session_id,
                actor_id=student_id,
                actor_type="STUDENT",
                performance_score=perf_score
            )
            
            analyzed_students.append({
                "student_id": str(student_id),
                "performance_score": round(perf_score, 2)
            })
        
        return LearningModeResponse(
            session_id=session_id,
            mode="LEARNING",
            detections=stored_detections,
            annotated_image_base64=frame_result["annotated_image_base64"],
            detection_count=frame_result["detection_count"],
            students_analyzed=analyzed_students
        )
    
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Learning mode processing failed: {str(e)}")

# =============================================================================
# TESTING MODE - Cheat Detection with Risk Scoring
# =============================================================================

@router.post("/sessions/{session_id}/test", response_model=TestingModeResponse, status_code=201)
async def ingest_testing_mode(
    session_id: UUID,
    behavior: TestingModeIngest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Testing Mode: AI detects suspicious behaviors and calculates risk scores.
    Auto-creates RiskIncidents when risk exceeds threshold.
    
    1. YOLO runs inference on image
    2. Detections mapped to behavior classes
    3. Risk scored per student (weighted: device_usage=0.4, talking=0.3, head_turn=0.2, etc.)
    4. Incidents auto-flagged if risk > 0.65
    5. Results returned with annotated image and incident list
    """
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_session_role(current_user, {"EXAM_PROCTOR", "SYSTEM_ADMIN"})
    _ensure_room_scope(current_user, session.room_id, db)

    if not check_mode_access(current_user, "TESTING", db):
        raise HTTPException(status_code=403, detail=f"Role {current_user.role} cannot operate TESTING mode")
    
    if session.status != "ACTIVE":
        raise HTTPException(status_code=400, detail="Session is not active")
    
    if session.mode != "TESTING":
        raise HTTPException(status_code=400, detail="Session must be in TESTING mode")

    _ensure_session_permissions(
        current_user,
        db,
        {"mode:switch_testing", "ai_alerts:view"},
        require_all=True,
    )
    
    try:
        if not yolo_service.is_ready():
            raise HTTPException(status_code=503, detail="YOLO model not loaded")
        
        # Run YOLO inference on image
        frame_result = yolo_service.process_frame(
            behavior.image_base64,
            conf_threshold=behavior.confidence_threshold,
            student_id=None,  # Will be assigned from face detection
            mode="TESTING",
        )
        
        # Store detection logs
        detections = frame_result["detections"]
        room_id = session.room_id
        
        for detection in detections:
            log = BehaviorLog(
                session_id=session_id,
                actor_id=detection.get("student_id"),
                actor_type="STUDENT",
                behavior_class=detection["behavior_class"],
                count=1,
                duration_seconds=0,
                frame_snapshot=behavior.image_base64,
                yolo_confidence=detection["confidence"],
                detected_at=datetime.utcnow()
            )
            db.add(log)
        
        db.commit()
        
        # Analyze risk and create incidents
        risk_detector_instance = RiskDetector(db)
        risk_analysis = risk_detector_instance.batch_analyze_behaviors(
            session_id=session_id,
            detected_behaviors=detections
        )
        
        incidents_created = []
        
        for student_id, risk_data in risk_analysis.items():
            if risk_data["should_flag"]:
                # Auto-create incident
                incident = risk_detector_instance.create_risk_incident(
                    session_id=session_id,
                    student_id=student_id,
                    room_id=room_id,
                    risk_score=risk_data["risk_score"],
                    behavior_details=risk_data["behaviors"],
                    image_with_detections=frame_result["annotated_image_base64"]
                )
                incidents_created.append(incident.id)
        
        return TestingModeResponse(
            session_id=session_id,
            mode="TESTING",
            detections=detections,
            annotated_image_base64=frame_result["annotated_image_base64"],
            detection_count=frame_result["detection_count"],
            risk_analysis=risk_analysis,
            incidents_created=incidents_created
        )
    
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Testing mode processing failed: {str(e)}")

# =============================================================================
# LEGACY ENDPOINT (kept for backward compatibility)
# =============================================================================

@router.post("/sessions/{session_id}/behavior", status_code=201)
async def ingest_behavior(
    session_id: UUID,
    behavior: BehaviorIngest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    [DEPRECATED] Generic behavior ingestion.
    Use /sessions/{id}/learn or /sessions/{id}/test instead.
    """
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_session_role(current_user, {"LECTURER", "EXAM_PROCTOR", "SYSTEM_ADMIN"})
    _ensure_room_scope(current_user, session.room_id, db)
    
    if session.status != "ACTIVE":
        raise HTTPException(status_code=400, detail="Session is not active")

    _ensure_session_permissions(current_user, db, {"ai_alerts:view"})
    
    # Create behavior log entry
    log = BehaviorLog(
        session_id=session_id,
        actor_id=behavior.actor_id,
        actor_type=behavior.actor_type,
        behavior_class=behavior.behavior_class,
        count=behavior.count,
        duration_seconds=behavior.duration_seconds,
        frame_snapshot=behavior.frame_snapshot,
        yolo_confidence=behavior.yolo_confidence,
        detected_at=datetime.utcnow()
    )
    
    db.add(log)
    db.commit()
    db.refresh(log)
    
    return {
        "message": "Behavior recorded (legacy endpoint)",
        "behavior_log_id": log.id,
        "behavior_class": log.behavior_class,
        "actor_type": log.actor_type,
        "confidence": log.yolo_confidence
    }

@router.get("/sessions/{session_id}/analytics", response_model=SessionAnalyticsResponse)
async def get_session_analytics(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get live analytics dashboard for a session"""
    _ensure_session_permissions(
        current_user,
        db,
        {"report:performance", "dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university"},
    )

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)
    
    # Calculate elapsed time
    elapsed_seconds = (datetime.utcnow() - session.start_time).total_seconds()
    elapsed_minutes = int(elapsed_seconds / 60)
    
    # Get behavior logs
    behaviors = db.query(BehaviorLog).filter(BehaviorLog.session_id == session_id).all()
    
    # Count behaviors by actor
    student_behaviors = {}
    teacher_behaviors = {}
    
    for log in behaviors:
        if log.actor_type == "STUDENT":
            if log.actor_id not in student_behaviors:
                student_behaviors[log.actor_id] = {}
            if log.behavior_class not in student_behaviors[log.actor_id]:
                student_behaviors[log.actor_id][log.behavior_class] = 0
            student_behaviors[log.actor_id][log.behavior_class] += log.count
        else:
            if log.behavior_class not in teacher_behaviors:
                teacher_behaviors[log.behavior_class] = 0
            teacher_behaviors[log.behavior_class] += log.count
    
    # Count risk incidents (if TESTING mode)
    risk_count = 0
    if session.mode == "TESTING":
        risk_count = db.query(RiskIncident).filter(
            RiskIncident.session_id == session_id
        ).count()
    
    return SessionAnalyticsResponse(
        session_id=session_id,
        mode=session.mode,
        status=session.status,
        start_time=session.start_time,
        elapsed_minutes=elapsed_minutes,
        student_performance=student_behaviors,
        teacher_performance=teacher_behaviors,
        risk_alerts_count=risk_count
    )

@router.get("/sessions/{session_id}/latest-frame")
async def get_latest_session_frame(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Return latest frame for dashboard preview (live behavior first, incident fallback)."""
    _ensure_session_permissions(current_user, db, {"camera:view_live", "camera:view_recorded"})

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)

    latest_behavior = (
        db.query(BehaviorLog)
        .filter(
            BehaviorLog.session_id == session_id,
            BehaviorLog.frame_snapshot.isnot(None)
        )
        .order_by(BehaviorLog.detected_at.desc())
        .first()
    )

    if latest_behavior and latest_behavior.frame_snapshot:
        snapshot = latest_behavior.frame_snapshot

        if isinstance(snapshot, bytes):
            try:
                decoded = snapshot.decode("utf-8")
                image_base64 = decoded
            except UnicodeDecodeError:
                image_base64 = base64.b64encode(snapshot).decode("utf-8")
        else:
            image_base64 = str(snapshot)

        return {
            "source": "live",
            "image_base64": image_base64,
            "captured_at": latest_behavior.detected_at
        }

    latest_incident = (
        db.query(RiskIncident)
        .filter(
            RiskIncident.session_id == session_id,
            RiskIncident.frame_snapshot.isnot(None)
        )
        .order_by(RiskIncident.flagged_at.desc())
        .first()
    )

    if latest_incident and latest_incident.frame_snapshot:
        snapshot = latest_incident.frame_snapshot

        if isinstance(snapshot, bytes):
            try:
                decoded = snapshot.decode("utf-8")
                image_base64 = decoded
            except UnicodeDecodeError:
                image_base64 = base64.b64encode(snapshot).decode("utf-8")
        else:
            image_base64 = str(snapshot)

        return {
            "source": "incident",
            "image_base64": image_base64,
            "captured_at": latest_incident.flagged_at
        }

    return {
        "source": "none",
        "image_base64": None,
        "captured_at": None
    }

@router.post("/sessions/{session_id}/end")
async def end_session(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """End session and calculate final scores"""
    _ensure_session_role(current_user, {"LECTURER", "EXAM_PROCTOR", "SYSTEM_ADMIN"})
    _ensure_session_permissions(current_user, db, {"mode:switch_learning", "mode:switch_testing"})

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)
    
    if session.status != "ACTIVE":
        raise HTTPException(status_code=400, detail="Session is not active")
    
    # Mark as completed
    session.status = "COMPLETED"
    session.end_time = datetime.utcnow()
    
    # Calculate final performance scores
    performance_scorer = PerformanceScorer(db)
    
    # Get all unique students in this session
    behavior_logs = db.query(BehaviorLog).filter(
        BehaviorLog.session_id == session_id,
        BehaviorLog.actor_type == "STUDENT"
    ).distinct(BehaviorLog.actor_id)
    
    for log in behavior_logs:
        final_score = performance_scorer.calculate_performance(
            session_id=session_id,
            actor_id=log.actor_id,
            actor_type="STUDENT",
            subject_id=session.subject_id
        )
        performance_scorer.update_performance_aggregate(
            session_id=session_id,
            actor_id=log.actor_id,
            actor_type="STUDENT",
            performance_score=final_score
        )
    
    db.commit()
    db.refresh(session)
    
    return {
        "message": "Session ended",
        "session_id": session_id,
        "end_time": session.end_time,
        "status": session.status,
        "duration_minutes": int((session.end_time - session.start_time).total_seconds() / 60)
    }

@router.get("/rooms/{room_id}/sessions/active")
async def get_active_sessions(
    room_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get all active sessions in a room"""
    _ensure_session_permissions(
        current_user,
        db,
        {"dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university", "dashboard:view_minimal"},
    )
    _ensure_room_scope(current_user, room_id, db)

    sessions = db.query(ClassSession).filter(
        ClassSession.room_id == room_id,
        ClassSession.status == "ACTIVE"
    ).all()
    
    return {
        "room_id": room_id,
        "active_sessions": len(sessions),
        "sessions": [
            {
                "session_id": s.id,
                "teacher_id": s.teacher_id,
                "mode": s.mode,
                "start_time": s.start_time
            }
            for s in sessions
        ]
    }
