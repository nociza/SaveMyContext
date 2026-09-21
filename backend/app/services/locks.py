from __future__ import annotations

import asyncio
import fcntl
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator, AsyncIterator
from weakref import WeakKeyDictionary, WeakValueDictionary


class KeyedAsyncLockPool:
    """Return leak-free, event-loop-local locks for stable resource keys."""

    def __init__(self) -> None:
        self._locks: WeakKeyDictionary[
            asyncio.AbstractEventLoop,
            WeakValueDictionary[str, asyncio.Lock],
        ] = WeakKeyDictionary()

    def lock(self, key: str) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        locks = self._locks.get(loop)
        if locks is None:
            locks = WeakValueDictionary()
            self._locks[loop] = locks
        lock = locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            locks[key] = lock
        return lock


def lock_path_for_vault(vault_root: Path, *, purpose: str = "vault") -> Path:
    resolved = vault_root.expanduser().resolve()
    return resolved.parent / f".{resolved.name}.savemycontext-{purpose}.lock"


def _acquire(path: Path) -> BinaryIO:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    return handle


def _try_acquire(path: Path) -> BinaryIO | None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    except Exception:
        handle.close()
        raise
    return handle


def _release(handle: BinaryIO) -> None:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    handle = _acquire(path)
    try:
        yield
    finally:
        _release(handle)


@asynccontextmanager
async def async_file_lock(path: Path) -> AsyncIterator[None]:
    handle: BinaryIO | None = None
    while handle is None:
        # Poll with LOCK_NB so no executor thread or event-loop turn waits on
        # another process. Because acquisition itself is synchronous and
        # non-blocking, cancellation cannot strand a future acquired handle.
        handle = _try_acquire(path)
        if handle is None:
            await asyncio.sleep(0.05)
    try:
        yield
    finally:
        # Unlock/close is local and non-blocking. Doing it directly also makes
        # cleanup deterministic when the surrounding task is cancelled.
        _release(handle)
