import asyncio

import pytest
from fastapi import HTTPException

from app.models import User
from app.routers.auth import init_admin


class FakeQuery:
    def __init__(self, count_value: int):
        self._count_value = count_value

    def count(self) -> int:
        return self._count_value


class FakeDB:
    def __init__(self, user_count: int):
        self.user_count = user_count
        self.added_user = None
        self.commit_called = False
        self.refresh_called = False

    def query(self, model):
        if model is User:
            return FakeQuery(self.user_count)
        raise AssertionError(f"Unexpected query model: {model}")

    def add(self, user: User) -> None:
        self.added_user = user

    def commit(self) -> None:
        self.commit_called = True

    def refresh(self, user: User) -> None:
        self.refresh_called = True


def test_init_admin_creates_system_admin_role() -> None:
    db = FakeDB(user_count=0)

    result = asyncio.run(init_admin(username="admin", password="admin123", db=db))

    assert db.added_user is not None
    assert db.added_user.role == "ACADEMIC_MANAGER"
    assert db.added_user.username == "admin"
    assert db.added_user.is_active is True
    assert db.commit_called is True
    assert db.refresh_called is True

    assert result["role"] == "ACADEMIC_MANAGER"
    assert result["username"] == "admin"


def test_init_admin_is_blocked_when_users_exist() -> None:
    db = FakeDB(user_count=1)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(init_admin(username="admin", password="admin123", db=db))

    assert exc.value.status_code == 400
    assert "Users already exist" in exc.value.detail
