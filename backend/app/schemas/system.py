from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class SystemStatus(BaseModel):
    product: str
    version: str
    server_time: datetime
    markdown_root: str
    vault_root: str
    todo_list_path: str
    public_url: str | None = None
    auth_mode: str
    git_versioning_enabled: bool
    git_available: bool
    total_sessions: int
    total_messages: int
    total_triplets: int


class StorageSettingsUpdate(BaseModel):
    markdown_root: str = Field(min_length=1)


class StorageSettingsResponse(BaseModel):
    markdown_root: str
    vault_root: str
    todo_list_path: str
    persistence_kind: str
    persisted_to: str | None = None
    regenerated_session_count: int = 0
    git_initialized: bool = False
