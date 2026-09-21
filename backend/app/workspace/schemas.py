from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class TaskInput(Input):
    title: str = Field(min_length=1, max_length=240)
    notes: str | None = Field(default=None, max_length=4000)
    list_name: str = Field(default="Inbox", min_length=1, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=12)
    priority: Literal["low", "normal", "high", "urgent"] = "normal"
    status: Literal["open", "done", "archived"] = "open"
    due_on: str | None = None
    remind_at: str | None = None
    notify: bool = False
    project_id: str | None = None

    @field_validator("due_on")
    @classmethod
    def valid_date(cls, value):
        if not value:
            return None
        if len(value) != 10 or date.fromisoformat(value).isoformat() != value:
            raise ValueError("due_on must be YYYY-MM-DD")
        return value

    @field_validator("remind_at")
    @classmethod
    def valid_instant(cls, value):
        if not value:
            return None
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("remind_at requires an explicit timezone")
        return parsed.isoformat()

    @field_validator("tags")
    @classmethod
    def valid_tags(cls, values):
        if any(not value.strip() or len(value) > 40 for value in values):
            raise ValueError("tags must contain 1–40 characters")
        return list(dict.fromkeys(value.strip().lower() for value in values))


class TaskPatch(Input):
    title: str | None = None
    notes: str | None = None
    list_name: str | None = None
    tags: list[str] | None = None
    priority: str | None = None
    status: str | None = None
    due_on: str | None = None
    remind_at: str | None = None
    notify: bool | None = None
    project_id: str | None = None
    expected_version: int | None = Field(default=None, ge=1)


class CaptureInput(Input):
    key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=500_000)
    project_id: str | None = None
    # Interface provenance is informational; never used to authorize actions.
    interface: Literal["web", "openclaw", "cli", "import"] = "web"


class MemoryPatch(Input):
    status: Literal["accepted", "rejected", "suggested"] | None = None
    title: str | None = Field(default=None, min_length=1, max_length=240)
    body: str | None = Field(default=None, min_length=1, max_length=50_000)
    project_id: str | None = None
    expected_version: int = Field(ge=1)


class ProjectInput(Input):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=4000)


class SourcePatch(Input):
    expected_revision: str = Field(min_length=64, max_length=64)
    project_id: str | None = None
    archived: bool | None = None


class SettingsInput(Input):
    notifications_enabled: bool = False
    due_reminders_enabled: bool = True
    daily_digest_enabled: bool = False
    digest_time: str = Field(default="09:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    timezone: str = "America/Los_Angeles"

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("Unknown timezone") from exc
        return value
