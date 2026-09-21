from __future__ import annotations

import os

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.version import get_app_version
from app.db.session import get_db_session


router = APIRouter()


@router.get("/health")
async def healthcheck() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": get_app_version(),
        "llm_backend": settings.llm_backend,
    }


@router.get("/ready")
async def readiness(db: AsyncSession = Depends(get_db_session)):
    settings = get_settings()
    try:
        await db.execute(text("SELECT 1"))
        vault_root = settings.resolved_vault_root
        if not vault_root.is_dir() or not os.access(vault_root, os.W_OK):
            raise RuntimeError("Vault storage is unavailable.")
    except Exception:
        return JSONResponse({"status": "not_ready"}, status_code=503)
    return {"status": "ready"}
