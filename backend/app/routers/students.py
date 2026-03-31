from datetime import datetime, timedelta
from typing import Dict, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    AttendanceEvent,
    AttendanceSessionConfig,
    BehaviorLog,
    ClassSession,
    Enrollment,
    RiskIncident,
    Student,
    User,
)
from app.routers.auth import get_current_user
from app.schemas.common import (
    StudentAttendanceSummary,
    StudentBehaviorSummaryItem,
    StudentIncidentItem,
    StudentSessionCalendarItem,
    StudentSessionDetailResponse,
)

router = APIRouter(prefix="/api/students/me", tags=["Student Dashboard"])


def _ensure_student_role(current_user: User) -> None:
    if current_user.role != "STUDENT":
        raise HTTPException(status_code=403, detail="Only STUDENT role can access this endpoint")


def _get_current_student_or_404(current_user: User, db: Session) -> Student:
    _ensure_student_role(current_user)
    student = db.query(Student).filter(Student.user_id == current_user.id).first()
    if not student:
        raise HTTPException(status_code=404, detail="No student profile linked to this user")
    return student


def _resolve_attendance_status(
    session: ClassSession,
    config: AttendanceSessionConfig | None,
    first_event: AttendanceEvent | None,
) -> str:
    if first_event is None:
        return "ABSENT"

    grace_minutes = config.grace_minutes if config else 10
    cutoff = session.start_time + timedelta(minutes=grace_minutes)
    return "PRESENT" if first_event.occurred_at <= cutoff else "LATE"


def _get_session_ids_and_map(sessions: List[ClassSession]) -> tuple[list[UUID], Dict[UUID, ClassSession]]:
    session_map = {session.id: session for session in sessions}
    return list(session_map.keys()), session_map


def _get_config_map(db: Session, session_ids: List[UUID]) -> Dict[UUID, AttendanceSessionConfig]:
    if not session_ids:
        return {}
    rows = (
        db.query(AttendanceSessionConfig)
        .filter(AttendanceSessionConfig.session_id.in_(session_ids))
        .all()
    )
    return {row.session_id: row for row in rows}


def _get_first_recognized_event_map(
    db: Session,
    student_id: UUID,
    session_ids: List[UUID],
) -> Dict[UUID, AttendanceEvent]:
    if not session_ids:
        return {}

    events = (
        db.query(AttendanceEvent)
        .filter(
            AttendanceEvent.student_id == student_id,
            AttendanceEvent.session_id.in_(session_ids),
            AttendanceEvent.is_recognized.is_(True),
        )
        .order_by(AttendanceEvent.occurred_at.asc())
        .all()
    )

    first_map: Dict[UUID, AttendanceEvent] = {}
    for event in events:
        if event.session_id not in first_map:
            first_map[event.session_id] = event
    return first_map


