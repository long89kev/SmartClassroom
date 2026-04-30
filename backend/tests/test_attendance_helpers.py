from datetime import datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers.attendance import (
    _derive_student_statuses,
    _ensure_attendance_role,
)


def test_ensure_attendance_role_allows_lecturer_and_admin() -> None:
    _ensure_attendance_role(SimpleNamespace(role="INSTRUCTOR"))
    _ensure_attendance_role(SimpleNamespace(role="ACADEMIC_MANAGER"))


def test_ensure_attendance_role_rejects_other_roles() -> None:
    with pytest.raises(HTTPException) as exc:
        _ensure_attendance_role(SimpleNamespace(role="STUDENT"))

    assert exc.value.status_code == 403
    assert "Only INSTRUCTOR or ACADEMIC_MANAGER" in exc.value.detail


def test_derive_student_statuses_present_late_absent_counts() -> None:
    now = datetime.utcnow()
    session = SimpleNamespace(start_time=now)
    config = SimpleNamespace(grace_minutes=10)

    present_student_id = uuid4()
    late_student_id = uuid4()
    absent_student_id = uuid4()

    enrolled_students = [
        SimpleNamespace(id=present_student_id, student_id="S001", name="Present Student"),
        SimpleNamespace(id=late_student_id, student_id="S002", name="Late Student"),
        SimpleNamespace(id=absent_student_id, student_id="S003", name="Absent Student"),
    ]

    first_seen_map = {
        present_student_id: SimpleNamespace(occurred_at=now + timedelta(minutes=2), face_confidence=0.95),
        late_student_id: SimpleNamespace(occurred_at=now + timedelta(minutes=15), face_confidence=0.91),
    }

    items, totals = _derive_student_statuses(session, config, enrolled_students, first_seen_map)

    assert totals == {"present": 1, "late": 1, "absent": 1, "enrolled": 3}

    by_code = {item.student_code: item for item in items}
    assert by_code["S001"].status == "PRESENT"
    assert by_code["S002"].status == "LATE"
    assert by_code["S003"].status == "ABSENT"
    assert by_code["S003"].first_seen_at is None
    assert by_code["S003"].confidence is None
