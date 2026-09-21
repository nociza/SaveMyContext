from __future__ import annotations

import json
from uuid import uuid4

from sqlalchemy import inspect, text

from app.models.sync_event import raw_capture_hash
from app.services.piles import (
    BUILT_IN_SLUG_TO_CATEGORY,
    CATEGORY_TO_BUILT_IN_SLUG,
    DEFAULT_PILES,
)


def apply_schema_migrations(sync_connection) -> None:
    if sync_connection.dialect.name == "sqlite":
        sync_connection.exec_driver_sql(
            "CREATE VIRTUAL TABLE IF NOT EXISTS workspace_fts USING fts5(key UNINDEXED, title, body)"
        )
    inspector = inspect(sync_connection)
    table_names = set(inspector.get_table_names())
    is_postgresql = sync_connection.dialect.name == "postgresql"
    timestamp_type = "TIMESTAMP WITH TIME ZONE" if is_postgresql else "DATETIME"
    false_default = "FALSE" if is_postgresql else "0"
    true_default = "TRUE" if is_postgresql else "1"

    if "chat_sessions" in table_names:
        chat_columns = {column["name"] for column in inspector.get_columns("chat_sessions")}
        if "todo_summary" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN todo_summary TEXT")
        if "pile_id" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN pile_id VARCHAR(36)")
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_pile_id ON chat_sessions (pile_id)"
            )
        if "pile_assignment_locked" not in chat_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE chat_sessions ADD COLUMN pile_assignment_locked "
                f"BOOLEAN NOT NULL DEFAULT {false_default}"
            )
        if "projection_pending" not in chat_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE chat_sessions ADD COLUMN projection_pending "
                f"BOOLEAN NOT NULL DEFAULT {false_default}"
            )
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_projection_pending "
                "ON chat_sessions (projection_pending)"
            )
        if "processing_pending" not in chat_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE chat_sessions ADD COLUMN processing_pending "
                f"BOOLEAN NOT NULL DEFAULT {false_default}"
            )
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_processing_pending "
                "ON chat_sessions (processing_pending)"
            )
            if "chat_messages" in table_names:
                sync_connection.execute(
                    text(
                        "UPDATE chat_sessions SET processing_pending = :is_pending "
                        "WHERE EXISTS ("
                        "SELECT 1 FROM chat_messages "
                        "WHERE chat_messages.session_id = chat_sessions.id"
                        ") AND (last_processed_at IS NULL "
                        "OR (last_captured_at IS NOT NULL "
                        "AND last_processed_at < last_captured_at))"
                    ),
                    {"is_pending": True},
                )
        if "is_discarded" not in chat_columns:
            sync_connection.exec_driver_sql(
                f"ALTER TABLE chat_sessions ADD COLUMN is_discarded BOOLEAN NOT NULL DEFAULT {false_default}"
            )
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_is_discarded ON chat_sessions (is_discarded)"
            )
        if "discarded_reason" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN discarded_reason TEXT")
        sync_connection.execute(
            text(
                "UPDATE chat_sessions SET pile_assignment_locked = :is_locked "
                "WHERE classification_reason LIKE 'Manually assigned to pile %' "
                "OR discarded_reason LIKE 'Manually moved to Discarded.%'"
            ),
            {"is_locked": True},
        )
        if "pile_outputs" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN pile_outputs JSON")
        if "segments" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN segments JSON")
        if "account_key" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN account_key VARCHAR(255)")
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_account_key ON chat_sessions (account_key)"
            )
        if "account_label" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN account_label TEXT")
        if "last_snapshot_at" not in chat_columns:
            sync_connection.exec_driver_sql(
                f"ALTER TABLE chat_sessions ADD COLUMN last_snapshot_at {timestamp_type}"
            )
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_last_snapshot_at ON chat_sessions (last_snapshot_at)"
            )
        sync_connection.exec_driver_sql(
            "UPDATE chat_sessions SET last_snapshot_at = last_captured_at "
            "WHERE last_captured_at IS NOT NULL "
            "AND (last_snapshot_at IS NULL OR last_snapshot_at < last_captured_at)"
        )

    if "sync_events" in table_names:
        sync_event_columns = {column["name"] for column in inspector.get_columns("sync_events")}
        if "capture_hash" not in sync_event_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE sync_events ADD COLUMN capture_hash VARCHAR(64)"
            )
        _backfill_sync_event_hashes(sync_connection)
        sync_connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_events_session_capture_hash "
            "ON sync_events (session_id, capture_hash)"
        )

    if "source_captures" in table_names:
        capture_columns = {column["name"] for column in inspector.get_columns("source_captures")}
        if "capture_key" not in capture_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE source_captures ADD COLUMN capture_key VARCHAR(128)"
            )
        if "capture_payload_hash" not in capture_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE source_captures ADD COLUMN capture_payload_hash VARCHAR(64)"
            )
        capture_unique_columns = {
            tuple(constraint.get("column_names") or ())
            for constraint in inspector.get_unique_constraints("source_captures")
        }
        capture_unique_columns.update(
            tuple(index.get("column_names") or ())
            for index in inspector.get_indexes("source_captures")
            if index.get("unique")
        )
        if ("capture_key",) not in capture_unique_columns:
            sync_connection.exec_driver_sql(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_source_captures_capture_key "
                "ON source_captures (capture_key)"
            )
        if "pile_id" not in capture_columns:
            sync_connection.exec_driver_sql("ALTER TABLE source_captures ADD COLUMN pile_id VARCHAR(36)")
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_source_captures_pile_id ON source_captures (pile_id)"
            )
        if "is_discarded" not in capture_columns:
            sync_connection.exec_driver_sql(
                f"ALTER TABLE source_captures ADD COLUMN is_discarded BOOLEAN NOT NULL DEFAULT {false_default}"
            )
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_source_captures_is_discarded ON source_captures (is_discarded)"
            )

    if "prompt_templates" not in table_names:
        sync_connection.exec_driver_sql(
            f"""
            CREATE TABLE prompt_templates (
                id VARCHAR(36) NOT NULL PRIMARY KEY,
                "key" VARCHAR(128) NOT NULL,
                system_prompt TEXT NOT NULL,
                user_prompt TEXT NOT NULL,
                created_at {timestamp_type} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at {timestamp_type} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_prompt_template_key UNIQUE ("key")
            )
            """
        )
        sync_connection.exec_driver_sql(
            'CREATE INDEX IF NOT EXISTS ix_prompt_templates_key ON prompt_templates ("key")'
        )

    if "idea_projects" not in table_names:
        sync_connection.exec_driver_sql(
            f"""
            CREATE TABLE idea_projects (
                id VARCHAR(36) NOT NULL PRIMARY KEY,
                slug VARCHAR(64) NOT NULL,
                name VARCHAR(128) NOT NULL,
                description TEXT,
                is_active BOOLEAN NOT NULL DEFAULT {true_default},
                sort_order INTEGER NOT NULL DEFAULT 100,
                created_at {timestamp_type} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at {timestamp_type} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_idea_project_slug UNIQUE (slug)
            )
            """
        )
        sync_connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_idea_projects_slug ON idea_projects (slug)"
        )
        sync_connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_idea_projects_is_active ON idea_projects (is_active)"
        )

    if "piles" in inspector.get_table_names():
        _normalize_pile_kind_values(sync_connection)
        _seed_built_in_piles(sync_connection)
        _backfill_pile_id_from_category(sync_connection)


