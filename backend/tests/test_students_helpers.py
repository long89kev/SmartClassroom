from datetime import datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers.students import (
    _ensure_student_role,
    _get_current_student_or_404,
    _resolve_attendance_status,
)


class FakeQuery:
    def __init__(self, student):
        self._student = student

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self._student


class FakeDB:
    def __init__(self, student=None):
        self.student = student

    def query(self, _model):
        return FakeQuery(self.student)


def test_ensure_student_role_allows_student() -> None:
    _ensure_student_role(SimpleNamespace(role="STUDENT"))


def test_ensure_student_role_rejects_non_student() -> None:
    with pytest.raises(HTTPException) as exc:
        _ensure_student_role(SimpleNamespace(role="INSTRUCTOR"))

    assert exc.value.status_code == 403


def test_get_current_student_or_404_returns_linked_profile() -> None:
    current_user = SimpleNamespace(id=uuid4(), role="STUDENT")
    linked = SimpleNamespace(id=uuid4(), user_id=current_user.id)
    db = FakeDB(student=linked)

    result = _get_current_student_or_404(current_user, db)

    assert result is linked


def test_get_current_student_or_404_raises_when_missing_link() -> None:
    current_user = SimpleNamespace(id=uuid4(), role="STUDENT")
    db = FakeDB(student=None)

    with pytest.raises(HTTPException) as exc:
        _get_current_student_or_404(current_user, db)

    assert exc.value.status_code == 404
    assert "No student profile linked" in exc.value.detail


def test_resolve_attendance_status_absent_without_event() -> None:
    session = SimpleNamespace(start_time=datetime.utcnow())

    status = _resolve_attendance_status(session, config=None, first_event=None)

    assert status == "ABSENT"


def test_resolve_attendance_status_present_within_default_grace() -> None:
    start = datetime.utcnow()
    session = SimpleNamespace(start_time=start)
    first_event = SimpleNamespace(occurred_at=start + timedelta(minutes=5))

    status = _resolve_attendance_status(session, config=None, first_event=first_event)

    assert status == "PRESENT"


def test_resolve_attendance_status_late_beyond_custom_grace() -> None:
    start = datetime.utcnow()
    session = SimpleNamespace(start_time=start)
    config = SimpleNamespace(grace_minutes=3)
    first_event = SimpleNamespace(occurred_at=start + timedelta(minutes=8))

    status = _resolve_attendance_status(session, config=config, first_event=first_event)

    assert status == "LATE"
