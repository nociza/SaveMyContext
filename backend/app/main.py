from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.api.routes_openai import router as openai_router
from app.api.router import api_router
from app.core.config import get_settings
from app.db.session import init_db, SessionLocal
from app.middleware.request_size import RequestSizeLimitMiddleware
from app.services.git_versioning import GitVersioningService
from app.services.todo import TodoListConflictError, TodoListService
from app.workspace.api import compat_router
from app.workspace.store import Conflict
from app.workspace.worker import run_worker
from app.workspace.knowledge import run_sync

try:
    import uvloop
except ImportError:  # pragma: no cover
    uvloop = None


if uvloop is not None:  # pragma: no cover
    uvloop.install()


settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.resolved_markdown_dir.mkdir(parents=True, exist_ok=True)
    if settings.experimental_browser_automation:
        settings.resolved_browser_profile_dir.mkdir(parents=True, exist_ok=True)
        settings.resolved_browser_llm_state_path.parent.mkdir(
            parents=True, exist_ok=True
        )
    await init_db()
    settings.resolved_vault_root.mkdir(parents=True, exist_ok=True)
    if settings.workspace_enabled:
        from app.workspace.migrate import backfill

        await backfill()
    if not settings.workspace_enabled:
        TodoListService().ensure_exists()
        await GitVersioningService(repo_root=settings.resolved_vault_root).ensure_repo()
    stop = asyncio.Event()
    worker = (
        asyncio.create_task(run_worker(SessionLocal, stop))
        if settings.workspace_enabled and settings.workspace_worker
        else None
    )
    knowledge_worker = (
        asyncio.create_task(run_sync(SessionLocal, stop))
        if settings.workspace_enabled and settings.basic_memory_url and settings.basic_memory_sync
        else None
    )
    try:
        yield
    finally:
        stop.set()
        for task in (worker, knowledge_worker):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass


app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
)

app.add_middleware(
    RequestSizeLimitMiddleware, max_body_bytes=settings.max_request_body_bytes
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(TodoListConflictError)
async def todo_list_conflict_handler(_request: Request, exc: TodoListConflictError):
    return JSONResponse({"detail": str(exc)}, status_code=409)


@app.middleware("http")
async def security_headers(request, call_next):
    if (
        get_settings().workspace_enabled
        and request.method not in {"GET", "HEAD", "OPTIONS"}
        and any(
            request.url.path.startswith(prefix)
            for prefix in (
                "/api/v1/todo",
                "/api/v1/processing",
                "/api/v1/piles",
                "/api/v1/restructure",
            )
        )
    ):
        return JSONResponse(
            {
                "error": "Legacy processing is read-only. Use the shared workspace at /workspace."
            },
            status_code=409,
        )
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault(
        "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
    )
    return response


app.include_router(api_router, prefix=settings.api_v1_prefix)
app.include_router(openai_router, prefix="/v1")
app.include_router(compat_router)


@app.exception_handler(Conflict)
async def conflict_handler(_request, exc):
    return JSONResponse({"error": str(exc)}, status_code=409)


@app.exception_handler(LookupError)
async def missing_handler(_request, exc):
    return JSONResponse({"error": str(exc)}, status_code=404)


@app.exception_handler(ValueError)
async def invalid_handler(_request, exc):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.get("/health")
async def service_health():
    return {
        "ok": True,
        "service": "savemycontext",
        "workspace": settings.workspace_enabled,
    }


WEB_ROOT = Path(__file__).parent / "workspace" / "web"
app.mount(
    "/workspace-assets",
    StaticFiles(directory=WEB_ROOT, check_dir=False),
    name="workspace-assets",
)


@app.get("/")
@app.get("/workspace")
async def workspace_page():
    return FileResponse(WEB_ROOT / "index.html")