def _normalize_pile_kind_values(sync_connection) -> None:
    """Older builds inserted PileKind by `.value` (lowercase like 'built_in_ideas').
    SQLAlchemy's Enum column expects the enum NAME (uppercase like
    'BUILT_IN_IDEAS') when no `values_callable` is supplied. Convert any legacy
    rows in place so they read back without LookupError.
    """
    sync_connection.execute(
        text(
            "UPDATE piles SET kind = UPPER(kind) "
            "WHERE kind IN ('built_in_journal', 'built_in_factual', 'built_in_ideas', "
            "'built_in_todo', 'built_in_discarded', 'user_defined')"
        )
    )


def _backfill_sync_event_hashes(sync_connection) -> None:
    rows = sync_connection.execute(
        text(
            "SELECT id, session_id, raw_capture, capture_hash "
            "FROM sync_events ORDER BY created_at, id"
        )
    ).mappings().all()
    seen: set[tuple[str, str]] = {
        (str(row["session_id"]), str(row["capture_hash"]))
        for row in rows
        if row["capture_hash"] is not None
    }
    for row in rows:
        if row["capture_hash"] is not None or row["raw_capture"] is None:
            continue
        raw_capture = row["raw_capture"]
        if isinstance(raw_capture, str):
            try:
                raw_capture = json.loads(raw_capture)
            except json.JSONDecodeError:
                continue
        if not isinstance(raw_capture, (dict, list)):
            continue
        try:
            capture_hash = raw_capture_hash(raw_capture)
        except (TypeError, ValueError):
            # Retain malformed legacy audit evidence without letting it block
            # startup; new ingest requests reject non-JSON/NaN payloads.
            continue
        if capture_hash is None:
            continue
        identity = (str(row["session_id"]), capture_hash)
        if identity in seen:
            # Preserve legacy duplicate audit rows. NULL remains outside the
            # unique hash index and future identical captures still dedupe
            # against the representative row.
            continue
        sync_connection.execute(
            text("UPDATE sync_events SET capture_hash = :capture_hash WHERE id = :event_id"),
            {"capture_hash": capture_hash, "event_id": row["id"]},
        )
        seen.add(identity)


