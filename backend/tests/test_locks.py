from __future__ import annotations

import asyncio

import pytest

from app.services.locks import async_file_lock


@pytest.mark.asyncio
async def test_async_file_lock_waits_without_blocking_release(tmp_path) -> None:
    lock_path = tmp_path / "vault.lock"
    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    second_entered = asyncio.Event()

    async def holder() -> None:
        async with async_file_lock(lock_path):
            first_entered.set()
            await release_first.wait()

    async def waiter() -> None:
        async with async_file_lock(lock_path):
            second_entered.set()

    holder_task = asyncio.create_task(holder())
    await asyncio.wait_for(first_entered.wait(), timeout=1)
    waiter_task = asyncio.create_task(waiter())
    await asyncio.sleep(0.1)
    assert second_entered.is_set() is False

    release_first.set()
    await asyncio.wait_for(asyncio.gather(holder_task, waiter_task), timeout=2)
    assert second_entered.is_set() is True
