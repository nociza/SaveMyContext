from fastapi import APIRouter

from app.api.routes_health import router as health_router
from app.api.routes_ingest import router as ingest_router
from app.api.routes_sessions import router as sessions_router


api_router = APIRouter()
api_router.include_router(health_router, tags=["health"])
api_router.include_router(ingest_router, prefix="/ingest", tags=["ingest"])
api_router.include_router(sessions_router, tags=["sessions"])

