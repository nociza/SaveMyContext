from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from app.core.config import get_settings


CONTENT_MATCH_SCORE = 220
PATH_MATCH_SCORE = 120
COMMAND_TIMEOUT_SECONDS = 6.0
MAX_PATH_CANDIDATES = 400
NOTE_GLOBS = ("*.md", "*.markdown", "*.txt")
EXCLUDED_GLOBS = ("!**/Dashboards/**", "!**/Graph/**", "!**/manifest.json")
TOKEN_SPLIT_RE = re.compile(r"[^A-Za-z0-9]+")


def _compact_snippet(text: str, query: str, *, max_chars: int = 220) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return ""

    lowered = compact.lower()
    needle = query.strip().lower()
    if not needle:
        return compact[:max_chars]

    index = lowered.find(needle)
    if index < 0:
        for token in [part for part in TOKEN_SPLIT_RE.split(needle) if len(part) > 1]:
            index = lowered.find(token)
            if index >= 0:
                break

    if index < 0:
        snippet = compact[:max_chars].strip()
        return f"{snippet}..." if len(compact) > max_chars else snippet

    start = max(index - 72, 0)
    end = min(len(compact), index + len(needle) + 132)
    snippet = compact[start:end].strip()
    if start > 0:
        snippet = f"...{snippet}"
    if end < len(compact):
        snippet = f"{snippet}..."
    return snippet


@dataclass(slots=True)
class VaultSearchHit:
    path: str
    score: int
    snippet: str
    line_number: int | None = None


