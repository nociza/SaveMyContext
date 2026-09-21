from __future__ import annotations

import pytest

from app.db.engine import SQLITE_BUSY_TIMEOUT_MS, create_configured_async_engine


@pytest.mark.asyncio
async def test_sqlite_engine_enables_durability_and_concurrency_pragmas(tmp_path) -> None:
    engine = create_configured_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'configured.db'}")

    async with engine.connect() as connection:
        foreign_keys = (await connection.exec_driver_sql("PRAGMA foreign_keys")).scalar_one()
        busy_timeout = (await connection.exec_driver_sql("PRAGMA busy_timeout")).scalar_one()
        journal_mode = (await connection.exec_driver_sql("PRAGMA journal_mode")).scalar_one()
        synchronous = (await connection.exec_driver_sql("PRAGMA synchronous")).scalar_one()

    assert foreign_keys == 1
    assert busy_timeout == SQLITE_BUSY_TIMEOUT_MS
    assert journal_mode.lower() == "wal"
    assert synchronous == 1  # NORMAL

    await engine.dispose()
