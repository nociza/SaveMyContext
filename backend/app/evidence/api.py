from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.core.config import get_settings
from app.db.session import get_db_session
from app.evidence.worker import PENDING_SQL, QUARANTINE_SQL

router = APIRouter()


@router.get("/evidence/status")
async def evidence_status(_: AuthContext = Depends(require_scope("read")),
                          db: AsyncSession = Depends(get_db_session)):
    settings = get_settings()
    if db.bind.dialect.name != "sqlite":
        return {"configured": False, "supported": False, "reason": "requires_local_sqlite"}
    pending = await db.scalar(text("SELECT " + PENDING_SQL + " + " + QUARANTINE_SQL))
    objects = await db.scalar(text("SELECT count(*) FROM evidence_objects"))
    latest = await db.scalar(text("SELECT max(created_at) FROM evidence_objects"))
    return {"configured": bool(settings.evidence_config),
            "worker_enabled": bool(settings.evidence_config and settings.evidence_worker),
            "pending_bytes": pending, "queue_limit_bytes": settings.evidence_queue_bytes,
            "catalog_objects": objects, "last_catalog_write": latest,
            "remote_availability": "not_probed"}
