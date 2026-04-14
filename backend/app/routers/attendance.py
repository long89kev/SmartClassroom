from datetime import datetime, timedelta, date, time
from io import StringIO
import csv
from typing import Dict, List, Tuple
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    AttendanceEvent,
    AttendanceFaceTemplate,
    AttendanceSessionConfig,
    ClassSession,
    Enrollment,
    Student,
    User,
)
from app.routers.auth import get_current_user, get_user_room_scope
from app.schemas.common import (
    AttendanceConfigUpsert,
    AttendanceDailyRoomSummary,
    AttendanceEventIngest,
    AttendanceMockEventIngest,
    AttendanceSessionReport,
    AttendanceStudentHistoryEntry,
    AttendanceStudentStatus,
)

router = APIRouter(prefix="/api/attendance", tags=["Attendance"])


def _ensure_attendance_role(current_user: User) -> None:
    if current_user.role not in {"LECTURER", "SYSTEM_ADMIN"}:
        raise HTTPException(status_code=403, detail="Only LECTURER or SYSTEM_ADMIN can access attendance APIs")


def _ensure_attendance_scope(current_user: User, room_id: UUID, db: Session) -> None:
    if current_user.role == "SYSTEM_ADMIN":
        return

    allowed_rooms = set(get_user_room_scope(current_user, db))
    if room_id not in allowed_rooms:
        raise HTTPException(status_code=403, detail="User not assigned to this room")


