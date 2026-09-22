"""Explicit cold reads for full exports and offline reparse, not normal browsing."""
import asyncio
from contextlib import closing
import sqlite3

from sqlalchemy.orm.attributes import set_committed_value

from app.core.config import get_settings
from app.evidence.store import Archive, EvidenceUnavailable, resolve
from app.evidence.worker import database_path


async def hydrate_session(session):
    fields = [(row, field, row.evidence_ref)
              for rows, field in ((session.messages, "raw_payload"), (session.sync_events, "raw_capture"))
              for row in rows if row.evidence_ref and getattr(row, field) is None]
    if not fields:
        return
    config = get_settings().evidence_config
    if not config:
        raise EvidenceUnavailable()

    def fetch():
        archive, cache = Archive(config), {}
        with closing(sqlite3.connect(database_path().resolve().as_uri() + "?mode=ro", uri=True)) as db:
            return [resolve(db, archive, key, cache) for _, _, key in fields]

    values = await asyncio.to_thread(fetch)
    for (row, field, _), value in zip(fields, values, strict=True):
        # Hydration is read-only. Never accidentally reinsert raw JSON on commit.
        set_committed_value(row, field, value)
