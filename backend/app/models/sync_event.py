from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import uuid4

from sqlalchemy import Index, Integer, JSON, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


def raw_capture_hash(raw_capture: dict[str, Any] | list[Any] | None) -> str | None:
    if raw_capture is None:
        return None
    canonical = json.dumps(
        raw_capture,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class SyncEvent(TimestampMixin, Base):
    __tablename__ = "sync_events"
    __table_args__ = (
        Index(
            "uq_sync_events_session_capture_hash",
            "session_id",
            "capture_hash",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    raw_capture: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)
    capture_hash: Mapped[str | None] = mapped_column(String(64))

    session = relationship("ChatSession", back_populates="sync_events")
