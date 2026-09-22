from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.workspace.frontend import mount_workspace_ui


def test_frontend_is_optional_and_keeps_api_routes():
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    mount_workspace_ui(app, enabled=False)
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        for path in ("/", "/workspace", "/workspace-assets/workspace.js", "/workspace-assets/config.json"):
            assert client.get(path).status_code == 404


def test_bundled_distribution_preserves_dashboard_urls_and_uses_runtime_api_prefix():
    app = FastAPI()
    mount_workspace_ui(app, enabled=True, api_base="/custom/v1/workspace")
    with TestClient(app) as client:
        for path in ("/", "/workspace"):
            page = client.get(path)
            assert page.status_code == 200
            assert "/workspace-assets/app.js" in page.text
            assert page.headers["cache-control"] == "no-store"
        for name in ("workspace.js", "workspace.css", "embed.js", "config.js", "app.js", "page.css"):
            assert client.get(f"/workspace-assets/{name}").status_code == 200
        config = client.get("/workspace-assets/config.json")
        assert config.json() == {"apiBase": "/custom/v1/workspace", "view": "inbox"}
        assert config.headers["cache-control"] == "no-store"


def test_api_only_environment_setting(monkeypatch):
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_UI_ENABLED", "false")
    assert Settings().workspace_ui_enabled is False
