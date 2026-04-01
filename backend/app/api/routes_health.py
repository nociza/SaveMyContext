from __future__ import annotations

from fastapi import APIRouter

from app.core.config import get_settings


router = APIRouter()


@router.get("/health")
async def healthcheck() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "app": settings.app_name,
        "llm_backend": settings.llm_backend,
    }

