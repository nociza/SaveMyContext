# SaveMyContext server

Private FastAPI + SQLite memory and action workspace. Version 0.3 makes SQLite
authoritative for sources, suggestions, projects, tasks, and history. Markdown
is an export, not another writable ledger. External processing requires opt-in.

```sh
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Open `/workspace`. Configure protected per-client tokens before remote access.
The `smc` service/configuration CLI remains available; `smc-workspace` is the
agent-facing API client. See the repository README and workspace design for
extension setup, optional Jev processing, migration, backups, and compatibility.

```sh
uv run pytest -q
uv run ruff check app tests
```
