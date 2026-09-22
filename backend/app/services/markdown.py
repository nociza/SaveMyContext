from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from weakref import WeakKeyDictionary

from sqlalchemy import func, inspect, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import NO_VALUE

from app.core.config import get_settings
from app.models import ChatMessage, ChatSession, FactTriplet, BuiltInPileSlug, Pile, SourceCapture, SyncEvent
from app.services.files import atomic_write_text
from app.services.git_versioning import GitVersioningService
from app.services.locks import async_file_lock, lock_path_for_vault
from app.services.text import take_sentences
from app.services.todo import TodoListService, TODO_TITLE
from app.services.extra_piles import extract_extra_piles, visible_custom_tags


CATEGORY_LABELS = {
    BuiltInPileSlug.JOURNAL: "Journal",
    BuiltInPileSlug.FACTUAL: "Factual",
    BuiltInPileSlug.IDEAS: "Ideas",
    BuiltInPileSlug.TODO: "Todo",
}

DISCARDED_FOLDER = "Discarded"
_EXPORT_LOCKS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = WeakKeyDictionary()


def _export_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _EXPORT_LOCKS.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _EXPORT_LOCKS[loop] = lock
    return lock


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized or hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def stable_note_token(value: str, *, fallback: str = "item", max_slug_length: int = 48) -> str:
    slug = slugify(value) or fallback
    if len(slug) > max_slug_length:
        slug = slug[:max_slug_length].rstrip("-") or fallback
    normalized = re.sub(r"\s+", " ", value).strip().casefold()
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:10]
    return f"{slug}--{digest}"


def yaml_scalar(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, datetime):
        return json.dumps(normalize_datetime(value).isoformat())
    if hasattr(value, "isoformat"):
        return json.dumps(value.isoformat())
    return json.dumps(str(value))


def normalize_datetime(value: datetime) -> datetime:
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def datetime_isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return normalize_datetime(value).isoformat()


def datetime_sort_key(value: datetime | None) -> tuple[int, float]:
    if value is None:
        return (1, float("-inf"))
    return (0, normalize_datetime(value).timestamp())