def _seed_built_in_piles(sync_connection) -> None:
    # SQLAlchemy stores Enum values by NAME (the python enum member name) when
    # `native_enum=False` and no `values_callable` is supplied. We mirror that
    # convention in raw inserts so SQLAlchemy can read the rows back as enums.
    for seed in DEFAULT_PILES:
        existing_id = sync_connection.execute(
            text("SELECT id FROM piles WHERE slug = :slug"),
            {"slug": seed.slug},
        ).scalar()
        if existing_id is not None:
            continue
        sync_connection.execute(
            text(
                """
                INSERT INTO piles (
                    id, slug, name, description, kind, folder_label,
                    attributes, pipeline_config,
                    is_active, is_visible_on_dashboard, sort_order,
                    created_at, updated_at
                ) VALUES (
                    :id, :slug, :name, :description, :kind, :folder_label,
                    :attributes, :pipeline_config,
                    :is_active, :is_visible_on_dashboard, :sort_order,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """
            ),
            {
                "id": str(uuid4()),
                "slug": seed.slug,
                "name": seed.name,
                "description": seed.description,
                "kind": seed.kind.name,
                "folder_label": seed.folder_label,
                "attributes": json.dumps(seed.attributes_list()),
                "pipeline_config": json.dumps(seed.pipeline_config),
                "is_active": True,
                "is_visible_on_dashboard": seed.is_visible_on_dashboard,
                "sort_order": seed.sort_order,
            },
        )


def _backfill_pile_id_from_category(sync_connection) -> None:
    rows = sync_connection.exec_driver_sql("SELECT slug, id FROM piles").fetchall()
    pile_id_by_slug = {slug: pile_id for slug, pile_id in rows}
    if not pile_id_by_slug:
        return

    for category, slug in CATEGORY_TO_BUILT_IN_SLUG.items():
        pile_id = pile_id_by_slug.get(slug)
        if pile_id is None:
            continue
        sync_connection.execute(
            text(
                "UPDATE chat_sessions SET pile_id = :pile_id "
                "WHERE pile_id IS NULL AND category = :category"
            ),
            {"pile_id": pile_id, "category": category.name},
        )
        sync_connection.execute(
            text(
                "UPDATE source_captures SET pile_id = :pile_id "
                "WHERE pile_id IS NULL AND category = :category"
            ),
            {"pile_id": pile_id, "category": category.name},
        )

    discarded_pile_id = pile_id_by_slug.get("discarded")
    if discarded_pile_id is not None:
        sync_connection.execute(
            text(
                "UPDATE chat_sessions SET is_discarded = :is_discarded, pile_id = :pile_id "
                "WHERE category = :category AND is_discarded = :was_discarded"
            ),
            {
                "pile_id": discarded_pile_id,
                "category": "DISCARDED",
                "is_discarded": True,
                "was_discarded": False,
            },
        )


# Re-exported for callers that want the slug map without importing piles directly.
__all__ = ["apply_schema_migrations", "BUILT_IN_SLUG_TO_CATEGORY"]
