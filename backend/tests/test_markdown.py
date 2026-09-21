from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import FactTriplet, SourceCapture, SyncEvent
from app.models.base import Base
from app.models import ChatMessage, ChatSession, MessageRole, ProviderName, BuiltInPileSlug
from app.services.markdown import MarkdownExporter


def test_markdown_renderer_includes_transcript() -> None:
    session = ChatSession(
        provider=ProviderName.CHATGPT,
        external_session_id="session-1",
        title="Test Session",
        built_in_pile=BuiltInPileSlug.JOURNAL,
        custom_tags=["daily"],
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = [
        ChatMessage(
            session_id="session-1",
            external_message_id="m-1",
            role=MessageRole.USER,
            content="Need to review the project plan.",
            sequence_index=1,
        )
    ]

    markdown = MarkdownExporter().render(session)
    assert "# Test Session" in markdown
    assert "## Source" in markdown
    assert "Source Document" in markdown
    assert "## Transcript" in markdown
    assert "Need to review the project plan." in markdown


def test_markdown_renderer_includes_todo_update_link() -> None:
    session = ChatSession(
        provider=ProviderName.GEMINI,
        external_session_id="todo-session-1",
        title="Update shared tasks",
        built_in_pile=BuiltInPileSlug.TODO,
        todo_summary="Added 'Buy milk' and marked 'File taxes' done.",
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = [
        ChatMessage(
            session_id="todo-session-1",
            external_message_id="m-1",
            role=MessageRole.USER,
            content="Add buy milk to my to-do list.",
            sequence_index=1,
        )
    ]

    markdown = MarkdownExporter().render(session)
    assert "## To-Do Update" in markdown
    assert "Buy milk" in markdown
    assert "Dashboards/To-Do List" in markdown
    assert "[[SaveMyContext/" not in markdown


def test_markdown_renderer_formats_idea_summary_for_humans() -> None:
    session = ChatSession(
        provider=ProviderName.GEMINI,
        external_session_id="idea-session-1",
        title="Idea Session",
        built_in_pile=BuiltInPileSlug.IDEAS,
        idea_summary={
            "core_idea": "Turn AI chats into organized notes.",
            "pros": ["Private by default", "Searchable knowledge"],
            "cons": ["Requires a local backend"],
            "next_steps": ["Test with real users"],
        },
        share_post="Turn your AI chats into organized notes without leaving them trapped in a vendor UI.",
        last_captured_at=datetime.now(timezone.utc),
    )

    markdown = MarkdownExporter().render(session)

    assert "### Core Idea" in markdown
    assert "- Private by default" in markdown
    assert "- Requires a local backend" in markdown
    assert "- Test with real users" in markdown
    assert "```json" not in markdown


def test_source_markdown_renderer_includes_raw_payloads_and_sync_captures() -> None:
    session = ChatSession(
        provider=ProviderName.GEMINI,
        external_session_id="source-session-1",
        title="Source Session",
        built_in_pile=BuiltInPileSlug.FACTUAL,
        source_url="https://gemini.google.com/app/source-session-1",
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = [
        ChatMessage(
            session_id="source-session-1",
            external_message_id="m-1",
            role=MessageRole.USER,
            content="Explain FastAPI and uvloop.",
            sequence_index=1,
            raw_payload={"messageId": "m-1", "chunks": ["Explain FastAPI and uvloop."]},
        )
    ]
    session.sync_events = [
        SyncEvent(
            session_id="source-session-1",
            message_count=1,
            raw_capture={"provider": "gemini", "snapshot": {"messages": 1}},
        )
    ]

    markdown = MarkdownExporter().render_source(session)

    assert "# Source Document: Source Session" in markdown
    assert "## Raw Sync Captures" in markdown
    assert "\"provider\": \"gemini\"" in markdown
    assert "## Raw Message Payloads" in markdown
    assert "\"messageId\": \"m-1\"" in markdown
    assert "Explain FastAPI and uvloop." in markdown


def test_session_note_paths_are_collision_safe_after_slugification(tmp_path) -> None:
    first = ChatSession(
        id="11111111-1111-4111-8111-111111111111",
        provider=ProviderName.GEMINI,
        external_session_id="a/b",
        title="Slash session",
        built_in_pile=BuiltInPileSlug.FACTUAL,
        last_captured_at=datetime.now(timezone.utc),
    )
    second = ChatSession(
        id="22222222-2222-4222-8222-222222222222",
        provider=ProviderName.GEMINI,
        external_session_id="a-b",
        title="Dash session",
        built_in_pile=BuiltInPileSlug.FACTUAL,
        last_captured_at=datetime.now(timezone.utc),
    )
    first.messages = []
    first.triplets = []
    first.sync_events = []
    second.messages = []
    second.triplets = []
    second.sync_events = []

    exporter = MarkdownExporter()
    exporter.base_dir = tmp_path / "markdown"
    exporter._ensure_directories()
    first_path = exporter._write_session_files(first)
    second_path = exporter._write_session_files(second)

    assert first_path != second_path
    assert first_path.exists()
    assert second_path.exists()
    assert "# Slash session" in first_path.read_text(encoding="utf-8")
    assert "# Dash session" in second_path.read_text(encoding="utf-8")
    assert exporter._source_note_path(first).exists()
    assert exporter._source_note_path(second).exists()


def test_session_path_cleanup_never_deletes_outside_the_vault(tmp_path) -> None:
    session_id = "44444444-4444-4444-8444-444444444444"
    session = ChatSession(
        id=session_id,
        provider=ProviderName.GEMINI,
        external_session_id="path-safety",
        title="Path safety",
        built_in_pile=BuiltInPileSlug.FACTUAL,
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = []
    session.triplets = []
    session.sync_events = []
    exporter = MarkdownExporter()
    exporter.base_dir = tmp_path / "markdown"
    exporter._ensure_directories()

    outside_owned_note = tmp_path / "outside-owned-session.md"
    outside_owned_note.write_text(
        f'---\nid: "{session_id}"\ntype: "session"\n---\n\n# Outside\n',
        encoding="utf-8",
    )
    session.markdown_path = str(outside_owned_note)

    exporter._write_session_files(session)

    assert outside_owned_note.exists()


def test_source_capture_path_cleanup_requires_owned_files_inside_the_vault(tmp_path) -> None:
    capture_id = "33333333-3333-4333-8333-333333333333"
    now = datetime.now(timezone.utc)
    capture = SourceCapture(
        id=capture_id,
        capture_kind="page",
        save_mode="raw",
        title="Path safety",
        source_text="Preserve the source evidence.",
        created_at=now,
        updated_at=now,
    )
    exporter = MarkdownExporter()
    exporter.base_dir = tmp_path / "markdown"
    exporter._ensure_directories()

    unmanaged_note = exporter.vault_root / "Captures" / "unmanaged-note.md"
    unmanaged_note.write_text("# Personal note\n", encoding="utf-8")
    outside_owned_source = tmp_path / "outside-owned-source.md"
    outside_owned_source.write_text(
        "\n".join(
            [
                "---",
                f'id: "savemycontext-capture-source-{capture_id}"',
                'type: "source_capture_source"',
                "---",
                "",
                "# Old source",
            ]
        ),
        encoding="utf-8",
    )
    capture.markdown_path = str(unmanaged_note)
    capture.raw_source_path = str(outside_owned_source)

    target, raw_target = exporter._write_source_capture_files(capture)

    assert target.exists()
    assert raw_target.exists()
    assert unmanaged_note.exists()
    assert outside_owned_source.exists()

    owned_old_note = exporter.vault_root / "Captures" / "owned-old-note.md"
    owned_old_note.write_text(
        "\n".join(
            [
                "---",
                f'id: "{capture_id}"',
                'type: "source_capture"',
                "---",
                "",
                "# Old capture",
            ]
        ),
        encoding="utf-8",
    )
    owned_old_source = exporter.vault_root / "Sources" / "owned-old-source.md"
    owned_old_source.write_text(
        "\n".join(
            [
                "---",
                f'id: "savemycontext-capture-source-{capture_id}"',
                'type: "source_capture_source"',
                "---",
                "",
                "# Old source",
            ]
        ),
        encoding="utf-8",
    )
    capture.markdown_path = str(owned_old_note)
    capture.raw_source_path = str(owned_old_source)

    exporter._write_source_capture_files(capture)

    assert not owned_old_note.exists()
    assert not owned_old_source.exists()


@pytest.mark.asyncio
async def test_graph_refresh_preserves_unmanaged_notes_and_retires_only_managed_files(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-managed-graph.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        exporter = MarkdownExporter(session)
        exporter.base_dir = tmp_path / "markdown"
        exporter._ensure_directories()
        unmanaged_entity = exporter.vault_root / "Graph" / "Entities" / "Personal Research.md"
        unmanaged_index = exporter.vault_root / "Graph" / "Indexes" / "My Index.md"
        unmanaged_entity.write_text("# Personal Research\n", encoding="utf-8")
        unmanaged_index.write_text("# My Index\n", encoding="utf-8")
        stale_managed_entity = exporter.vault_root / "Graph" / "Entities" / "stale--1234567890.md"
        stale_managed_entity.write_text(
            "---\n"
            'id: "savemycontext-entity-stale--1234567890"\n'
            'type: "entity"\n'
            "---\n\n"
            "# Stale\n",
            encoding="utf-8",
        )

        await exporter._write_graph_notes()

        assert unmanaged_entity.read_text(encoding="utf-8") == "# Personal Research\n"
        assert unmanaged_index.read_text(encoding="utf-8") == "# My Index\n"
        assert not stale_managed_entity.exists()
        entity_index = exporter.vault_root / "Graph" / "Indexes" / "Entity Index.md"
        relationship_index = exporter.vault_root / "Graph" / "Indexes" / "Relationship Index.md"
        assert 'id: "savemycontext-graph-index-entities"' in entity_index.read_text(encoding="utf-8")
        assert 'type: "graph_index"' in relationship_index.read_text(encoding="utf-8")

    await engine.dispose()


@pytest.mark.asyncio
async def test_graph_refresh_refuses_unmanaged_target_before_replacing_last_good_indexes(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-graph-collision.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        chat_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="graph-collision-session",
            title="Graph collision",
            built_in_pile=BuiltInPileSlug.FACTUAL,
            last_captured_at=datetime.now(timezone.utc),
        )
        chat_session.messages = []
        triplet = FactTriplet(
            session=chat_session,
            subject="Collision Entity",
            predicate="relates to",
            object="Other Entity",
            confidence=0.9,
        )
        chat_session.triplets = [triplet]
        session.add(chat_session)
        await session.flush()

        exporter = MarkdownExporter(session)
        exporter.base_dir = tmp_path / "markdown"
        exporter._ensure_directories()
        collision_path = exporter._entity_note_path("Collision Entity")
        collision_path.write_text("# User-owned collision\n", encoding="utf-8")
        entity_index = exporter.vault_root / "Graph" / "Indexes" / "Entity Index.md"
        relationship_index = exporter.vault_root / "Graph" / "Indexes" / "Relationship Index.md"
        old_entity_index = "# Entity Index\n\n- Total entities: 99\n"
        old_relationship_index = "# Relationship Index\n\n- Old | relation | preserved\n"
        entity_index.write_text(old_entity_index, encoding="utf-8")
        relationship_index.write_text(old_relationship_index, encoding="utf-8")

        with pytest.raises(FileExistsError, match="unmanaged graph note"):
            await exporter._write_graph_notes()

        assert collision_path.read_text(encoding="utf-8") == "# User-owned collision\n"
        assert entity_index.read_text(encoding="utf-8") == old_entity_index
        assert relationship_index.read_text(encoding="utf-8") == old_relationship_index

    await engine.dispose()


@pytest.mark.asyncio
async def test_markdown_export_handles_mixed_naive_and_aware_session_timestamps(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-markdown-timezones.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        aware_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="aware-session",
            title="Aware Session",
            built_in_pile=BuiltInPileSlug.FACTUAL,
            source_url="https://gemini.google.com/app/aware-session",
            last_captured_at=datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc),
        )
        naive_session = ChatSession(
            provider=ProviderName.GEMINI,
            external_session_id="naive-session",
            title="Naive Session",
            built_in_pile=BuiltInPileSlug.FACTUAL,
            source_url="https://gemini.google.com/app/naive-session",
            last_captured_at=datetime(2026, 4, 2, 11, 0),
        )
        aware_session.messages = []
        naive_session.messages = []
        aware_triplet = FactTriplet(
            session=aware_session,
            subject="FastAPI",
            predicate="uses",
            object="uvloop",
            confidence=0.8,
        )
        naive_triplet = FactTriplet(
            session=naive_session,
            subject="FastAPI",
            predicate="supports",
            object="ASGI",
            confidence=0.7,
        )
        aware_session.triplets = [aware_triplet]
        naive_session.triplets = [naive_triplet]
        session.add_all([aware_session, naive_session])
        await session.flush()

        aware_session.updated_at = datetime(2026, 4, 2, 12, 5, tzinfo=timezone.utc)
        naive_session.updated_at = datetime(2026, 4, 2, 11, 5)
        await session.flush()

        exporter = MarkdownExporter(session)
        exporter.base_dir = tmp_path / "markdown"

        output_path = await exporter.write_session(aware_session)
        entity_notes = sorted((exporter.vault_root / "Graph" / "Entities").glob("fastapi--*.md"))
        home_dashboard = exporter.vault_root / "Dashboards" / "Home.md"
        readme = exporter.vault_root / "README.md"
        agents = exporter.vault_root / "AGENTS.md"
        manifest = exporter.vault_root / "manifest.json"

        assert output_path.exists()
        assert len(entity_notes) == 1
        assert home_dashboard.exists()
        assert readme.exists()
        assert agents.exists()
        assert manifest.exists()
        entity_markdown = entity_notes[0].read_text(encoding="utf-8")
        home_markdown = home_dashboard.read_text(encoding="utf-8")
        agents_markdown = agents.read_text(encoding="utf-8")
        manifest_json = manifest.read_text(encoding="utf-8")
        assert "Aware Session" in entity_markdown
        assert "Naive Session" in entity_markdown
        assert "# SaveMyContext Home" in home_markdown
        assert "README" in home_markdown
        assert "# AGENTS" in agents_markdown
        assert "\"entrypoints\"" in manifest_json
        assert "\"home_dashboard\"" in manifest_json

    await engine.dispose()