@router.get("/sessions", response_model=List[StudentSessionCalendarItem])
async def get_my_sessions(
    week_start: datetime | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    student = _get_current_student_or_404(current_user, db)

    if week_start is None:
        now = datetime.utcnow()
        week_start = datetime(now.year, now.month, now.day) - timedelta(days=now.weekday())
    week_end = week_start + timedelta(days=7)

    sessions = (
        db.query(ClassSession)
        .join(Enrollment, Enrollment.subject_id == ClassSession.subject_id)
        .filter(
            Enrollment.student_id == student.id,
            ClassSession.start_time >= week_start,
            ClassSession.start_time < week_end,
        )
        .order_by(ClassSession.start_time.asc())
        .all()
    )

    session_ids, _ = _get_session_ids_and_map(sessions)
    config_map = _get_config_map(db, session_ids)
    first_event_map = _get_first_recognized_event_map(db, student.id, session_ids)

    items: List[StudentSessionCalendarItem] = []
    for session in sessions:
        config = config_map.get(session.id)
        first_event = first_event_map.get(session.id)
        items.append(
            StudentSessionCalendarItem(
                session_id=session.id,
                subject_id=session.subject_id,
                subject_name=session.subject.name if session.subject else None,
                subject_code=session.subject.code if session.subject else None,
                room_id=session.room_id,
                room_code=session.room.room_code if session.room else None,
                teacher_id=session.teacher_id,
                teacher_name=session.teacher.name if session.teacher else None,
                status=session.status,
                mode=session.mode,
                start_time=session.start_time,
                end_time=session.end_time,
                attendance_status=_resolve_attendance_status(session, config, first_event),
            )
        )

    return items


@router.get("/attendance/summary", response_model=StudentAttendanceSummary)
async def get_my_attendance_summary(
    days: int = Query(default=30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    student = _get_current_student_or_404(current_user, db)

    start_dt = datetime.utcnow() - timedelta(days=days)
    sessions = (
        db.query(ClassSession)
        .join(Enrollment, Enrollment.subject_id == ClassSession.subject_id)
        .filter(Enrollment.student_id == student.id, ClassSession.start_time >= start_dt)
        .all()
    )

    session_ids, _ = _get_session_ids_and_map(sessions)
    config_map = _get_config_map(db, session_ids)
    first_event_map = _get_first_recognized_event_map(db, student.id, session_ids)

    present = 0
    late = 0
    absent = 0

    for session in sessions:
        status = _resolve_attendance_status(session, config_map.get(session.id), first_event_map.get(session.id))
        if status == "PRESENT":
            present += 1
        elif status == "LATE":
            late += 1
        else:
            absent += 1

    return StudentAttendanceSummary(
        present=present,
        late=late,
        absent=absent,
        total_sessions=len(sessions),
    )


@router.get("/sessions/{session_id}", response_model=StudentSessionDetailResponse)
async def get_my_session_detail(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    student = _get_current_student_or_404(current_user, db)

    session = (
        db.query(ClassSession)
        .join(Enrollment, Enrollment.subject_id == ClassSession.subject_id)
        .filter(ClassSession.id == session_id, Enrollment.student_id == student.id)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found for current student")

    config = db.query(AttendanceSessionConfig).filter(AttendanceSessionConfig.session_id == session.id).first()
    first_event = (
        db.query(AttendanceEvent)
        .filter(
            AttendanceEvent.session_id == session.id,
            AttendanceEvent.student_id == student.id,
            AttendanceEvent.is_recognized.is_(True),
        )
        .order_by(AttendanceEvent.occurred_at.asc())
        .first()
    )

    behavior_rows = (
        db.query(
            BehaviorLog.behavior_class,
            func.sum(BehaviorLog.count).label("total_count"),
            func.sum(BehaviorLog.duration_seconds).label("total_duration"),
            func.avg(BehaviorLog.yolo_confidence).label("avg_conf"),
        )
        .filter(
            BehaviorLog.session_id == session.id,
            BehaviorLog.actor_id == student.id,
            BehaviorLog.actor_type == "STUDENT",
        )
        .group_by(BehaviorLog.behavior_class)
        .order_by(BehaviorLog.behavior_class.asc())
        .all()
    )

    incidents = (
        db.query(RiskIncident)
        .filter(
            and_(
                RiskIncident.session_id == session.id,
                RiskIncident.student_id == student.id,
            )
        )
        .order_by(RiskIncident.flagged_at.desc())
        .all()
    )

    behavior_summary = [
        StudentBehaviorSummaryItem(
            behavior_class=row.behavior_class,
            count=int(row.total_count or 0),
            duration_seconds=int(row.total_duration or 0),
            avg_confidence=float(row.avg_conf or 0.0),
        )
        for row in behavior_rows
    ]

    incident_items = [
        StudentIncidentItem(
            id=incident.id,
            risk_score=incident.risk_score,
            risk_level=incident.risk_level,
            triggered_behaviors=incident.triggered_behaviors or {},
            flagged_at=incident.flagged_at,
            reviewed=incident.reviewed,
            reviewer_notes=incident.reviewer_notes,
        )
        for incident in incidents
    ]

    return StudentSessionDetailResponse(
        session_id=session.id,
        subject_name=session.subject.name if session.subject else None,
        room_code=session.room.room_code if session.room else None,
        teacher_name=session.teacher.name if session.teacher else None,
        start_time=session.start_time,
        end_time=session.end_time,
        attendance_status=_resolve_attendance_status(session, config, first_event),
        first_seen_at=first_event.occurred_at if first_event else None,
        confidence=first_event.face_confidence if first_event else None,
        grace_minutes=config.grace_minutes if config else 10,
        behavior_summary=behavior_summary,
        incidents=incident_items,
    )
