"""Optional vendored frontend distribution; the API never imports frontend source."""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles


def mount_workspace_ui(
    app: FastAPI, *, enabled: bool, api_base: str = "/api/v1/workspace"
) -> None:
    if not enabled:
        return
    assets = Path(__file__).parent / "web"

    @app.get("/workspace-assets/config.json", include_in_schema=False)
    async def workspace_config():
        return JSONResponse(
            {"apiBase": api_base, "view": "inbox"},
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/", include_in_schema=False)
    @app.get("/workspace", include_in_schema=False)
    async def workspace_page():
        return FileResponse(assets / "index.html", headers={"Cache-Control": "no-store"})

    # Stable public URLs also serve existing dashboard embeds.
    app.mount("/workspace-assets", StaticFiles(directory=assets, check_dir=False), name="workspace-assets")
