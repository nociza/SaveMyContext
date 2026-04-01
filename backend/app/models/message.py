from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import DateTime, Integer, JSON, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import MessageRole


class ChatMessage(TimestampMixin, Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "external_message_id",
            name="uq_chat_message_session_external_id",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_sessions.id", ondelete="CASCADE"))
    external_message_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    parent_external_message_id: Mapped[str | None] = mapped_column(String(255), index=True)
    role: Mapped[MessageRole] = mapped_column(
        SAEnum(MessageRole, native_enum=False),
        nullable=False,
        default=MessageRole.UNKNOWN,
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sequence_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    raw_payload: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)

    session = relationship("ChatSession", back_populates="messages")

