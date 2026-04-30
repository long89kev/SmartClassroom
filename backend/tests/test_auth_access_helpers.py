import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers.auth import (
    check_mode_access,
    create_access_token,
    get_user_permissions,
    require_permission,
    require_role,
    hash_password,
    verify_password,
    verify_token,
)


class FakePermissionQuery:
    def __init__(self, permissions_by_role):
        self.permissions_by_role = permissions_by_role
        self.current_role = None

    def join(self, *_args, **_kwargs):
        return self

    def filter(self, expression):
        self.current_role = getattr(getattr(expression, "right", None), "value", None)
        return self

    def all(self):
        keys = self.permissions_by_role.get(self.current_role, [])
        return [SimpleNamespace(key=key) for key in keys]


class FakeModeAccessQuery:
    def __init__(self, mode_access_by_role):
        self.mode_access_by_role = mode_access_by_role
        self.current_role = None

    def filter(self, expression):
        self.current_role = getattr(getattr(expression, "right", None), "value", None)
        return self

    def first(self):
        return self.mode_access_by_role.get(self.current_role)


class FakeDB:
    def __init__(self, permissions_by_role=None, mode_access_by_role=None):
        self.permissions_by_role = permissions_by_role or {}
        self.mode_access_by_role = mode_access_by_role or {}

    def query(self, model):
        model_name = getattr(model, "__name__", None)
        column_name = getattr(model, "name", None)

        if model_name == "RoleModeAccess":
            return FakeModeAccessQuery(self.mode_access_by_role)

        if column_name == "key":
            return FakePermissionQuery(self.permissions_by_role)

        raise AssertionError(f"Unexpected query model: {model}")


def test_hash_and_verify_password_roundtrip() -> None:
    password = "admin123"
    hashed = hash_password(password)

    assert hashed != password
    assert verify_password(password, hashed) is True
    assert verify_password("wrong-pass", hashed) is False


def test_jwt_create_and_verify_token() -> None:
    user_id = uuid4()
    token = create_access_token(user_id=user_id, role="ACADEMIC_MANAGER", expire_delta=timedelta(minutes=2))

    payload = verify_token(token)

    assert payload["user_id"] == str(user_id)
    assert payload["role"] == "ACADEMIC_MANAGER"
    assert payload["exp"] >= int(datetime.utcnow().timestamp())


def test_verify_token_rejects_invalid_token() -> None:
    with pytest.raises(HTTPException) as exc:
        verify_token("not.a.valid.token")

    assert exc.value.status_code == 401
    assert "Invalid token" in exc.value.detail


def test_require_role_allows_matching_role() -> None:
    checker = require_role("ACADEMIC_MANAGER", "INSTRUCTOR")
    current_user = SimpleNamespace(role="INSTRUCTOR")

    result = asyncio.run(checker(current_user=current_user))

    assert result is current_user


def test_require_role_rejects_non_matching_role() -> None:
    checker = require_role("ACADEMIC_MANAGER")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(checker(current_user=SimpleNamespace(role="STUDENT")))

    assert exc.value.status_code == 403


def test_get_user_permissions_collects_role_permissions() -> None:
    db = FakeDB(permissions_by_role={"INSTRUCTOR": ["dashboard:view_classroom", "session:view"]})
    user = SimpleNamespace(role="INSTRUCTOR")

    permissions = get_user_permissions(user, db)

    assert permissions == {"dashboard:view_classroom", "session:view"}


def test_require_permission_accepts_when_any_permission_matches() -> None:
    db = FakeDB(permissions_by_role={"INSTRUCTOR": ["dashboard:view_classroom"]})
    checker = require_permission("dashboard:view_classroom", "dashboard:view_block")
    user = SimpleNamespace(role="INSTRUCTOR")

    result = asyncio.run(checker(current_user=user, db=db))

    assert result is user


def test_require_permission_denies_when_missing_permissions() -> None:
    db = FakeDB(permissions_by_role={"STUDENT": ["dashboard:view_student_self"]})
    checker = require_permission("dashboard:view_university")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(checker(current_user=SimpleNamespace(role="STUDENT"), db=db))

    assert exc.value.status_code == 403
    assert "Insufficient permissions" in exc.value.detail


def test_check_mode_access_system_admin_always_allowed() -> None:
    user = SimpleNamespace(role="ACADEMIC_MANAGER")

    assert check_mode_access(user, "TESTING", db=FakeDB()) is True
    assert check_mode_access(user, "LEARNING", db=FakeDB()) is True


def test_check_mode_access_denies_when_role_has_no_mapping() -> None:
    user = SimpleNamespace(role="STUDENT")

    assert check_mode_access(user, "TESTING", db=FakeDB()) is False


def test_check_mode_access_uses_role_mapping_flags() -> None:
    mapping = {
        "INSTRUCTOR": SimpleNamespace(can_switch_to_testing=True, can_switch_to_learning=False),
    }
    db = FakeDB(mode_access_by_role=mapping)
    user = SimpleNamespace(role="INSTRUCTOR")

    assert check_mode_access(user, "TESTING", db=db) is True
    assert check_mode_access(user, "LEARNING", db=db) is False
