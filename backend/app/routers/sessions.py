from fastapi import APIRouter, Depends, HTTPException, status, File, UploadFile, BackgroundTasks, Form
from sqlalchemy.orm import Session
from uuid import UUID
from typing import Any, List, Optional, Dict
from datetime import datetime, time
from pathlib import Path
import base64

from app.config import get_settings
from app.database import get_db, SessionLocal
from app.models import ClassSession, Room, Teacher, Subject, Timetable, BehaviorLog, RiskIncident, PerformanceAggregate, User, ProcessedFrame
from app.schemas.common import (
    SessionCreate, SessionResponse, SessionModeChange, 
    BehaviorIngest, SessionAnalyticsResponse,
    LearningModeIngest, TestingModeIngest,
    LearningModeResponse, TestingModeResponse, TempFrameResponse,
    TempOutputFrameResponse, UploadAnalyzeResponse
)
from app.routers.auth import get_current_user, get_user_room_scope, get_user_permissions, check_mode_access, is_superuser
from app.services.grading_engine import PerformanceScorer, RiskDetector
from app.services.yolo_inference import YOLOInferenceService
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Sessions & AI"])

# Initialize AI services (YOLO only, RiskDetector created per-request)
yolo_service = YOLOInferenceService()

UNKNOWN_STUDENT_ID = UUID("00000000-0000-0000-0000-000000000000")

def _safe_uuid(val: Any) -> UUID:
    if isinstance(val, UUID):
        return val
    try:
        return UUID(str(val))
    except (ValueError, TypeError):
        return UNKNOWN_STUDENT_ID

_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def _resolve_temp_frames_dir(raw_path: str) -> Path:
    temp_dir = Path(raw_path)
    if temp_dir.is_absolute():
        return temp_dir

    repo_root = Path(__file__).resolve().parents[3]
    return repo_root.joinpath(temp_dir)


def _finalize_learning_ingest(
    session_id: UUID,
    subject_id: UUID,
    detections: List[Dict],
    snapshot_bytes: Optional[bytes],
    annotated_image_base64: Optional[str] = None,
    filename: Optional[str] = None,
    student_id_override: Optional[UUID] = None,
):
    """Background task to persist behavior logs and update performance scores."""
    db = SessionLocal()
    try:
        # 1. Store behavior logs
        for detection in detections:
            student_id = _safe_uuid(detection.get("student_id", student_id_override))
            
            log = BehaviorLog(
                session_id=session_id,
                actor_id=student_id,
                actor_type="STUDENT",
                behavior_class=detection["behavior_class"],
                count=1,
                duration_seconds=0,
                frame_snapshot=snapshot_bytes,
                yolo_confidence=detection["confidence"],
                detected_at=datetime.utcnow()
            )
            db.add(log)
        
        # 1.5 Store annotated frame for replay/history
        if annotated_image_base64:
            try:
                b64_data = annotated_image_base64.split(",")[1] if "," in annotated_image_base64 else annotated_image_base64
                annotated_bytes = base64.b64decode(b64_data)
                
                new_frame = ProcessedFrame(
                    session_id=session_id,
                    frame_snapshot=annotated_bytes,
                    filename=filename,
                    detected_at=datetime.utcnow()
                )
                db.add(new_frame)
            except Exception as fe:
                logger.error("[Background] Failed to save processed frame: %s", fe)

        db.commit()

        # 2. Update performance scores
        performance_scorer = PerformanceScorer(db)
        unique_students = set(
            _safe_uuid(d.get("student_id", student_id_override)) 
            for d in detections if d.get("student_id") or student_id_override
        )
        
        for student_id in unique_students:
            perf_score = performance_scorer.calculate_performance(
                session_id=session_id,
                actor_id=student_id,
                actor_type="STUDENT",
                subject_id=subject_id
            )
            performance_scorer.update_performance_aggregate(
                session_id=session_id,
                actor_id=student_id,
                actor_type="STUDENT",
                performance_score=perf_score
            )
        db.commit()
    except Exception as e:
        logger.error("[Background] Finalize learning ingest failed: %s", e)
        db.rollback()
    finally:
        db.close()


