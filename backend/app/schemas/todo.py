from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class TodoListItem(BaseModel):
    text: str
    done: bool = False
    account_key: str | None = None
    account_label: str | None = None


class TodoGitStatus(BaseModel):
    versioning_enabled: bool
    available: bool
    repository_ready: bool
    branch: str | None = None
    clean: bool | None = None
    last_commit_short: str | None = None
    last_commit_message: str | None = None
    last_commit_at: datetime | None = None


class TodoListRead(BaseModel):
    title: str
    content: str
    revision: str
    items: list[TodoListItem]
    active_count: int
    completed_count: int
    total_count: int
    git: TodoGitStatus


class TodoListUpdate(BaseModel):
    items: list[TodoListItem]
    summary: str | None = None
    expected_revision: str = Field(min_length=1, max_length=128)