class AgenticVaultSearchService:
    def search(self, query: str, *, limit: int = 25) -> list[VaultSearchHit]:
        cleaned_query = query.strip()
        if not cleaned_query:
            return []

        roots = self._search_roots()
        if not roots:
            return []

        candidates: dict[str, VaultSearchHit] = {}
        for hit in self._content_hits(cleaned_query, roots):
            self._merge_hit(candidates, hit)
        for hit in self._path_hits(cleaned_query, roots):
            self._merge_hit(candidates, hit)

        ordered = sorted(
            candidates.values(),
            key=lambda hit: (-hit.score, hit.line_number or 10**9, hit.path.lower()),
        )
        return ordered[:limit]

    def _search_roots(self) -> list[Path]:
        settings = get_settings()
        roots: list[Path] = []
        for candidate in (settings.resolved_vault_root, settings.resolved_markdown_dir):
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            if not resolved.exists() or not resolved.is_dir():
                continue
            if resolved in roots:
                continue
            if any(existing in resolved.parents for existing in roots):
                continue
            roots = [existing for existing in roots if resolved not in existing.parents]
            roots.append(resolved)
        return roots

    def _merge_hit(self, candidates: dict[str, VaultSearchHit], hit: VaultSearchHit) -> None:
        existing = candidates.get(hit.path)
        if existing is None:
            candidates[hit.path] = hit
            return

        best_score = max(existing.score, hit.score)
        if hit.score > existing.score:
            candidates[hit.path] = VaultSearchHit(
                path=hit.path,
                score=best_score,
                snippet=hit.snippet or existing.snippet,
                line_number=hit.line_number if hit.line_number is not None else existing.line_number,
            )
            return

        candidates[hit.path] = VaultSearchHit(
            path=existing.path,
            score=best_score,
            snippet=existing.snippet or hit.snippet,
            line_number=existing.line_number if existing.line_number is not None else hit.line_number,
        )

    def _content_hits(self, query: str, roots: list[Path]) -> list[VaultSearchHit]:
        if shutil.which("rg"):
            return self._content_hits_with_ripgrep(query, roots)
        if shutil.which("grep"):
            return self._content_hits_with_grep(query, roots)
        return []

    def _content_hits_with_ripgrep(self, query: str, roots: list[Path]) -> list[VaultSearchHit]:
        command = [
            "rg",
            "--no-config",
            "--json",
            "--smart-case",
            "--line-number",
            "--max-count",
            "1",
        ]
        for glob in NOTE_GLOBS:
            command.extend(["--glob", glob])
        for glob in EXCLUDED_GLOBS:
            command.extend(["--glob", glob])
        command.extend([query, *[str(root) for root in roots]])

        completed = self._run_command(command)
        if completed is None or completed.returncode not in {0, 1}:
            return []

        hits: list[VaultSearchHit] = []
        for raw_line in completed.stdout.splitlines():
            if not raw_line.strip():
                continue
            try:
                payload = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if payload.get("type") != "match":
                continue
            data = payload.get("data") or {}
            path = data.get("path", {}).get("text")
            if not path:
                continue
            line_number = data.get("line_number")
            line_text = data.get("lines", {}).get("text", "")
            submatches = data.get("submatches") or []
            score = CONTENT_MATCH_SCORE + min(len(submatches), 4) * 10
            if isinstance(line_number, int):
                score -= min(line_number, 80)
            hits.append(
                VaultSearchHit(
                    path=str(Path(path).resolve()),
                    score=score,
                    snippet=_compact_snippet(line_text, query),
                    line_number=line_number if isinstance(line_number, int) else None,
                )
            )
        return hits

    def _content_hits_with_grep(self, query: str, roots: list[Path]) -> list[VaultSearchHit]:
        hits: list[VaultSearchHit] = []
        for root in roots:
            command = [
                "grep",
                "-RIn",
                "--binary-files=without-match",
                "--exclude-dir=Dashboards",
                "--exclude-dir=Graph",
                "--include=*.md",
                "--include=*.markdown",
                "--include=*.txt",
                query,
                str(root),
            ]
            completed = self._run_command(command)
            if completed is None or completed.returncode not in {0, 1}:
                continue

            for raw_line in completed.stdout.splitlines():
                parts = raw_line.split(":", 2)
                if len(parts) < 3:
                    continue
                path_text, line_text = parts[0], parts[2]
                line_number = None
                try:
                    line_number = int(parts[1])
                except ValueError:
                    line_text = ":".join(parts[1:])
                score = CONTENT_MATCH_SCORE
                if line_number is not None:
                    score -= min(line_number, 80)
                hits.append(
                    VaultSearchHit(
                        path=str(Path(path_text).resolve()),
                        score=score,
                        snippet=_compact_snippet(line_text, query),
                        line_number=line_number,
                    )
                )
        return hits

    def _path_hits(self, query: str, roots: list[Path]) -> list[VaultSearchHit]:
        paths = self._list_paths(roots)
        if not paths:
            return []

        lowered_query = query.lower()
        tokens = [token for token in TOKEN_SPLIT_RE.split(lowered_query) if len(token) > 1]
        hits: list[VaultSearchHit] = []
        for path in paths[:MAX_PATH_CANDIDATES]:
            lowered_path = path.as_posix().lower()
            stem = path.stem.replace("-", " ").replace("_", " ").lower()
            direct_match = lowered_query in lowered_path or lowered_query in stem
            token_match = tokens and all(token in lowered_path or token in stem for token in tokens)
            if not direct_match and not token_match:
                continue

            score = PATH_MATCH_SCORE
            if lowered_query in stem:
                score += 40
            score += sum(8 for token in tokens if token in stem)
            hits.append(
                VaultSearchHit(
                    path=str(path.resolve()),
                    score=score,
                    snippet=self._path_snippet(path, roots),
                    line_number=None,
                )
            )
        return hits

    def _list_paths(self, roots: list[Path]) -> list[Path]:
        if shutil.which("rg"):
            command = ["rg", "--no-config", "--files"]
            for glob in NOTE_GLOBS:
                command.extend(["--glob", glob])
            for glob in EXCLUDED_GLOBS:
                command.extend(["--glob", glob])
            command.extend(str(root) for root in roots)
            completed = self._run_command(command)
            if completed is not None and completed.returncode in {0, 1}:
                return [Path(line.strip()) for line in completed.stdout.splitlines() if line.strip()]

        paths: list[Path] = []
        for root in roots:
            for suffix in ("*.md", "*.markdown", "*.txt"):
                paths.extend(path for path in root.rglob(suffix) if self._include_path(path))
        return sorted({path.resolve() for path in paths}, key=lambda path: path.as_posix().lower())

    def _include_path(self, path: Path) -> bool:
        return "Dashboards" not in path.parts and "Graph" not in path.parts and path.name != "manifest.json"

    def _path_snippet(self, path: Path, roots: list[Path]) -> str:
        for root in roots:
            try:
                relative = path.resolve().relative_to(root)
            except ValueError:
                continue
            return relative.as_posix()
        return path.name

    def _run_command(self, command: list[str]) -> subprocess.CompletedProcess[str] | None:
        try:
            return subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=COMMAND_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError):
            return None