def _get_session_or_404(db: Session, session_id: UUID) -> ClassSession:
    session = db.query(ClassSession).filter(ClassSession.id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def _get_or_create_attendance_config(db: Session, session_id: UUID) -> AttendanceSessionConfig:
    config = db.query(AttendanceSessionConfig).filter(AttendanceSessionConfig.session_id == session_id).first()
    if config:
        return config

    config = AttendanceSessionConfig(session_id=session_id)
    db.add(config)
    db.commit()
    db.refresh(config)
    return config


def _get_enrolled_students(db: Session, subject_id: UUID) -> List[Student]:
    return (
        db.query(Student)
        .join(Enrollment, Enrollment.student_id == Student.id)
        .filter(Enrollment.subject_id == subject_id)
        .all()
    )


def _get_first_recognized_event_map(
    db: Session,
    session_id: UUID,
    min_confidence: float,
) -> Dict[UUID, AttendanceEvent]:
    events = (
        db.query(AttendanceEvent)
        .filter(
            AttendanceEvent.session_id == session_id,
            AttendanceEvent.is_recognized.is_(True),
            AttendanceEvent.face_confidence >= min_confidence,
        )
        .order_by(AttendanceEvent.occurred_at.asc())
        .all()
    )

    first_seen: Dict[UUID, AttendanceEvent] = {}
    for event in events:
        if event.student_id not in first_seen:
            first_seen[event.student_id] = event
    return first_seen


def _derive_student_statuses(
    session: ClassSession,
    config: AttendanceSessionConfig,
    enrolled_students: List[Student],
    first_seen_map: Dict[UUID, AttendanceEvent],
) -> Tuple[List[AttendanceStudentStatus], Dict[str, int]]:
    cutoff = session.start_time + timedelta(minutes=config.grace_minutes)
    items: List[AttendanceStudentStatus] = []
    totals = {"present": 0, "late": 0, "absent": 0, "enrolled": len(enrolled_students)}

    for student in enrolled_students:
        first_event = first_seen_map.get(student.id)

        if first_event is None:
            status = "ABSENT"
            totals["absent"] += 1
        elif first_event.occurred_at <= cutoff:
            status = "PRESENT"
            totals["present"] += 1
        else:
            status = "LATE"
            totals["late"] += 1

        items.append(
            AttendanceStudentStatus(
                student_id=student.id,
                student_code=student.student_id,
                student_name=student.name,
                status=status,
                first_seen_at=first_event.occurred_at if first_event else None,
                confidence=first_event.face_confidence if first_event else None,
            )
        )

    return items, totals


@router.put("/sessions/{session_id}/config", response_model=AttendanceConfigUpsert)
async def upsert_session_attendance_config(
    session_id: UUID,
    payload: AttendanceConfigUpsert,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_attendance_role(current_user)

    session = _get_session_or_404(db, session_id)
    _ensure_attendance_scope(current_user, session.room_id, db)

    config = _get_or_create_attendance_config(db, session_id)
    config.grace_minutes = payload.grace_minutes
    config.min_confidence = payload.min_confidence
    config.auto_checkin_enabled = payload.auto_checkin_enabled

    db.commit()

    return AttendanceConfigUpsert(
        grace_minutes=config.grace_minutes,
        min_confidence=config.min_confidence,
        auto_checkin_enabled=config.auto_checkin_enabled,
    )


@router.post("/sessions/{session_id}/events/mock")
async def ingest_mock_attendance_event(
    session_id: UUID,
    payload: AttendanceMockEventIngest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_attendance_role(current_user)

    session = _get_session_or_404(db, session_id)
    _ensure_attendance_scope(current_user, session.room_id, db)

    if session.subject_id is None:
        raise HTTPException(status_code=400, detail="Session subject is required for attendance")

    enrollment_exists = (
        db.query(Enrollment)
        .filter(Enrollment.subject_id == session.subject_id, Enrollment.student_id == payload.student_id)
        .first()
    )
    if not enrollment_exists:
        raise HTTPException(status_code=400, detail="Student is not enrolled in this session subject")

    config = _get_or_create_attendance_config(db, session_id)
    is_recognized = config.auto_checkin_enabled and payload.face_confidence >= config.min_confidence

    event = AttendanceEvent(
        session_id=session_id,
        student_id=payload.student_id,
        source=payload.source,
        face_confidence=payload.face_confidence,
        is_recognized=is_recognized,
        occurred_at=payload.occurred_at or datetime.utcnow(),
        event_metadata=payload.metadata,
        created_by_user_id=current_user.id,
    )

    db.add(event)
    db.commit()
    db.refresh(event)

    return {
        "event_id": event.id,
        "session_id": session_id,
        "student_id": payload.student_id,
        "recognized": event.is_recognized,
        "grace_minutes": config.grace_minutes,
        "min_confidence": config.min_confidence,
    }


@router.post("/sessions/{session_id}/events/ingest")
async def ingest_attendance_event(
    session_id: UUID,
    payload: AttendanceEventIngest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Real attendance event ingest endpoint.
    Called by the PC attendance service (USB webcam face recognition).
    Accepts LECTURER, SYSTEM_ADMIN, or EXAM_PROCTOR roles.
    """
    if current_user.role not in {"LECTURER", "SYSTEM_ADMIN", "EXAM_PROCTOR"}:
        raise HTTPException(status_code=403, detail="Insufficient role for attendance ingest")

    session = _get_session_or_404(db, session_id)

    if session.subject_id is None:
        raise HTTPException(status_code=400, detail="Session subject is required for attendance")

    # Resolve student by student_id
    student = db.query(Student).filter(Student.id == payload.student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    # Verify enrollment
    enrollment_exists = (
        db.query(Enrollment)
        .filter(Enrollment.subject_id == session.subject_id, Enrollment.student_id == payload.student_id)
        .first()
    )
    if not enrollment_exists:
        raise HTTPException(status_code=400, detail="Student is not enrolled in this session subject")

    config = _get_or_create_attendance_config(db, session_id)
    is_recognized = config.auto_checkin_enabled and payload.face_confidence >= config.min_confidence

    event = AttendanceEvent(
        session_id=session_id,
        student_id=payload.student_id,
        source=payload.source or "USB_WEBCAM",
        face_confidence=payload.face_confidence,
        is_recognized=is_recognized,
        occurred_at=payload.occurred_at or datetime.utcnow(),
        event_metadata=payload.metadata or {},
        created_by_user_id=current_user.id,
    )

    db.add(event)
    db.commit()
    db.refresh(event)

    # Derive current status for this student
    cutoff = session.start_time + timedelta(minutes=config.grace_minutes)
    if event.occurred_at <= cutoff:
        status = "PRESENT"
    else:
        status = "LATE"

    return {
        "event_id": str(event.id),
        "session_id": str(session_id),
        "student_id": str(payload.student_id),
        "student_code": student.student_id,
        "student_name": student.name,
        "recognized": event.is_recognized,
        "status": status,
        "grace_minutes": config.grace_minutes,
        "min_confidence": config.min_confidence,
    }


@router.get("/face-templates/students")
async def list_face_template_students(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    List all students that have active face templates.
    Used by the attendance service to build student_code -> student_id mapping.
    """
    _ensure_attendance_role(current_user)

    students_with_templates = (
        db.query(Student)
        .join(AttendanceFaceTemplate, AttendanceFaceTemplate.student_id == Student.id)
        .filter(AttendanceFaceTemplate.is_active.is_(True))
        .distinct()
        .all()
    )

    # Also include all students even without templates (for the PC service mapping)
    all_students = db.query(Student).all()

    return [
        {
            "student_id": str(s.id),
            "student_code": s.student_id,
            "name": s.name,
            "has_template": any(t.student_id == s.id for t in students_with_templates) if students_with_templates else False,
        }
        for s in all_students
    ]


@router.get("/sessions/{session_id}", response_model=AttendanceSessionReport)
async def get_session_attendance_report(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_attendance_role(current_user)

    session = _get_session_or_404(db, session_id)
    _ensure_attendance_scope(current_user, session.room_id, db)

    if session.subject_id is None:
        raise HTTPException(status_code=400, detail="Session subject is required for attendance")

    config = _get_or_create_attendance_config(db, session_id)
    enrolled_students = _get_enrolled_students(db, session.subject_id)
    first_seen_map = _get_first_recognized_event_map(db, session_id, config.min_confidence)

    statuses, totals = _derive_student_statuses(session, config, enrolled_students, first_seen_map)

    return AttendanceSessionReport(
        session_id=session.id,
        room_id=session.room_id,
        room_code=session.room.room_code if session.room else None,
        start_time=session.start_time,
        end_time=session.end_time,
        grace_minutes=config.grace_minutes,
        min_confidence=config.min_confidence,
        totals=totals,
        students=statuses,
    )


@router.get("/sessions/{session_id}/export")
async def export_session_attendance_csv(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    report = await get_session_attendance_report(session_id=session_id, current_user=current_user, db=db)

    csv_buffer = StringIO()
    writer = csv.writer(csv_buffer)
    writer.writerow(["student_id", "student_code", "student_name", "status", "first_seen_at", "confidence"])
    for item in report.students:
        writer.writerow(
            [
                str(item.student_id),
                item.student_code,
                item.student_name,
                item.status,
                item.first_seen_at.isoformat() if item.first_seen_at else "",
                item.confidence if item.confidence is not None else "",
            ]
        )

    filename = f"attendance-session-{session_id}.csv"
    return Response(
        content=csv_buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/students/{student_id}/history", response_model=List[AttendanceStudentHistoryEntry])
async def get_student_attendance_history(
    student_id: UUID,
    limit: int = Query(default=30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_attendance_role(current_user)

    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    sessions = (
        db.query(ClassSession)
        .join(Enrollment, Enrollment.subject_id == ClassSession.subject_id)
        .filter(Enrollment.student_id == student_id)
        .order_by(ClassSession.start_time.desc())
        .limit(limit)
        .all()
    )

    results: List[AttendanceStudentHistoryEntry] = []
    for session in sessions:
        _ensure_attendance_scope(current_user, session.room_id, db)
        config = _get_or_create_attendance_config(db, session.id)
        first_seen = (
            db.query(AttendanceEvent)
            .filter(
                AttendanceEvent.session_id == session.id,
                AttendanceEvent.student_id == student_id,
                AttendanceEvent.is_recognized.is_(True),
                AttendanceEvent.face_confidence >= config.min_confidence,
            )
            .order_by(AttendanceEvent.occurred_at.asc())
            .first()
        )

        cutoff = session.start_time + timedelta(minutes=config.grace_minutes)
        if first_seen is None:
            status = "ABSENT"
        elif first_seen.occurred_at <= cutoff:
            status = "PRESENT"
        else:
            status = "LATE"

        results.append(
            AttendanceStudentHistoryEntry(
                session_id=session.id,
                subject_id=session.subject_id,
                room_id=session.room_id,
                start_time=session.start_time,
                end_time=session.end_time,
                status=status,
                first_seen_at=first_seen.occurred_at if first_seen else None,
            )
        )

    return results


@router.get("/rooms/{room_id}/daily-summary", response_model=AttendanceDailyRoomSummary)
async def get_room_daily_attendance_summary(
    room_id: UUID,
    day: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _ensure_attendance_role(current_user)
    _ensure_attendance_scope(current_user, room_id, db)

    day = day or date.today()

    start_dt = datetime.combine(day, time.min)
    end_dt = datetime.combine(day, time.max)

    sessions = (
        db.query(ClassSession)
        .filter(
            ClassSession.room_id == room_id,
            ClassSession.start_time >= start_dt,
            ClassSession.start_time <= end_dt,
        )
        .all()
    )

    totals = {"present": 0, "late": 0, "absent": 0, "enrolled": 0}

    for session in sessions:
        if session.subject_id is None:
            continue
        config = _get_or_create_attendance_config(db, session.id)
        enrolled_students = _get_enrolled_students(db, session.subject_id)
        first_seen_map = _get_first_recognized_event_map(db, session.id, config.min_confidence)
        _, session_totals = _derive_student_statuses(session, config, enrolled_students, first_seen_map)

        totals["present"] += session_totals["present"]
        totals["late"] += session_totals["late"]
        totals["absent"] += session_totals["absent"]
        totals["enrolled"] += session_totals["enrolled"]

    return AttendanceDailyRoomSummary(
        room_id=room_id,
        date=day,
        sessions_count=len(sessions),
        totals=totals,
    )