def _finalize_testing_ingest(
    session_id: UUID,
    room_id: UUID,
    detections: List[Dict],
    snapshot_bytes: Optional[bytes],
    annotated_image_base64: str,
):
    """Background task to persist logs and create risk incidents."""
    db = SessionLocal()
    try:
        # 1. Store behavior logs
        for detection in detections:
            student_id = _safe_uuid(detection.get("student_id"))
            
            log = BehaviorLog(
                session_id=session_id,
                actor_id=student_id,
                actor_type="STUDENT",
                behavior_class=detection["behavior_class"],
                count=1,
                duration_seconds=0,
                frame_snapshot=snapshot_bytes,
                yolo_confidence=detection["confidence"],
                detected_at=datetime.utcnow()
            )
            db.add(log)
        
        # 1.5 Store annotated frame for replay/history
        if annotated_image_base64:
            try:
                b64_data = annotated_image_base64.split(",")[1] if "," in annotated_image_base64 else annotated_image_base64
                annotated_bytes = base64.b64decode(b64_data)
                
                new_frame = ProcessedFrame(
                    session_id=session_id,
                    frame_snapshot=annotated_bytes,
                    filename=f"testing_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.jpg",
                    detected_at=datetime.utcnow()
                )
                db.add(new_frame)
            except Exception as fe:
                logger.error("[Background] Failed to save processed frame: %s", fe)

        db.commit()

        # 2. Analyze risk and create incidents
        risk_detector_instance = RiskDetector(db)
        risk_analysis = risk_detector_instance.batch_analyze_behaviors(
            session_id=session_id,
            detected_behaviors=detections
        )
        
        for student_id, risk_data in risk_analysis.items():
            if risk_data["should_flag"]:
                risk_detector_instance.create_risk_incident(
                    session_id=session_id,
                    student_id=student_id,
                    room_id=room_id,
                    risk_score=risk_data["risk_score"],
                    behavior_details=risk_data["behaviors"],
                    image_with_detections=annotated_image_base64
                )
        db.commit()
    except Exception as e:
        logger.error("[Background] Finalize testing ingest failed: %s", e)
        db.rollback()
    finally:
        db.close()


def _list_temp_frames(temp_dir: Path, sort: str) -> List[Path]:
    if not temp_dir.exists() or not temp_dir.is_dir():
        return []

    candidates = [
        path
        for path in temp_dir.iterdir()
        if path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS
    ]

    if sort == "mtime":
        candidates.sort(key=lambda path: path.stat().st_mtime)
    else:
        candidates.sort(key=lambda path: path.name.lower())

    return candidates


def _resolve_image_mime(file_path: Path) -> str:
    suffix = file_path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    return "application/octet-stream"


def _serialize_frame_snapshot(frame_snapshot: object) -> Optional[str]:
    if frame_snapshot is None:
        return None

    if isinstance(frame_snapshot, memoryview):
        frame_snapshot = frame_snapshot.tobytes()

    if isinstance(frame_snapshot, bytearray):
        frame_snapshot = bytes(frame_snapshot)

    if isinstance(frame_snapshot, bytes):
        try:
            return frame_snapshot.decode("utf-8")
        except UnicodeDecodeError:
            if frame_snapshot.startswith(b"\x89PNG\r\n\x1a\n"):
                mime = "image/png"
            elif frame_snapshot.startswith(b"\xff\xd8\xff"):
                mime = "image/jpeg"
            elif frame_snapshot.startswith(b"GIF87a") or frame_snapshot.startswith(b"GIF89a"):
                mime = "image/gif"
            elif frame_snapshot.startswith(b"RIFF") and frame_snapshot[8:12] == b"WEBP":
                mime = "image/webp"
            else:
                mime = "application/octet-stream"

            encoded = base64.b64encode(frame_snapshot).decode("ascii")
            return f"data:{mime};base64,{encoded}"

    return str(frame_snapshot)


def _ensure_session_role(current_user: User, allowed_roles: set[str]) -> None:
    if is_superuser(current_user):
        return

    if current_user.role not in allowed_roles:
        raise HTTPException(status_code=403, detail="Insufficient role for this session action")


