from __future__ import annotations

from typing import Any
from uuid import uuid4

from sqlalchemy import Integer, JSON, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class SyncEvent(TimestampMixin, Base):
    __tablename__ = "sync_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    raw_capture: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)

    session = relationship("ChatSession", back_populates="sync_events")