class MarkdownExporter:
    def __init__(self, db: AsyncSession | None = None) -> None:
        settings = get_settings()
        self.db = db
        self.base_dir = settings.resolved_markdown_dir
        self.vault_root_name = settings.vault_root_name

    async def write_session(self, session: ChatSession) -> Path:
        async with _export_lock():
            async with async_file_lock(lock_path_for_vault(self.vault_root)):
                self._ensure_directories()
                target = self._write_session_files(session)
                await self._write_graph_notes()
                await self._write_dashboards()
                await self._commit_vault(session)
                return target

    async def write_source_capture(self, source_capture: SourceCapture) -> tuple[Path, Path]:
        async with _export_lock():
            async with async_file_lock(lock_path_for_vault(self.vault_root)):
                self._ensure_directories()
                note_path, source_path = self._write_source_capture_files(source_capture)
                await self._write_graph_notes()
                await self._write_dashboards()
                await self._commit_source_capture(source_capture)
                return note_path, source_path

    async def rebuild_vault(self) -> int:
        async with _export_lock():
            async with async_file_lock(lock_path_for_vault(self.vault_root)):
                return await self._rebuild_vault_locked()

    async def _rebuild_vault_locked(self) -> int:
        self._ensure_directories()
        await self._write_dashboards()
        if self.db is None:
            return 0

        sessions = (
            await self.db.execute(
                select(ChatSession)
                .options(
                    selectinload(ChatSession.messages),
                    selectinload(ChatSession.triplets),
                    selectinload(ChatSession.sync_events),
                )
                .order_by(ChatSession.updated_at.desc())
            )
        ).scalars().all()

        for session in sessions:
            session.markdown_path = str(self._write_session_files(session))

        source_captures = (
            await self.db.execute(select(SourceCapture).order_by(SourceCapture.updated_at.desc()))
        ).scalars().all()
        for source_capture in source_captures:
            note_path, source_path = self._write_source_capture_files(source_capture)
            source_capture.markdown_path = str(note_path)
            source_capture.raw_source_path = str(source_path)

        await self._write_graph_notes()
        await self._write_dashboards()
        return len(sessions)

    def render(self, session: ChatSession) -> str:
        return self.render_session(session)

    def render_source(self, session: ChatSession) -> str:
        return self.render_source_session(session)

    def render_session(self, session: ChatSession) -> str:
        front_matter = self._session_front_matter(session)
        title = session.title or f"{session.provider.value} {session.external_session_id}"
        lines = [
            "---",
            *front_matter,
            "---",
            "",
            f"# {title}",
            "",
            "## Metadata",
            "",
            f"- Provider: `{session.provider.value}`",
            f"- External Session ID: `{session.external_session_id}`",
            f"- Pile: {self._session_pile_display(session)}",
            f"- Tags: {', '.join(session.custom_tags) if session.custom_tags else 'none'}",
            f"- Last Captured: {datetime_isoformat(session.last_captured_at) or 'n/a'}",
            "",
            "## Source",
            "",
            f"- Session URL: {session.source_url or 'n/a'}",
            f"- Source Document: {self._wiki_link(self._source_note_path(session), 'Source Document')}",
            "",
            "## Transcript",
            "",
        ]
        for message in session.messages:
            header = f"### {message.role.value.title()}"
            if message.occurred_at:
                header += f" ({datetime_isoformat(message.occurred_at)})"
            lines.extend([header, "", message.content.strip(), ""])

        if session.journal_entry:
            lines.extend(["## Journal Entry", "", session.journal_entry.strip(), ""])
            journal_payload = self._nested_pile_output(session, "journal")
            structured_rows = []
            for label, key in (
                ("People", "people"),
                ("Entities", "entities"),
                ("Activities", "activities"),
                ("Locations", "locations"),
                ("Travel Path", "travel_path"),
            ):
                values = journal_payload.get(key)
                if isinstance(values, list):
                    cleaned = [str(value).strip() for value in values if str(value).strip()]
                    if cleaned:
                        structured_rows.append((label, cleaned))
            mood = str(journal_payload.get("mood") or "").strip()
            if mood:
                lines.extend(["## Journal Signals", "", f"- Mood: {mood}"])
                for label, values in structured_rows:
                    lines.append(f"- {label}: {', '.join(values)}")
                lines.append("")
            elif structured_rows:
                lines.extend(["## Journal Signals", ""])
                for label, values in structured_rows:
                    lines.append(f"- {label}: {', '.join(values)}")
                lines.append("")

        if session.todo_summary:
            lines.extend(
                [
                    "## To-Do Update",
                    "",
                    session.todo_summary.strip(),
                    "",
                    f"- Shared List: {self._wiki_link(self._todo_list_path(), TODO_TITLE)}",
                    "",
                ]
            )

        factual_payload = self._nested_pile_output(session, "factual")
        factual_summary = str(factual_payload.get("summary") or "").strip()
        factual_keywords = factual_payload.get("keywords")
        if factual_summary or (isinstance(factual_keywords, list) and factual_keywords):
            lines.extend(["## Factual Backlog Item", ""])
            if factual_summary:
                lines.extend([factual_summary, ""])
            if isinstance(factual_keywords, list) and any(str(item).strip() for item in factual_keywords):
                lines.append("Keywords:")
                lines.extend(f"- {str(item).strip()}" for item in factual_keywords if str(item).strip())
                lines.append("")

        if session.triplets:
            lines.extend(["## Fact Triplets", ""])
            for triplet in session.triplets:
                lines.append(f"- {triplet.subject} | {triplet.predicate} | {triplet.object}")
            lines.append("")
            lines.extend(["## Related Entities", ""])
            for entity in self._session_entities(session):
                entity_path = self._entity_note_path(entity)
                lines.append(f"- {self._wiki_link(entity_path, entity)}")
            lines.append("")

        if session.idea_summary:
            lines.extend(self._render_idea_summary(session.idea_summary))

        if session.share_post:
            lines.extend(["## Share Post", "", session.share_post.strip(), ""])

        if session.segments:
            lines.extend(self._render_segments(session.segments))

        if session.pile_outputs:
            lines.extend(self._render_pile_outputs(session.pile_outputs))

        return "\n".join(lines).strip() + "\n"

    def render_source_session(self, session: ChatSession) -> str:
        title = session.title or f"{session.provider.value} {session.external_session_id}"
        lines = [
            "---",
            f"id: {yaml_scalar(f'savemycontext-source-{session.id}')}",
            f"type: {yaml_scalar('session_source')}",
            f"provider: {yaml_scalar(session.provider.value)}",
            f"external_session_id: {yaml_scalar(session.external_session_id)}",
            f"session_note: {yaml_scalar(self._session_note_path(session).relative_to(self.vault_root).as_posix())}",
            f"captured_at: {yaml_scalar(session.last_captured_at)}",
            f"updated_at: {yaml_scalar(session.updated_at)}",
            "---",
            "",
            f"# Source Document: {title}",
            "",
            "## Overview",
            "",
            f"- Session Note: {self._wiki_link(self._session_note_path(session), title)}",
            f"- Session URL: {session.source_url or 'n/a'}",
            f"- Provider: `{session.provider.value}`",
            f"- External Session ID: `{session.external_session_id}`",
            "",
            "## Raw Sync Captures",
            "",
        ]

        sync_events = sorted(self._loaded_relationship_items(session, "sync_events"), key=lambda item: datetime_sort_key(item.created_at))
        raw_sync_events = [event for event in sync_events if event.raw_capture is not None or event.evidence_ref]
        if raw_sync_events:
            for index, event in enumerate(raw_sync_events, start=1):
                lines.extend(self._render_sync_event_source(index, event))
        else:
            lines.extend(["No raw sync capture payloads were stored for this session.", ""])

        lines.extend(["## Raw Message Payloads", ""])
        messages = self._loaded_relationship_items(session, "messages")
        if messages:
            for message in messages:
                lines.extend(self._render_message_source(message))
        else:
            lines.extend(["No messages were stored for this session.", ""])

        return "\n".join(lines).strip() + "\n"

    def render_source_capture(self, source_capture: SourceCapture) -> str:
        title = self._capture_display_title(source_capture)
        lines = [
            "---",
            f"id: {yaml_scalar(source_capture.id)}",
            f"type: {yaml_scalar('source_capture')}",
            f"capture_kind: {yaml_scalar(source_capture.capture_kind)}",
            f"save_mode: {yaml_scalar(source_capture.save_mode)}",
            f"pile: {yaml_scalar(source_capture.built_in_pile.value if source_capture.built_in_pile else 'unclassified')}",
            f"source_url: {yaml_scalar(source_capture.source_url or '')}",
            f"created_at: {yaml_scalar(source_capture.created_at)}",
            f"updated_at: {yaml_scalar(source_capture.updated_at)}",
            "---",
            "",
            f"# {title}",
            "",
            "## Metadata",
            "",
            f"- Capture Kind: `{source_capture.capture_kind}`",
            f"- Save Mode: `{source_capture.save_mode}`",
            f"- Pile: `{source_capture.built_in_pile.value if source_capture.built_in_pile else 'unclassified'}`",
            f"- Page Title: {source_capture.page_title or 'n/a'}",
            f"- Source URL: {source_capture.source_url or 'n/a'}",
            f"- Raw Source: {self._wiki_link(self._source_capture_source_path(source_capture), 'Source Document')}",
            "",
        ]
        if source_capture.classification_reason:
            lines.extend(["## Classification", "", source_capture.classification_reason.strip(), ""])
        if source_capture.summary:
            lines.extend(["## Summary", "", source_capture.summary.strip(), ""])

        content = (source_capture.cleaned_markdown or source_capture.source_markdown or source_capture.source_text).strip()
        lines.extend(["## Saved Content", "", content, ""])
        return "\n".join(lines).strip() + "\n"

    def render_source_capture_source(self, source_capture: SourceCapture) -> str:
        title = self._capture_display_title(source_capture)
        lines = [
            "---",
            f"id: {yaml_scalar(f'savemycontext-capture-source-{source_capture.id}')}",
            f"type: {yaml_scalar('source_capture_source')}",
            f"capture_id: {yaml_scalar(source_capture.id)}",
            f"capture_note: {yaml_scalar(self._source_capture_note_path(source_capture).relative_to(self.vault_root).as_posix())}",
            f"capture_kind: {yaml_scalar(source_capture.capture_kind)}",
            f"save_mode: {yaml_scalar(source_capture.save_mode)}",
            f"source_url: {yaml_scalar(source_capture.source_url or '')}",
            f"created_at: {yaml_scalar(source_capture.created_at)}",
            f"updated_at: {yaml_scalar(source_capture.updated_at)}",
            "---",
            "",
            f"# Source Document: {title}",
            "",
            "## Overview",
            "",
            f"- Capture Note: {self._wiki_link(self._source_capture_note_path(source_capture), title)}",
            f"- Page Title: {source_capture.page_title or 'n/a'}",
            f"- Source URL: {source_capture.source_url or 'n/a'}",
            "",
        ]
        if source_capture.selection_text:
            lines.extend(["## Original Selection", "", source_capture.selection_text.strip(), ""])
        if source_capture.source_markdown:
            lines.extend(["## Captured Markdown", ""])
            lines.extend(self._fenced_block("markdown", source_capture.source_markdown.strip()))
            lines.append("")
        lines.extend(["## Captured Text", ""])
        lines.extend(self._fenced_block("text", source_capture.source_text.strip()))
        lines.append("")
        lines.extend(["## Raw Payload", ""])
        if source_capture.raw_payload is None:
            lines.append("No raw payload was stored for this capture.")
            lines.append("")
        else:
            lines.extend(self._fenced_block("json", self._json_dump(source_capture.raw_payload)))
            lines.append("")
        return "\n".join(lines).strip() + "\n"

    async def _write_graph_notes(self) -> None:
        if self.db is None:
            return
        entities_dir = self.vault_root / "Graph" / "Entities"
        indexes_dir = self.vault_root / "Graph" / "Indexes"

        triplets = (
            await self.db.execute(select(FactTriplet).options(selectinload(FactTriplet.session)))
        ).scalars().all()
        by_entity: dict[str, list[FactTriplet]] = defaultdict(list)
        for triplet in triplets:
            by_entity[triplet.subject].append(triplet)
            if triplet.object != triplet.subject:
                by_entity[triplet.object].append(triplet)

        projections: dict[Path, tuple[str, str]] = {}
        for entity, entity_triplets in by_entity.items():
            note_path = self._entity_note_path(entity)
            entity_token = stable_note_token(entity, fallback="entity")
            entity_id = f"savemycontext-entity-{entity_token}"
            related_sessions = {
                triplet.session for triplet in entity_triplets if triplet.session is not None
            }
            lines = [
                "---",
                f"id: {yaml_scalar(entity_id)}",
                f"type: {yaml_scalar('entity')}",
                f"entity: {yaml_scalar(entity)}",
                "---",
                "",
                f"# {entity}",
                "",
                "## Facts",
                "",
            ]
            for triplet in entity_triplets:
                lines.append(f"- {triplet.subject} | {triplet.predicate} | {triplet.object}")
            lines.extend(["", "## Source Sessions", ""])
            for session in sorted(related_sessions, key=lambda item: datetime_sort_key(item.updated_at), reverse=True):
                lines.append(
                    f"- {self._wiki_link(self._session_note_path(session), session.title or session.external_session_id)}"
                )
            projections[note_path] = ("\n".join(lines).strip() + "\n", entity_id)

        entity_index_id = "savemycontext-graph-index-entities"
        entity_index_lines = [
            "---",
            f"id: {yaml_scalar(entity_index_id)}",
            f"type: {yaml_scalar('graph_index')}",
            "---",
            "",
            "# Entity Index",
            "",
            f"- Total entities: {len(by_entity)}",
            "",
        ]
        for entity in sorted(by_entity):
            entity_index_lines.append(f"- {self._wiki_link(self._entity_note_path(entity), entity)}")
        projections[indexes_dir / "Entity Index.md"] = (
            "\n".join(entity_index_lines).strip() + "\n",
            entity_index_id,
        )

        relationship_index_id = "savemycontext-graph-index-relationships"
        relationship_lines = [
            "---",
            f"id: {yaml_scalar(relationship_index_id)}",
            f"type: {yaml_scalar('graph_index')}",
            "---",
            "",
            "# Relationship Index",
            "",
        ]
        for triplet in sorted(triplets, key=lambda item: (item.subject.lower(), item.predicate.lower(), item.object.lower())):
            relationship_lines.append(f"- {triplet.subject} | {triplet.predicate} | {triplet.object}")
        projections[indexes_dir / "Relationship Index.md"] = (
            "\n".join(relationship_lines).strip() + "\n",
            relationship_index_id,
        )

        # Render every projection before mutating the last known-good graph.
        # Files are staged on the same filesystem, preflighted for ownership,
        # then atomically replaced one by one. Stale managed files are retired
        # only after all current projections have been installed successfully.
        graph_root = self.vault_root / "Graph"
        graph_root.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix=".savemycontext-graph-", dir=graph_root) as temporary_directory:
            staging_root = Path(temporary_directory)
            staged_by_target: dict[Path, Path] = {}
            for target, (content, _expected_id) in projections.items():
                staged = staging_root / target.relative_to(graph_root)
                atomic_write_text(staged, content)
                staged_by_target[target] = staged

            for target, (_content, expected_id) in projections.items():
                if not target.exists():
                    continue
                if self._path_is_owned_graph_projection(target, expected_id):
                    continue
                if self._path_is_legacy_graph_index(target, expected_id):
                    continue
                raise FileExistsError(
                    f"Refusing to overwrite unmanaged graph note: {target}"
                )

            for target in sorted(staged_by_target, key=lambda item: item.as_posix()):
                target.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_text(
                    target,
                    staged_by_target[target].read_text(encoding="utf-8"),
                )

        desired_paths = set(projections)
        for candidate in [*entities_dir.glob("*.md"), *indexes_dir.glob("*.md")]:
            if candidate in desired_paths:
                continue
            if self._path_is_owned_graph_projection(candidate):
                candidate.unlink()

    async def _write_dashboards(self) -> None:
        if self.db is None:
            return
        all_sessions = (
            await self.db.execute(select(ChatSession).order_by(ChatSession.updated_at.desc()))
        ).scalars().all()
        sessions = [session for session in all_sessions if not session.is_discarded]
        discarded_sessions = [session for session in all_sessions if session.is_discarded]
        all_captures = (
            await self.db.execute(select(SourceCapture).order_by(SourceCapture.updated_at.desc()))
        ).scalars().all()
        source_captures = [capture for capture in all_captures if not capture.is_discarded]
        triplet_count = int((await self.db.scalar(select(func.count(FactTriplet.id)))) or 0)

        dashboards_dir = self.vault_root / "Dashboards"
        for built_in_pile, label in CATEGORY_LABELS.items():
            lines = [f"# {label} Index", ""]
            pile_sessions = [session for session in sessions if session.built_in_pile == built_in_pile]
            pile_captures = [capture for capture in source_captures if capture.built_in_pile == built_in_pile]
            lines.append(f"- Total sessions: {len(pile_sessions)}")
            lines.append(f"- Total saved sources: {len(pile_captures)}")
            lines.append("")
            if built_in_pile == BuiltInPileSlug.TODO:
                lines.append(f"- Shared List: {self._wiki_link(self._todo_list_path(), TODO_TITLE)}")
                lines.append("")
            if pile_sessions:
                lines.extend(["## Sessions", ""])
                for session in pile_sessions:
                    lines.append(
                        f"- {self._wiki_link(self._session_note_path(session), session.title or session.external_session_id)}"
                    )
                lines.append("")
            if pile_captures:
                lines.extend(["## Saved Sources", ""])
                for capture in pile_captures:
                    lines.append(
                        f"- {self._wiki_link(self._source_capture_note_path(capture), self._capture_display_title(capture))}"
                    )
            atomic_write_text(dashboards_dir / f"{label} Index.md", "\n".join(lines).strip() + "\n")

        discarded_lines = [
            "# Discarded Index",
            "",
            "Sessions kept here are saved chronologically with metadata only. They are not classified, not summarized, and not surfaced on the main dashboard. Use the extension's Discarded view to recover an item.",
            "",
            f"- Total discarded: {len(discarded_sessions)}",
            "",
        ]
        if discarded_sessions:
            discarded_lines.extend(["## Sessions", ""])
            for session in sorted(
                discarded_sessions,
                key=lambda s: datetime_sort_key(s.last_captured_at or s.updated_at),
                reverse=True,
            ):
                captured_at = datetime_isoformat(session.last_captured_at) or "n/a"
                title = session.title or session.external_session_id
                discarded_lines.append(
                    f"- {captured_at} — {self._wiki_link(self._session_note_path(session), title)}"
                )
        atomic_write_text(dashboards_dir / "Discarded Index.md", "\n".join(discarded_lines).strip() + "\n")

        graph_index_lines = [
            "# Graph Index",
            "",
            f"- {self._wiki_link(self.vault_root / 'Graph' / 'Indexes' / 'Entity Index.md', 'Entity Index')}",
            f"- {self._wiki_link(self.vault_root / 'Graph' / 'Indexes' / 'Relationship Index.md', 'Relationship Index')}",
        ]
        atomic_write_text(dashboards_dir / "Graph Index.md", "\n".join(graph_index_lines).strip() + "\n")
        capture_index_lines = [
            "# Captures Index",
            "",
            f"- Total captures: {len(source_captures)}",
            f"- Raw captures: {len([capture for capture in source_captures if capture.save_mode == 'raw'])}",
            f"- AI-enriched captures: {len([capture for capture in source_captures if capture.save_mode == 'ai'])}",
            "",
        ]
        for capture in source_captures:
            label = self._capture_display_title(capture)
            suffix = f" [{capture.save_mode}]"
            capture_index_lines.append(f"- {self._wiki_link(self._source_capture_note_path(capture), label)}{suffix}")
        atomic_write_text(dashboards_dir / "Captures Index.md", "\n".join(capture_index_lines).strip() + "\n")
        atomic_write_text(
            dashboards_dir / "Home.md",
            self._render_home_dashboard(sessions, source_captures, triplet_count),
        )
        atomic_write_text(
            self.vault_root / "README.md",
            self._render_vault_readme(sessions, source_captures, triplet_count),
        )
        atomic_write_text(
            self.vault_root / "AGENTS.md",
            self._render_agents_guide(sessions, source_captures, triplet_count),
        )
        atomic_write_text(
            self.vault_root / "manifest.json",
            self._render_manifest_json(sessions, source_captures, triplet_count),
        )

    @staticmethod
    def _session_pile(session: ChatSession) -> Pile | None:
        pile = session.pile
        if pile is None or pile.id != session.pile_id:
            return None
        return pile

    def _session_pile_slug(self, session: ChatSession) -> str:
        pile = self._session_pile(session)
        if pile is not None:
            return pile.slug
        if session.built_in_pile is not None:
            return session.built_in_pile.value
        return "unclassified"

    def _session_pile_display(self, session: ChatSession) -> str:
        slug = self._session_pile_slug(session)
        pile = self._session_pile(session)
        if pile is not None and session.built_in_pile is None:
            return f"`{slug}` ({pile.name})"
        return f"`{slug}`"

    def _session_front_matter(self, session: ChatSession) -> list[str]:
        extra_piles = extract_extra_piles(session.custom_tags)
        visible_tags = visible_custom_tags(session.custom_tags)
        lines = [
            f"id: {yaml_scalar(session.id)}",
            f"type: {yaml_scalar('session')}",
            f"provider: {yaml_scalar(session.provider.value)}",
            f"external_session_id: {yaml_scalar(session.external_session_id)}",
            f"pile: {yaml_scalar(self._session_pile_slug(session))}",
            f"source_url: {yaml_scalar(session.source_url or '')}",
            f"captured_at: {yaml_scalar(session.last_captured_at)}",
            f"updated_at: {yaml_scalar(session.updated_at)}",
        ]
        if extra_piles:
            lines.append("extra_piles:")
            lines.extend(f"  - {yaml_scalar(extra_pile)}" for extra_pile in extra_piles)
        lines.extend(["tags:", "  - savemycontext"])
        if session.built_in_pile:
            lines.append(f"  - {session.built_in_pile.value}")
        for tag in visible_tags:
            lines.append(f"  - {tag}")
        return lines

    def _ensure_directories(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        for category_label in CATEGORY_LABELS.values():
            (self.vault_root / category_label).mkdir(parents=True, exist_ok=True)
        (self.vault_root / DISCARDED_FOLDER).mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Captures").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Sessions").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Sources").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Graph" / "Entities").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Graph" / "Indexes").mkdir(parents=True, exist_ok=True)
        (self.vault_root / "Dashboards").mkdir(parents=True, exist_ok=True)
        TodoListService(base_dir=self.base_dir, vault_root_name=self.vault_root_name).ensure_exists()

    def _write_session_files(self, session: ChatSession) -> Path:
        target = self._session_note_path(session)
        source_target = self._source_note_path(session)
        previous_path = Path(session.markdown_path).expanduser() if session.markdown_path else None
        target.parent.mkdir(parents=True, exist_ok=True)
        source_target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(target, self.render_session(session))
        atomic_write_text(source_target, self.render_source_session(session))
        if (
            previous_path
            and previous_path != target
            and self._path_is_owned_by_session(previous_path, session.id)
        ):
            previous_path.unlink()
        legacy_source_path = (
            self.vault_root
            / "Sources"
            / f"{session.provider.value}--{slugify(session.external_session_id)}--source.md"
        )
        if (
            legacy_source_path != source_target
            and self._path_is_owned_by_session(legacy_source_path, session.id)
        ):
            legacy_source_path.unlink()
        return target

    def _write_source_capture_files(self, source_capture: SourceCapture) -> tuple[Path, Path]:
        target = self._source_capture_note_path(source_capture)
        raw_target = self._source_capture_source_path(source_capture)
        previous_path = Path(source_capture.markdown_path).expanduser() if source_capture.markdown_path else None
        previous_raw_path = Path(source_capture.raw_source_path).expanduser() if source_capture.raw_source_path else None
        atomic_write_text(target, self.render_source_capture(source_capture))
        atomic_write_text(raw_target, self.render_source_capture_source(source_capture))
        if (
            previous_path
            and not self._paths_resolve_same(previous_path, target)
            and not self._paths_resolve_same(previous_path, raw_target)
            and self._path_is_owned_by_source_capture(previous_path, source_capture.id)
        ):
            previous_path.unlink()
        if (
            previous_raw_path
            and not self._paths_resolve_same(previous_raw_path, raw_target)
            and not self._paths_resolve_same(previous_raw_path, target)
            and self._path_is_owned_by_source_capture(previous_raw_path, source_capture.id)
        ):
            previous_raw_path.unlink()
        return target, raw_target

    def _session_note_path(self, session: ChatSession) -> Path:
        identity = self._session_file_identity(session)
        if session.is_discarded:
            timestamp = normalize_datetime(
                session.last_captured_at or session.updated_at or datetime.now(timezone.utc)
            )
            year = f"{timestamp.year:04d}"
            day = f"{timestamp.month:02d}-{timestamp.day:02d}"
            filename = f"{day}--{session.provider.value}--{identity}.md"
            return self.vault_root / DISCARDED_FOLDER / year / filename
        pile = self._session_pile(session)
        pile_dir = pile.folder_label if pile is not None else CATEGORY_LABELS.get(session.built_in_pile, "Sessions")
        filename = f"{session.provider.value}--{identity}.md"
        return self.vault_root / pile_dir / filename

    def _entity_note_path(self, entity: str) -> Path:
        return self.vault_root / "Graph" / "Entities" / f"{stable_note_token(entity, fallback='entity')}.md"

    def _source_note_path(self, session: ChatSession) -> Path:
        filename = f"{session.provider.value}--{self._session_file_identity(session)}--source.md"
        return self.vault_root / "Sources" / filename

    @staticmethod
    def _session_file_identity(session: ChatSession) -> str:
        # The external ID remains recognizable while the canonical database ID
        # makes the filename collision-free even when punctuation or case in
        # two provider IDs slugifies to the same text.
        external_slug = slugify(session.external_session_id)[:64].rstrip("-") or "session"
        return f"{external_slug}--{session.id}"

    def _path_is_owned_by_session(self, path: Path, session_id: str) -> bool:
        if not path.exists() or not path.is_file():
            return False
        try:
            path.resolve().relative_to(self.vault_root.resolve())
            with path.open("r", encoding="utf-8") as handle:
                head = "".join(handle.readline() for _ in range(20))
        except (OSError, RuntimeError, ValueError):
            return False
        owned_ids = (session_id, f"savemycontext-source-{session_id}")
        return any(f"id: {yaml_scalar(owned_id)}\n" in head for owned_id in owned_ids)

    @staticmethod
    def _paths_resolve_same(left: Path, right: Path) -> bool:
        try:
            return left.resolve() == right.resolve()
        except (OSError, RuntimeError):
            return False

    def _path_is_owned_by_source_capture(self, path: Path, capture_id: str) -> bool:
        if not path.exists() or not path.is_file():
            return False
        try:
            resolved_path = path.resolve()
            resolved_vault = self.vault_root.resolve()
            resolved_path.relative_to(resolved_vault)
        except (OSError, RuntimeError, ValueError):
            return False
        front_matter = self._front_matter_lines(path)
        if front_matter is None:
            return False
        owned_pairs = (
            (capture_id, "source_capture"),
            (f"savemycontext-capture-source-{capture_id}", "source_capture_source"),
        )
        return any(
            f"id: {yaml_scalar(owned_id)}" in front_matter
            and f"type: {yaml_scalar(owned_type)}" in front_matter
            for owned_id, owned_type in owned_pairs
        )

    @staticmethod
    def _front_matter_lines(path: Path) -> set[str] | None:
        if not path.exists() or not path.is_file():
            return None
        try:
            with path.open("r", encoding="utf-8") as handle:
                lines = [handle.readline().rstrip("\r\n") for _ in range(20)]
        except OSError:
            return None
        if not lines or lines[0] != "---":
            return None
        try:
            closing_index = lines.index("---", 1)
        except ValueError:
            return None
        return set(lines[1:closing_index])

    @classmethod
    def _path_is_owned_graph_projection(cls, path: Path, expected_id: str | None = None) -> bool:
        front_matter = cls._front_matter_lines(path)
        if front_matter is None:
            return False
        if expected_id is not None:
            expected_type = "entity" if expected_id.startswith("savemycontext-entity-") else "graph_index"
            return (
                f"id: {yaml_scalar(expected_id)}" in front_matter
                and f"type: {yaml_scalar(expected_type)}" in front_matter
            )
        front_matter_text = "\n".join(front_matter)
        return (
            f"type: {yaml_scalar('entity')}" in front_matter
            and bool(re.search(r'^id: "savemycontext-entity-[^"]+"$', front_matter_text, flags=re.MULTILINE))
        ) or (
            f"type: {yaml_scalar('graph_index')}" in front_matter
            and bool(
                re.search(
                    r'^id: "savemycontext-graph-index-[^"]+"$',
                    front_matter_text,
                    flags=re.MULTILINE,
                )
            )
        )

    @staticmethod
    def _path_is_legacy_graph_index(path: Path, expected_id: str) -> bool:
        legacy_heading = {
            "savemycontext-graph-index-entities": "# Entity Index",
            "savemycontext-graph-index-relationships": "# Relationship Index",
        }.get(expected_id)
        if legacy_heading is None or not path.exists() or not path.is_file():
            return False
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return False
        if not lines or lines[0] != legacy_heading:
            return False
        body_lines = [line for line in lines[1:] if line.strip()]
        if expected_id == "savemycontext-graph-index-entities":
            return bool(body_lines) and body_lines[0].startswith("- Total entities: ")
        return all(line.startswith("- ") and " | " in line for line in body_lines)

    def _todo_list_path(self) -> Path:
        return TodoListService(base_dir=self.base_dir, vault_root_name=self.vault_root_name).path

    def _source_capture_note_path(self, source_capture: SourceCapture) -> Path:
        capture_slug = slugify(self._capture_slug_seed(source_capture))[:64].rstrip("-") or "capture"
        filename = f"{source_capture.capture_kind}--{capture_slug}--{source_capture.id}.md"
        return self.vault_root / "Captures" / filename

    def _source_capture_source_path(self, source_capture: SourceCapture) -> Path:
        capture_slug = slugify(self._capture_slug_seed(source_capture))[:64].rstrip("-") or "capture"
        filename = (
            f"{source_capture.capture_kind}--{capture_slug}"
            f"--{source_capture.id}--source.md"
        )
        return self.vault_root / "Sources" / filename

    def _session_entities(self, session: ChatSession) -> list[str]:
        entities = {triplet.subject for triplet in session.triplets} | {triplet.object for triplet in session.triplets}
        return sorted(entities, key=str.lower)

    def _wiki_link(self, path: Path, label: str | None = None) -> str:
        relative = path.relative_to(self.vault_root).with_suffix("")
        if label:
            return f"[[{relative.as_posix()}|{label}]]"
        return f"[[{relative.as_posix()}]]"

    def _render_segments(self, segments: list[dict[str, object]]) -> list[str]:
        lines = ["## Segments", ""]
        for index, segment in enumerate(segments, start=1):
            pile_slug = str(segment.get("pile_slug") or "unknown")
            start_index = segment.get("start_index")
            end_index = segment.get("end_index")
            reason = str(segment.get("reason") or "").strip()
            header = f"### {index}. `{pile_slug}`"
            if isinstance(start_index, int) and isinstance(end_index, int):
                header += f" — messages [{start_index}..{end_index}]"
            lines.append(header)
            lines.append("")
            if reason:
                lines.extend([reason, ""])
        return lines

    def _render_pile_outputs(self, pile_outputs: dict[str, object]) -> list[str]:
        if any(key in pile_outputs for key in ("journal", "factual", "idea", "todo")):
            return []

        lines = ["## Pile Outputs", ""]

        summary = str(pile_outputs.get("summary") or "").strip()
        if summary:
            lines.extend(["### Summary", "", summary, ""])

        share_post = str(pile_outputs.get("share_post") or "").strip()
        if share_post:
            lines.extend(["### Share Post", "", share_post, ""])

        alternate = pile_outputs.get("alternate_phrasings")
        if isinstance(alternate, list) and any(str(item).strip() for item in alternate):
            lines.extend(["### Alternate Phrasings", ""])
            for item in alternate:
                cleaned = str(item).strip()
                if cleaned:
                    lines.append(f"- {cleaned}")
            lines.append("")

        importance = pile_outputs.get("importance")
        if isinstance(importance, (int, float)):
            lines.extend(["### Importance", "", f"- {int(importance)} / 5", ""])

        deadline = pile_outputs.get("deadline")
        if isinstance(deadline, str) and deadline.strip():
            lines.extend(["### Deadline", "", f"- {deadline.strip()}", ""])

        completion = pile_outputs.get("completion")
        if isinstance(completion, str) and completion.strip():
            lines.extend(["### Completion", "", f"- {completion.strip()}", ""])

        qa_pairs = pile_outputs.get("qa_pairs")
        if isinstance(qa_pairs, list) and qa_pairs:
            lines.extend(["### Q&A", ""])
            for item in qa_pairs:
                if not isinstance(item, dict):
                    continue
                question = str(item.get("question") or "").strip()
                answer = str(item.get("answer") or "").strip()
                if question and answer:
                    lines.extend([f"- **Q:** {question}", f"  **A:** {answer}"])
            lines.append("")

        return lines

    def _render_idea_summary(self, idea_summary: dict[str, object]) -> list[str]:
        lines = ["## Idea Summary", ""]

        core_idea = str(idea_summary.get("core_idea", "")).strip()
        if core_idea:
            lines.extend(["### Core Idea", "", core_idea, ""])

        thread_hint = str(idea_summary.get("thread_hint") or "").strip()
        if thread_hint:
            lines.extend(["### Thread", "", thread_hint, ""])

        for heading, key in (
            ("Pros", "pros"),
            ("Cons", "cons"),
            ("Next Steps", "next_steps"),
        ):
            values = idea_summary.get(key)
            lines.extend([f"### {heading}", ""])
            if isinstance(values, list) and values:
                lines.extend(f"- {str(value).strip()}" for value in values if str(value).strip())
            else:
                lines.append("- None")
            lines.append("")

        for heading, key in (
            ("Reasoning Steps", "reasoning_steps"),
            ("Related Facts", "related_facts"),
            ("Supports", "supports"),
            ("Conflicts With", "conflicts_with"),
            ("Builds On", "builds_on"),
            ("Validates", "validates"),
            ("Counters", "counters"),
        ):
            values = idea_summary.get(key)
            if isinstance(values, list) and any(str(value).strip() for value in values):
                lines.extend([f"### {heading}", ""])
                lines.extend(f"- {str(value).strip()}" for value in values if str(value).strip())
                lines.append("")

        attributed = idea_summary.get("attributed_ideas")
        if isinstance(attributed, list) and attributed:
            lines.extend(["### Attributed Ideas", ""])
            for item in attributed:
                if not isinstance(item, dict):
                    continue
                idea = str(item.get("idea") or "").strip()
                if not idea:
                    continue
                person = str(item.get("attributed_to") or "User").strip()
                stance = str(item.get("stance") or "proposes").strip()
                lines.append(f"- **{person}** ({stance}): {idea}")
            lines.append("")

        relations = idea_summary.get("relations")
        if isinstance(relations, list) and relations:
            lines.extend(["### Idea Relations", ""])
            for item in relations:
                if not isinstance(item, dict):
                    continue
                target = str(item.get("target") or "").strip()
                relation = str(item.get("relation") or "related_to").strip()
                rationale = str(item.get("rationale") or "").strip()
                if target:
                    suffix = f" — {rationale}" if rationale else ""
                    lines.append(f"- {relation}: {target}{suffix}")
            lines.append("")

        return lines

    @staticmethod
    def _nested_pile_output(session: ChatSession, key: str) -> dict[str, object]:
        pile_outputs = session.pile_outputs if isinstance(session.pile_outputs, dict) else {}
        value = pile_outputs.get(key)
        return value if isinstance(value, dict) else {}

    def _render_sync_event_source(self, index: int, event: SyncEvent) -> list[str]:
        lines = [f"### Capture {index}", ""]
        lines.append(f"- Captured At: {datetime_isoformat(event.created_at) or 'n/a'}")
        lines.append(f"- Message Count: {event.message_count}")
        lines.append("")
        if event.raw_capture is None and event.evidence_ref:
            lines.append(f"Archived evidence: `{event.evidence_ref}`. Retrieve through a full context export.")
        else:
            lines.extend(self._fenced_block("json", self._json_dump(event.raw_capture)))
        lines.append("")
        return lines

    def _render_message_source(self, message: ChatMessage) -> list[str]:
        header = f"### {message.role.value.title()} `{message.external_message_id}`"
        lines = [header, ""]
        lines.append(f"- Occurred At: {datetime_isoformat(message.occurred_at) or 'n/a'}")
        lines.append(f"- Parent Message ID: `{message.parent_external_message_id or 'n/a'}`")
        lines.append("")
        lines.extend(["#### Stored Content", ""])
        lines.extend(self._fenced_block("text", message.content.strip()))
        lines.append("")
        lines.extend(["#### Raw Payload", ""])
        if message.raw_payload is None:
            lines.append(f"Archived evidence: `{message.evidence_ref}`. Retrieve through a full context export."
                         if message.evidence_ref else "No raw payload was stored for this message.")
            lines.append("")
            return lines
        lines.extend(self._fenced_block("json", self._json_dump(message.raw_payload)))
        lines.append("")
        return lines

    def _fenced_block(self, language: str, value: str) -> list[str]:
        return [f"```{language}", value, "```"]

    def _json_dump(self, value: object) -> str:
        return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)

    def _loaded_relationship_items(self, session: ChatSession, relationship_name: str) -> list[object]:
        state = inspect(session)
        attribute = state.attrs[relationship_name]
        loaded = attribute.loaded_value
        if loaded is NO_VALUE:
            return []
        return list(loaded or [])

    def _render_home_dashboard(
        self,
        sessions: list[ChatSession],
        source_captures: list[SourceCapture],
        triplet_count: int,
    ) -> str:
        provider_counts = self._provider_counts(sessions)
        lines = [
            "# SaveMyContext Home",
            "",
            "## Start Here",
            "",
            f"- Human overview: {self._wiki_link(self.vault_root / 'README.md', 'README')}",
            f"- Agent workflow: {self._wiki_link(self.vault_root / 'AGENTS.md', 'AGENTS')}",
            f"- Shared to-do list: {self._wiki_link(self._todo_list_path(), TODO_TITLE)}",
            f"- Graph overview: {self._wiki_link(self.vault_root / 'Dashboards' / 'Graph Index.md', 'Graph Index')}",
            f"- Saved sources: {self._wiki_link(self.vault_root / 'Dashboards' / 'Captures Index.md', 'Captures Index')}",
            "",
            "## Snapshot",
            "",
            f"- Total sessions: {len(sessions)}",
            f"- Total saved sources: {len(source_captures)}",
            f"- Total fact triplets: {triplet_count}",
            "",
            "## Piles",
            "",
        ]
        for _, label in CATEGORY_LABELS.items():
            lines.append(f"- {self._wiki_link(self.vault_root / 'Dashboards' / f'{label} Index.md', f'{label} Index')}")
        lines.append(f"- {self._wiki_link(self.vault_root / 'Dashboards' / 'Captures Index.md', 'Captures Index')}")
        lines.extend(["", "## Providers", ""])
        if provider_counts:
            for provider, count in provider_counts.items():
                lines.append(f"- {provider}: {count}")
        else:
            lines.append("- No captured sessions yet.")
        lines.extend(["", "## Recent Sessions", ""])
        if sessions:
            for session in sessions[:12]:
                lines.append(
                    f"- {self._wiki_link(self._session_note_path(session), session.title or session.external_session_id)}"
                )
        else:
            lines.append("- No captured sessions yet.")
        lines.extend(["", "## Recent Saved Sources", ""])
        if source_captures:
            for capture in source_captures[:12]:
                lines.append(
                    f"- {self._wiki_link(self._source_capture_note_path(capture), self._capture_display_title(capture))}"
                )
        else:
            lines.append("- No saved sources yet.")
        return "\n".join(lines).strip() + "\n"

    def _render_vault_readme(
        self,
        sessions: list[ChatSession],
        source_captures: list[SourceCapture],
        triplet_count: int,
    ) -> str:
        lines = [
            "# SaveMyContext Vault",
            "",
            "This vault mirrors synced AI conversations into a local, searchable knowledge base.",
            "",
            "## What Lives Here",
            "",
            "- `Factual/`, `Ideas/`, `Journal/`, `Todo/`, `Sessions/`: processed conversation notes.",
            "- `Captures/`: saved selections and saved pages.",
            "- `Sources/`: raw provider captures and raw message payloads.",
            "- `Graph/Entities/`: per-entity notes derived from fact triplets.",
            "- `Dashboards/`: entry points, indexes, and the shared to-do list.",
            "- `manifest.json`: machine-readable inventory for tools and agents.",
            "",
            "## Recommended Entry Points",
            "",
            f"- {self._wiki_link(self.vault_root / 'Dashboards' / 'Home.md', 'Home Dashboard')}",
            f"- {self._wiki_link(self.vault_root / 'Dashboards' / 'Graph Index.md', 'Graph Index')}",
            f"- {self._wiki_link(self._todo_list_path(), TODO_TITLE)}",
            "",
            "## Current Snapshot",
            "",
            f"- Sessions: {len(sessions)}",
            f"- Saved sources: {len(source_captures)}",
            f"- Fact triplets: {triplet_count}",
            f"- Vault root: `{self.vault_root}`",
            "- Machine manifest: `manifest.json`",
            "",
            "## Notes",
            "",
            "- The processed note is the readable view of a conversation.",
            "- The matching source document is the canonical raw capture for auditing and reprocessing.",
            "- Git versioning is intended to track every vault change when git is available.",
            "",
        ]
        return "\n".join(lines).strip() + "\n"

    def _render_agents_guide(
        self,
        sessions: list[ChatSession],
        source_captures: list[SourceCapture],
        triplet_count: int,
    ) -> str:
        lines = [
            "# AGENTS",
            "",
            "Use this file as the first stop when a coding or reasoning agent is pointed at the SaveMyContext vault.",
            "",
            "## Ground Truth",
            "",
            "- `Sources/` contains the raw scraped content and raw payloads.",
            "- `Captures/` contains user-saved selections and full-page captures.",
            "- Processed pile notes summarize and organize those sources for reuse.",
            "- `Graph/` captures extracted entities and relationships for factual retrieval.",
            "- `Dashboards/To-Do List.md` is the single shared to-do file.",
            "",
            "## Suggested Retrieval Order",
            "",
            f"1. Open {self._wiki_link(self.vault_root / 'Dashboards' / 'Home.md', 'Home Dashboard')}.",
            f"2. Follow pile indexes or {self._wiki_link(self.vault_root / 'Dashboards' / 'Graph Index.md', 'Graph Index')}.",
            "3. When precision matters, open the linked source document and inspect the raw capture.",
            "4. If editing to-dos or notes, preserve structure and let git capture the revision.",
            "",
            "## Current Snapshot",
            "",
            f"- Sessions: {len(sessions)}",
            f"- Saved sources: {len(source_captures)}",
            f"- Fact triplets: {triplet_count}",
            "- Manifest: `manifest.json`",
            "",
            "## Authoring Rules",
            "",
            "- Do not overwrite source documents with summaries.",
            "- Keep links between processed notes and source documents intact.",
            "- Prefer appending clear, dated notes over destructive rewrites.",
            "",
        ]
        return "\n".join(lines).strip() + "\n"

    def _render_manifest_json(
        self,
        sessions: list[ChatSession],
        source_captures: list[SourceCapture],
        triplet_count: int,
    ) -> str:
        piles = {
            (built_in_pile.value if built_in_pile else "unclassified"): len(
                [session for session in sessions if session.built_in_pile == built_in_pile]
            )
            for built_in_pile in [*CATEGORY_LABELS.keys(), None]
        }
        manifest = {
            "generated_at": datetime_isoformat(datetime.now(timezone.utc)),
            "vault_root": str(self.vault_root),
            "entrypoints": {
                "home_dashboard": str(self.vault_root / "Dashboards" / "Home.md"),
                "readme": str(self.vault_root / "README.md"),
                "agents": str(self.vault_root / "AGENTS.md"),
                "todo_list": str(self._todo_list_path()),
                "graph_index": str(self.vault_root / "Dashboards" / "Graph Index.md"),
            },
            "counts": {
                "sessions": len(sessions),
                "source_captures": len(source_captures),
                "triplets": triplet_count,
                "providers": self._provider_counts(sessions),
                "piles": piles,
                "capture_kinds": {
                    "selection": len([capture for capture in source_captures if capture.capture_kind == "selection"]),
                    "page": len([capture for capture in source_captures if capture.capture_kind == "page"]),
                },
            },
        }
        return json.dumps(manifest, indent=2, sort_keys=True) + "\n"

    def _provider_counts(self, sessions: list[ChatSession]) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for session in sessions:
            counts[session.provider.value] += 1
        return dict(sorted(counts.items()))

    def _capture_slug_seed(self, source_capture: SourceCapture) -> str:
        return self._capture_display_title(source_capture)

    def _capture_display_title(self, source_capture: SourceCapture) -> str:
        return (
            source_capture.title
            or source_capture.page_title
            or take_sentences(source_capture.selection_text or source_capture.source_text, 1)
            or "Saved source"
        )

    @property
    def vault_root(self) -> Path:
        return self.base_dir / self.vault_root_name

    async def _commit_vault(self, session: ChatSession) -> None:
        message = f"Update vault for {session.provider.value}:{session.external_session_id}"
        if session.built_in_pile == BuiltInPileSlug.TODO:
            message = f"Update to-do list from {session.provider.value}:{session.external_session_id}"
        await GitVersioningService(repo_root=self.vault_root).commit_all(message=message)

    async def _commit_source_capture(self, source_capture: SourceCapture) -> None:
        message = f"Save {source_capture.capture_kind} source {source_capture.id[:8]}"
        await GitVersioningService(repo_root=self.vault_root).commit_all(message=message)
