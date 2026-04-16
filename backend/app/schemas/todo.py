from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class TodoListItem(BaseModel):
    text: str
    done: bool = False


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
    items: list[TodoListItem]
    active_count: int
    completed_count: int
    total_count: int
    git: TodoGitStatus


class TodoListUpdate(BaseModel):
    items: list[TodoListItem]
    summary: str | None = None