def _ensure_room_scope(current_user: User, room_id: UUID, db: Session) -> None:
    if is_superuser(current_user):
        return

    if current_user.role == "ACADEMIC_MANAGER":
        return

    if current_user.role == "INSTRUCTOR":
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
    _ensure_session_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
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

    if current_user.role == "INSTRUCTOR":
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

    # For INSTRUCTOR roles, use room assignments; for superuser/ACADEMIC_MANAGER, find any active session
    if not is_superuser(current_user) and current_user.role not in {"INSTRUCTOR", "ACADEMIC_MANAGER"}:
        raise HTTPException(status_code=403, detail="Role cannot resolve room context")

    # Superuser / ACADEMIC_MANAGER: find the most recent active session across all rooms
    if is_superuser(current_user) or current_user.role == "ACADEMIC_MANAGER":
        recent_active = (
            db.query(ClassSession)
            .filter(ClassSession.status == "ACTIVE")
            .order_by(ClassSession.start_time.desc())
            .first()
        )
        if not recent_active or not recent_active.room:
            return {
                "building_id": None,
                "floor_id": None,
                "room_id": None,
                "room_code": None,
                "active_sessions": [],
                "selected_session_id": None,
                "selection_reason": "no_assigned_room",
            }

        selected_room = recent_active.room
        building_id = selected_room.floor.building_id if selected_room.floor else None

        all_active_in_room = (
            db.query(ClassSession)
            .filter(ClassSession.room_id == selected_room.id, ClassSession.status == "ACTIVE")
            .order_by(ClassSession.start_time.desc())
            .all()
        )
        active_summaries = []
        for sess in all_active_in_room:
            risk_alerts_count = db.query(RiskIncident).filter(RiskIncident.session_id == sess.id).count()
            active_summaries.append(_serialize_session_summary(sess, risk_alerts_count))

        return {
            "building_id": building_id,
            "floor_id": selected_room.floor_id,
            "room_id": selected_room.id,
            "room_code": selected_room.room_code,
            "active_sessions": active_summaries,
            "selected_session_id": recent_active.id,
            "selection_reason": "room_recent_active",
        }

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

    if not is_superuser(current_user) and current_user.role not in {"INSTRUCTOR", "ACADEMIC_MANAGER"}:
        raise HTTPException(status_code=403, detail="Role cannot resolve session target")

    room_scope = get_user_room_scope(current_user, db)
    scoped_query = db.query(ClassSession).filter(ClassSession.status == "ACTIVE")

    if current_user.role == "INSTRUCTOR" and not is_superuser(current_user):
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

    if current_user.role == "INSTRUCTOR":
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
    _ensure_session_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})

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
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    confidence_threshold: float = Form(0.5),
    student_id: Optional[UUID] = Form(None),
    source_filename: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Learning Mode: AI detects behaviors using binary image upload.
    """
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_session_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_room_scope(current_user, session.room_id, db)
    
    if session.status != "ACTIVE":
        raise HTTPException(status_code=400, detail="Session is not active")

    if session.mode != "NORMAL":
        raise HTTPException(status_code=400, detail="Session must be in NORMAL mode")

    try:
        if not yolo_service.is_ready():
            raise HTTPException(status_code=503, detail="YOLO model not loaded")

        # Read raw binary bytes directly from the upload
        image_bytes = await image.read()
        image_base64 = base64.b64encode(image_bytes).decode("utf-8")
        data_uri = f"data:{image.content_type};base64,{image_base64}"

        resolved_source_filename = source_filename or f"live_{session_id}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}.jpg"

        # Run YOLO inference
        frame_result = yolo_service.process_frame(
            data_uri,
            conf_threshold=confidence_threshold,
            student_id=student_id,
            mode="LEARNING",
            output_dir=None,
            source_filename=resolved_source_filename,
        )
        
        # Offload DB persistence and scoring to background
        background_tasks.add_task(
            _finalize_learning_ingest,
            session_id=session_id,
            subject_id=session.subject_id,
            detections=frame_result["detections"],
            snapshot_bytes=image_bytes,
            annotated_image_base64=frame_result["annotated_image_base64"],
            filename=resolved_source_filename,
            student_id_override=student_id
        )

        return LearningModeResponse(
            session_id=session_id,
            mode="LEARNING",
            detections=frame_result["detections"],
            annotated_image_base64=frame_result["annotated_image_base64"],
            detection_count=frame_result["detection_count"],
            students_analyzed=[] 
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[API] Learning mode processing failed for session %s", session_id)
        raise HTTPException(status_code=400, detail=f"Learning mode processing failed: {str(e)}")

# =============================================================================
# TESTING MODE - Cheat Detection with Risk Scoring
# =============================================================================

@router.post("/sessions/{session_id}/test", response_model=TestingModeResponse, status_code=201)
async def ingest_testing_mode(
    session_id: UUID,
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    confidence_threshold: float = Form(0.5),
    source_filename: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Testing Mode: AI detects suspicious behaviors using binary image upload.
    """
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_session_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
    _ensure_room_scope(current_user, session.room_id, db)

    if not check_mode_access(current_user, "TESTING", db):
        raise HTTPException(status_code=403, detail=f"Role {current_user.role} cannot operate TESTING mode")
    
    if session.status != "ACTIVE":
        raise HTTPException(status_code=400, detail="Session is not active")
    
    if session.mode != "TESTING":
        raise HTTPException(status_code=400, detail="Session must be in TESTING mode")

    try:
        if not yolo_service.is_ready():
            raise HTTPException(status_code=503, detail="YOLO model not loaded")
        
        # Read raw binary bytes
        image_bytes = await image.read()
        image_base64 = base64.b64encode(image_bytes).decode("utf-8")
        data_uri = f"data:{image.content_type};base64,{image_base64}"

        resolved_source_filename = source_filename or f"live_{session_id}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}.jpg"

        # Run YOLO inference
        frame_result = yolo_service.process_frame(
            data_uri,
            conf_threshold=confidence_threshold,
            student_id=None,
            mode="TESTING",
            output_dir=None,
            source_filename=resolved_source_filename,
        )
        
        # Offload persistence, risk analysis, and incident creation to background
        background_tasks.add_task(
            _finalize_testing_ingest,
            session_id=session_id,
            room_id=session.room_id,
            detections=frame_result["detections"],
            snapshot_bytes=image_bytes,
            annotated_image_base64=frame_result["annotated_image_base64"]
        )

        return TestingModeResponse(
            session_id=session_id,
            mode="TESTING",
            detections=frame_result["detections"],
            annotated_image_base64=frame_result["annotated_image_base64"],
            detection_count=frame_result["detection_count"],
            risk_analysis={}, # Alerts will be generated in background
            incidents_created=[]
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("[API] Testing mode processing failed for session %s", session_id)
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
    _ensure_session_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
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


@router.get("/sessions/{session_id}/temp-frame", response_model=TempFrameResponse)
async def get_temp_replay_frame(
    session_id: UUID,
    index: int = 0,
    sort: str = "name",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Return a single Temp replay frame (dev only)."""
    settings = get_settings()
    if not settings.debug and not settings.temp_frames_enabled:
        raise HTTPException(status_code=404, detail="Temp replay is disabled")

    _ensure_session_permissions(current_user, db, {"camera:view_live", "camera:view_recorded"})

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)

    if index < 0:
        raise HTTPException(status_code=400, detail="Index must be >= 0")

    sort_key = sort.strip().lower() if sort else "name"
    if sort_key not in {"name", "mtime"}:
        raise HTTPException(status_code=400, detail="Sort must be name or mtime")

    temp_dir = _resolve_temp_frames_dir(settings.temp_frames_dir)
    frames = _list_temp_frames(temp_dir, sort_key)

    if not frames:
        raise HTTPException(status_code=404, detail="No temp frames available")

    if index >= len(frames):
        raise HTTPException(
            status_code=400,
            detail=f"Index out of range (max {len(frames) - 1})",
        )

    frame_path = frames[index]
    try:
        image_bytes = frame_path.read_bytes()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read temp frame: {exc}")

    mime_type = _resolve_image_mime(frame_path)
    encoded = base64.b64encode(image_bytes).decode("utf-8")
    image_base64 = f"data:{mime_type};base64,{encoded}"

    next_index = index + 1 if index + 1 < len(frames) else None

    return TempFrameResponse(
        index=index,
        total=len(frames),
        filename=frame_path.name,
        image_base64=image_base64,
        has_next=next_index is not None,
        next_index=next_index,
    )


@router.get("/sessions/{session_id}/temp-output-frame", response_model=TempOutputFrameResponse)
async def get_temp_output_frame(
    session_id: UUID,
    index: int = 0,
    sort: str = "name",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Browse annotated output frames from processed_frames database table."""
    _ensure_session_permissions(current_user, db, {"camera:view_live", "camera:view_recorded"})

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)

    if index < 0:
        raise HTTPException(status_code=400, detail="Index must be >= 0")

    # Fetch frames from DB ordered by detected_at
    query = db.query(ProcessedFrame).filter(ProcessedFrame.session_id == session_id)
    total = query.count()
    
    if total == 0:
        raise HTTPException(status_code=404, detail="No annotated output frames available in database")

    if index >= total:
        raise HTTPException(
            status_code=400,
            detail=f"Index out of range (max {total - 1})",
        )

    # Get specific frame by index
    # Note: Using offset for index-based browsing to match existing frontend expectations
    frame = query.order_by(ProcessedFrame.detected_at.asc()).offset(index).first()
    
    if not frame:
        raise HTTPException(status_code=404, detail="Frame not found")

    image_base64 = _serialize_frame_snapshot(frame.frame_snapshot)
    next_index = index + 1 if index + 1 < total else None

    return TempOutputFrameResponse(
        index=index,
        total=total,
        filename=frame.filename or f"frame_{frame.id}.jpg",
        image_base64=image_base64,
        has_next=next_index is not None,
        next_index=next_index,
    )


@router.post("/sessions/{session_id}/temp-batch-inference")
async def run_temp_batch_inference(
    session_id: UUID,
    mode: str = "LEARNING",
    confidence_threshold: float = 0.5,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Batch process ALL Temp images through YOLO inference.
    Reads from Temp/, runs YOLO, saves results to ProcessedFrame table.
    Returns processing results with annotated image count.
    """
    _ensure_session_permissions(current_user, db, {"camera:view_live", "camera:view_recorded"})

    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)

    if not yolo_service.is_ready():
        raise HTTPException(status_code=503, detail="YOLO model not loaded")

    # Read all input frames from local Temp folder
    input_dir = _resolve_temp_frames_dir(get_settings().temp_frames_dir)
    input_frames = _list_temp_frames(input_dir, "name")

    if not input_frames:
        raise HTTPException(status_code=404, detail="No temp frames available in input directory")

    resolved_mode = mode.upper()
    if resolved_mode not in {"LEARNING", "TESTING"}:
        resolved_mode = "LEARNING"

    results = []
    errors = []
    last_annotated_base64 = None

    for frame_path in input_frames:
        try:
            image_bytes = frame_path.read_bytes()
            mime_type = _resolve_image_mime(frame_path)
            encoded = base64.b64encode(image_bytes).decode("utf-8")
            image_base64 = f"data:{mime_type};base64,{encoded}"

            frame_result = yolo_service.process_frame(
                image_base64,
                conf_threshold=confidence_threshold,
                student_id=None,
                mode=resolved_mode,
                output_dir=None, # DB storage
                source_filename=frame_path.name,
            )
            
            # Persist to DB immediately
            annotated_b64 = frame_result.get("annotated_image_base64")
            if annotated_b64:
                b64_data = annotated_b64.split(",")[1] if "," in annotated_b64 else annotated_b64
                new_frame = ProcessedFrame(
                    session_id=session_id,
                    frame_snapshot=base64.b64decode(b64_data),
                    filename=frame_path.name,
                    detected_at=datetime.utcnow()
                )
                db.add(new_frame)
                last_annotated_base64 = annotated_b64

            results.append({
                "filename": frame_path.name,
                "detection_count": frame_result["detection_count"],
                "saved_to_db": True
            })
        except Exception as e:
            errors.append({
                "filename": frame_path.name,
                "error": str(e),
            })

    db.commit()

    return {
        "total_input": len(input_frames),
        "processed": len(results),
        "errors": len(errors),
        "results": results,
        "error_details": errors,
        "last_annotated_image_base64": last_annotated_base64,
        "mode": resolved_mode,
    }

@router.get("/sessions/{session_id}/behavior-logs")
async def get_session_behavior_logs(
    session_id: UUID,
    actor_id: Optional[UUID] = None,
    behavior_class: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Fetch behavior logs for a session with optional filters.
    
    Query params:
    - actor_id: Filter by actor (student/teacher) UUID
    - behavior_class: Filter by behavior class name
    - limit: Max results (default 50, max 500)
    - offset: Pagination offset (default 0)
    """
    _ensure_session_permissions(
        current_user, 
        db, 
        {"dashboard:view_classroom", "dashboard:view_block", "dashboard:view_university", "report:performance"},
    )
    
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _ensure_room_scope(current_user, session.room_id, db)
    
    # Build query
    query = db.query(BehaviorLog).filter(BehaviorLog.session_id == session_id)
    
    if actor_id:
        query = query.filter(BehaviorLog.actor_id == actor_id)
    
    if behavior_class:
        query = query.filter(BehaviorLog.behavior_class == behavior_class)
    
    # Order by detected_at descending
    query = query.order_by(BehaviorLog.detected_at.desc())
    
    # Pagination
    limit = min(limit, 500)  # Cap at 500
    total = query.count()
    logs = query.offset(offset).limit(limit).all()
    
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "logs": [
            {
                "id": str(log.id),
                "session_id": str(log.session_id),
                "actor_id": str(log.actor_id) if log.actor_id else None,
                "actor_type": log.actor_type,
                "behavior_class": log.behavior_class,
                "count": log.count,
                "duration_seconds": log.duration_seconds,
                "yolo_confidence": log.yolo_confidence,
                "detected_at": log.detected_at,
                "frame_snapshot": _serialize_frame_snapshot(log.frame_snapshot),
            }
            for log in logs
        ]
    }

@router.post("/sessions/{session_id}/end")
async def end_session(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """End session and calculate final scores"""
    _ensure_session_role(current_user, {"INSTRUCTOR", "ACADEMIC_MANAGER"})
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
    db: Session = Depends(get_db)
):
    """Get all active sessions in a room (public for internal service access)."""
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

import uuid

@router.post("/sessions/{session_id}/upload-analyze", response_model=UploadAnalyzeResponse)
async def upload_and_analyze_image(
    session_id: UUID,
    file: UploadFile = File(...),
    mode: str = "LEARNING",
    confidence_threshold: float = 0.5,
    student_id: Optional[UUID] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Upload an image, run YOLO inference, and store the result in BehaviorLogs.
    Returns the annotated image and detections.
    """
    _ensure_session_permissions(current_user, db, {"camera:view_live", "camera:view_recorded"})
    
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    _ensure_room_scope(current_user, session.room_id, db)
    
    if not yolo_service.is_ready():
        raise HTTPException(status_code=503, detail="YOLO model not loaded")
        
    resolved_mode = mode.upper()
    if resolved_mode not in {"LEARNING", "TESTING"}:
        resolved_mode = "LEARNING"
        
    # Use provided student_id or fall back to UNKNOWN
    target_actor_id = student_id if student_id else UNKNOWN_STUDENT_ID
        
    try:
        image_bytes = await file.read()
        
        suffix = Path(file.filename).suffix.lower() if file.filename else ".jpg"
        if suffix not in {".jpg", ".jpeg", ".png"}:
            suffix = ".jpg"
            
        mime_type = "image/jpeg" if suffix in {".jpg", ".jpeg"} else "image/png"
        encoded = base64.b64encode(image_bytes).decode("utf-8")
        image_base64 = f"data:{mime_type};base64,{encoded}"
        
        frame_result = yolo_service.process_frame(
            image_base64,
            conf_threshold=confidence_threshold,
            student_id=str(target_actor_id),
            mode=resolved_mode,
            output_dir=None,
            source_filename=file.filename
        )
        
        annotated_base64 = frame_result.get("annotated_image_base64")
        if not annotated_base64:
            raise ValueError("No annotated image returned from YOLO service")
            
        if "," in annotated_base64:
            b64_data = annotated_base64.split(",")[1]
        else:
            b64_data = annotated_base64
            
        annotated_bytes = base64.b64decode(b64_data)
        
        detections = frame_result.get("detections", [])
        logs_created = 0
        
        for detection in detections:
            log = BehaviorLog(
                session_id=session_id,
                actor_id=target_actor_id,
                actor_type="STUDENT",
                behavior_class=detection["behavior_class"],
                count=1,
                duration_seconds=0,
                frame_snapshot=annotated_bytes,
                yolo_confidence=detection["confidence"],
                detected_at=datetime.utcnow()
            )
            db.add(log)
            logs_created += 1
            
        # Run risk analysis if in testing mode
        incidents_created = 0
        risk_summary = None
        
        if resolved_mode == "TESTING" and detections:
            risk_detector = RiskDetector(db)
            # We need to map student_id to detections if not already there
            # Since this is a single-student upload (usually), we attribute all detections to target_actor_id
            for det in detections:
                det["student_id"] = str(target_actor_id)
                
            risk_analysis = risk_detector.batch_analyze_behaviors(
                session_id=str(session_id),
                detected_behaviors=detections
            )
            
            risk_summary = risk_analysis.get(str(target_actor_id))
            if risk_summary and risk_summary["should_flag"] and target_actor_id != UNKNOWN_STUDENT_ID:
                risk_detector.create_risk_incident(
                    session_id=str(session_id),
                    student_id=str(target_actor_id),
                    room_id=str(session.room_id),
                    risk_score=risk_summary["risk_score"],
                    behavior_details=risk_summary["behaviors"],
                    image_with_detections=annotated_base64
                )
                incidents_created += 1
            
        if logs_created > 0 or incidents_created > 0:
            db.commit()
            
        return {
            "annotated_image_base64": annotated_base64,
            "detections": detections,
            "logs_created": logs_created,
            "incidents_created": incidents_created,
            "risk_summary": risk_summary
        }
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to process uploaded image: {str(e)}")

