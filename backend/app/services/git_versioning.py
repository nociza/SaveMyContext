from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import Settings, get_settings


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GitRepositoryStatus:
    versioning_enabled: bool
    available: bool
    repository_ready: bool
    branch: str | None = None
    clean: bool | None = None
    last_commit_short: str | None = None
    last_commit_message: str | None = None
    last_commit_at: datetime | None = None


class GitVersioningService:
    def __init__(
        self,
        *,
        repo_root: Path | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.repo_root = repo_root or self.settings.resolved_vault_root

    @property
    def enabled(self) -> bool:
        return self.settings.git_versioning_enabled

    @property
    def executable(self) -> str:
        return self.settings.git_executable

    def is_available(self) -> bool:
        return shutil.which(self.executable) is not None

    def repository_ready(self) -> bool:
        return (self.repo_root / ".git").exists()

    async def ensure_repo(self) -> bool:
        if not self.enabled or not self.is_available():
            return False
        try:
            return await asyncio.to_thread(self._ensure_repo_sync)
        except Exception:  # pragma: no cover
            logger.exception("Failed to initialize the SaveMyContext vault git repository.")
            return False

    async def commit_all(self, *, message: str) -> bool:
        if not self.enabled or not self.is_available():
            return False
        try:
            return await asyncio.to_thread(self._commit_all_sync, message)
        except Exception:  # pragma: no cover
            logger.exception("Failed to commit SaveMyContext vault changes.")
            return False

    async def describe(self) -> GitRepositoryStatus:
        available = self.is_available()
        repository_ready = self.repository_ready()
        if not self.enabled or not available:
            return GitRepositoryStatus(
                versioning_enabled=self.enabled,
                available=available,
                repository_ready=repository_ready,
            )
        try:
            return await asyncio.to_thread(self._describe_sync)
        except Exception:  # pragma: no cover
            logger.exception("Failed to inspect SaveMyContext vault git status.")
            return GitRepositoryStatus(
                versioning_enabled=self.enabled,
                available=available,
                repository_ready=repository_ready,
            )

    def _commit_all_sync(self, message: str) -> bool:
        self._ensure_repo_sync()
        self._run("add", "--all", ".")
        status = self._run("status", "--porcelain", "--untracked-files=all", capture_output=True)
        if not status.stdout.strip():
            return False
        self._run("commit", "--no-gpg-sign", "-m", message)
        return True

    def _ensure_repo_sync(self) -> bool:
        self.repo_root.mkdir(parents=True, exist_ok=True)
        git_dir = self.repo_root / ".git"
        if not git_dir.exists():
            self._run("init")
        self._run("config", "user.name", self.settings.git_author_name)
        self._run("config", "user.email", self.settings.git_author_email)
        return True

    def _describe_sync(self) -> GitRepositoryStatus:
        repository_ready = self.repository_ready()
        if not repository_ready:
            return GitRepositoryStatus(
                versioning_enabled=self.enabled,
                available=True,
                repository_ready=False,
            )

        branch = self._run_optional("branch", "--show-current", capture_output=True)
        status = self._run_optional("status", "--porcelain", "--untracked-files=all", capture_output=True)
        commit = self._run_optional("log", "-1", "--format=%ct%n%s%n%h", capture_output=True)

        branch_name = branch.stdout.strip() if branch else None
        clean = None if status is None else not bool(status.stdout.strip())
        last_commit_at: datetime | None = None
        last_commit_message: str | None = None
        last_commit_short: str | None = None

        if commit is not None:
            lines = commit.stdout.splitlines()
            if lines:
                try:
                    last_commit_at = datetime.fromtimestamp(int(lines[0]), tz=timezone.utc)
                except ValueError:
                    last_commit_at = None
            if len(lines) > 1:
                last_commit_message = lines[1].strip() or None
            if len(lines) > 2:
                last_commit_short = lines[2].strip() or None

        return GitRepositoryStatus(
            versioning_enabled=self.enabled,
            available=True,
            repository_ready=True,
            branch=branch_name or None,
            clean=clean,
            last_commit_short=last_commit_short,
            last_commit_message=last_commit_message,
            last_commit_at=last_commit_at,
        )

    def _run(self, *args: str, capture_output: bool = False) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.executable, *args],
            cwd=self.repo_root,
            check=True,
            capture_output=capture_output,
            text=True,
        )

    def _run_optional(self, *args: str, capture_output: bool = False) -> subprocess.CompletedProcess[str] | None:
        try:
            return self._run(*args, capture_output=capture_output)
        except subprocess.CalledProcessError:
            return None
