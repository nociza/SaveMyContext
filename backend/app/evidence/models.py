from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class EvidenceObject(TimestampMixin, Base):
    __tablename__ = "evidence_objects"

    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    pack_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    plaintext_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
