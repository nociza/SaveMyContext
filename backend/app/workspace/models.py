from __future__ import annotations

from uuid import uuid4

from sqlalchemy import (
    Boolean,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.workspace.processor import PROCESSOR_VERSION


def uid() -> str:
    return str(uuid4())


class Source(TimestampMixin, Base):
    __tablename__ = "workspace_sources"
    id: Mapped[str] = mapped_column(String(180), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    provider: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    revision: Mapped[str] = mapped_column(String(64))
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("workspace_projects.id"))


class Revision(TimestampMixin, Base):
    __tablename__ = "workspace_revisions"
    __table_args__ = (UniqueConstraint("source_id", "digest"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    source_id: Mapped[str] = mapped_column(
        ForeignKey("workspace_sources.id"), index=True
    )
    digest: Mapped[str] = mapped_column(String(64))
    body: Mapped[str] = mapped_column(Text)
    messages: Mapped[list] = mapped_column(JSON, default=list)


class Project(TimestampMixin, Base):
    __tablename__ = "workspace_projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)


class ProviderProject(TimestampMixin, Base):
    """Private upstream context, not an executable instruction or inferred memory."""

    __tablename__ = "workspace_provider_projects"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("workspace_projects.id"), unique=True)
    provider: Mapped[str] = mapped_column(String(40))
    account_key: Mapped[str] = mapped_column(String(255))
    external_id: Mapped[str] = mapped_column(String(120))
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    observed_at: Mapped[float] = mapped_column(default=0.0)


class SourceProjectBinding(Base):
    __tablename__ = "workspace_source_project_bindings"
    source_id: Mapped[str] = mapped_column(ForeignKey("workspace_sources.id"), primary_key=True)
    provider_project_id: Mapped[str | None] = mapped_column(ForeignKey("workspace_provider_projects.id"))
    observed_at: Mapped[float] = mapped_column(default=0.0)
    manual: Mapped[bool] = mapped_column(Boolean, default=False)


class Memory(TimestampMixin, Base):
    __tablename__ = "workspace_memories"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspace_sources.id"), index=True
    )
    source_revision: Mapped[str | None] = mapped_column(String(64))
    project_id: Mapped[str | None] = mapped_column(ForeignKey("workspace_projects.id"))
    kind: Mapped[str] = mapped_column(String(24), index=True)
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    evidence: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(24), default="suggested", index=True)
    provenance: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)


class Task(TimestampMixin, Base):
    __tablename__ = "workspace_tasks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    list_name: Mapped[str] = mapped_column(String(120), default="Inbox")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    due_on: Mapped[str | None] = mapped_column(String(10), index=True)
    remind_at: Mapped[str | None] = mapped_column(String(40))
    notify: Mapped[bool] = mapped_column(Boolean, default=False)
    completed_at: Mapped[str | None] = mapped_column(String(40))
    project_id: Mapped[str | None] = mapped_column(ForeignKey("workspace_projects.id"))
    memory_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspace_memories.id"), unique=True
    )
    version: Mapped[int] = mapped_column(Integer, default=1)


class Event(TimestampMixin, Base):
    __tablename__ = "workspace_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    object_id: Mapped[str] = mapped_column(String(180), index=True)
    action: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(120))
    payload: Mapped[dict] = mapped_column(JSON)


class Command(Base):
    __tablename__ = "workspace_commands"
    key: Mapped[str] = mapped_column(String(160), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)


class Preference(Base):
    __tablename__ = "workspace_preferences"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class KnowledgeProjection(TimestampMixin, Base):
    """Acknowledged, rebuildable Basic Memory projection; never a second ledger."""

    __tablename__ = "workspace_knowledge_projections"
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    permalink: Mapped[str] = mapped_column(String(120), unique=True)


class CaptureQuarantine(TimestampMixin, Base):
    """Durable evidence rejected by capture validation; excluded from inference."""

    __tablename__ = "workspace_capture_quarantine"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(40))
    external_session_id: Mapped[str] = mapped_column(String(255))
    quality: Mapped[dict] = mapped_column(JSON)
    payload: Mapped[dict] = mapped_column(JSON)


class Job(TimestampMixin, Base):
    __tablename__ = "workspace_jobs"
    __table_args__ = (UniqueConstraint("source_id", "revision", "processor"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    source_id: Mapped[str] = mapped_column(
        ForeignKey("workspace_sources.id"), index=True
    )
    revision: Mapped[str] = mapped_column(String(64))
    processor: Mapped[str] = mapped_column(String(48), default=PROCESSOR_VERSION)
    state: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease: Mapped[str | None] = mapped_column(String(36))
    available_at: Mapped[float] = mapped_column(default=0.0, index=True)
    error: Mapped[str | None] = mapped_column(String(120))
