import base64
from datetime import datetime, timezone
import json
import shutil
import sqlite3
import subprocess

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.evidence.receiver import archive_root, handle
from app.evidence.store import Archive, EvidenceUnavailable, canonical, digest, resolve
from app.evidence.worker import EvidenceQueueFull, transfer_batch
from app.models import ChatMessage, ChatSession, SyncEvent
from app.models.base import Base
from app.models.enums import MessageRole, ProviderName
from app.schemas.ingest import IngestDiffRequest, IngestMessage
from app.services.ingest import IngestService


class MemoryArchive:
    def __init__(self):
        self.packs = {}

    def write_pack(self, pack):
        key = digest(canonical(pack))
        self.packs[key] = pack
        return key

    def read_pack(self, key):
        return self.packs[key]


def database(tmp_path):
    path = tmp_path / "state.sqlite"
    with sqlite3.connect(path) as db:
        for table, column in (("sync_events", "raw_capture"), ("chat_messages", "raw_payload")):
            db.execute(f"CREATE TABLE {table} (id TEXT PRIMARY KEY,session_id TEXT,created_at TEXT,{column} TEXT,evidence_ref TEXT)")
            db.execute(f"INSERT INTO {table} VALUES ('one','session','2026-09-21',?,NULL)",
                       (json.dumps({"nested": ["private fixture", {"unicode": "茶"}]}),))
        db.execute("CREATE TABLE evidence_objects (digest TEXT PRIMARY KEY,pack_hash TEXT,plaintext_bytes INT,created_at TEXT,updated_at TEXT)")
    return path


def test_roundtrip_dedup_and_idempotency(tmp_path):
    path, archive = database(tmp_path), MemoryArchive()
    assert transfer_batch(path, archive) == {"archived": 2, "pending_bytes": 0}
    assert len(archive.packs) == 1
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM evidence_objects").fetchone()[0] == 1
        raw, key = db.execute("SELECT raw_capture,evidence_ref FROM sync_events").fetchone()
        assert raw is None
        assert resolve(db, archive, key) == {"nested": ["private fixture", {"unicode": "茶"}]}
    assert transfer_batch(path, archive)["archived"] == 0


def test_transfer_failure_retains_inline_evidence(tmp_path):
    path = database(tmp_path)
    class Offline(MemoryArchive):
        def write_pack(self, pack):
            raise EvidenceUnavailable()
    with pytest.raises(EvidenceUnavailable):
        transfer_batch(path, Offline())
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT raw_capture IS NOT NULL FROM sync_events").fetchone()[0]
        assert db.execute("SELECT count(*) FROM evidence_objects").fetchone()[0] == 0


def test_concurrent_new_capture_is_not_removed(tmp_path):
    path = database(tmp_path)
    class Racing(MemoryArchive):
        def write_pack(self, pack):
            with sqlite3.connect(path) as db:
                db.execute("UPDATE chat_messages SET raw_payload=?", (json.dumps({"new": True}),))
            return super().write_pack(pack)
    assert transfer_batch(path, Racing())["archived"] == 1
    with sqlite3.connect(path) as db:
        raw, ref = db.execute("SELECT raw_payload,evidence_ref FROM chat_messages").fetchone()
        assert json.loads(raw) == {"new": True}
        assert ref is None


def test_receiver_immutable_and_bounded_paths(tmp_path):
    data = b"encrypted-test-fixture"
    key = digest(data)
    request = {"op": "put", "key": key, "data": base64.b64encode(data).decode()}
    assert handle(tmp_path, request)["ok"]
    assert handle(tmp_path, request)["ok"]
    assert base64.b64decode(handle(tmp_path, {"op": "get", "key": key})["data"]) == data
    with pytest.raises(ValueError):
        handle(tmp_path, {**request, "key": "../../escape"})
    with pytest.raises(ValueError):
        handle(tmp_path, {**request, "data": base64.b64encode(b"changed").decode()})
    with pytest.raises(ValueError):
        handle(tmp_path, {"op": "delete", "key": key})
    (tmp_path / (key + ".json.gz.age")).write_bytes(b"corrupt")
    with pytest.raises(ValueError):
        handle(tmp_path, request)


def test_missing_or_wrong_volume_never_creates_root(tmp_path, monkeypatch):
    import plistlib
    from types import SimpleNamespace
    mount = tmp_path / "mount"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=plistlib.dumps({
        "VolumeUUID": "wrong", "MountPoint": str(mount), "Mounted": True,
    })))
    with pytest.raises(ValueError):
        archive_root({"mount": str(mount), "volume_uuid": "expected", "relative_root": "archive"})
    assert not mount.exists()


@pytest.mark.skipif(not shutil.which("age-keygen"), reason="age optional outside deployment")
def test_real_age_roundtrip_readback_and_corruption(tmp_path, monkeypatch):
    identity = tmp_path / "key"
    subprocess.run(["age-keygen", "-o", str(identity)], check=True, capture_output=True)
    recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True).stdout.strip()
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"identity": str(identity), "recipient": recipient}))
    archive = Archive(config)
    root = tmp_path / "objects"
    root.mkdir()
    monkeypatch.setattr(archive, "_request", lambda request: handle(root, request))
    value = {"nested": {"list": [1, "秘密", None]}}
    pack = {"version": 1, "objects": {digest(canonical(value)): value}}
    key = archive.write_pack(pack)
    assert archive.read_pack(key) == pack
    assert b"nested" not in (root / (key + ".json.gz.age")).read_bytes()
    monkeypatch.setattr(archive, "read_pack", lambda key: {"wrong": True})
    with pytest.raises(EvidenceUnavailable):
        archive.write_pack(pack)


@pytest.mark.asyncio
async def test_archived_ingest_replay_change_and_queue_limit(tmp_path, monkeypatch):
    path = tmp_path / "state.sqlite"
    monkeypatch.setenv("SAVEMYCONTEXT_WORKSPACE_ENABLED", "true")
    monkeypatch.setenv("SAVEMYCONTEXT_EVIDENCE_CONFIG", str(tmp_path / "config.json"))
    monkeypatch.setenv("SAVEMYCONTEXT_DATABASE_URL", f"sqlite+aiosqlite:///{path}")
    get_settings.cache_clear()
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.exec_driver_sql("CREATE VIRTUAL TABLE workspace_fts USING fts5(key UNINDEXED,title,body)")
    archive = MemoryArchive()
    def payload(minute=0, raw=None):
        return IngestDiffRequest(provider=ProviderName.CHATGPT, external_session_id="fixture",
            sync_mode="full_snapshot", capture_completeness="complete", captured_at=datetime(2026, 9, 21, 0, minute, tzinfo=timezone.utc),
            messages=[IngestMessage(external_message_id="user", role=MessageRole.USER, content="A real test question", raw_payload=raw or {"nested": [1, 2]}),
                      IngestMessage(external_message_id="assistant", role=MessageRole.ASSISTANT, content="A real test answer")],
            raw_capture={"fixture": True})
    try:
        async with sessions() as db:
            session, count = await IngestService(db).ingest(payload())
            session_id = session.id
            assert count == 2
        assert transfer_batch(path, archive)["archived"] == 2
        from app.evidence import resolve as resolver
        from app.services.context_migration import ContextMigrationService
        monkeypatch.setattr(resolver, "Archive", lambda config: archive)
        async with sessions() as db:
            bundle = await ContextMigrationService(db).export_session(session_id)
            assert bundle.messages[0].raw_payload == {"nested": [1, 2]}
            assert bundle.sync_events[0].raw_capture == {"fixture": True}
            await db.commit()
        with sqlite3.connect(path) as db:
            assert db.execute("SELECT raw_payload FROM chat_messages WHERE external_message_id='user'").fetchone()[0] is None
        async with sessions() as db:
            _, count = await IngestService(db).ingest(payload(1))
            assert count == 0
            row = await db.scalar(select(ChatMessage).where(ChatMessage.external_message_id == "user"))
            assert row.evidence_ref and row.raw_payload is None
        async with sessions() as db:
            await IngestService(db).ingest(payload(2, {"new": "changed"}))
            row = await db.scalar(select(ChatMessage).where(ChatMessage.external_message_id == "user"))
            assert row.evidence_ref is None and row.raw_payload == {"new": "changed"}
        transfer_batch(path, archive)
        monkeypatch.setenv("SAVEMYCONTEXT_EVIDENCE_QUEUE_BYTES", "1024")
        get_settings.cache_clear()
        async with sessions() as db:
            with pytest.raises(EvidenceQueueFull):
                await IngestService(db).ingest(payload(3, {"large": "x" * 2048}))
        async with sessions() as db:
            row = await db.scalar(select(ChatMessage).where(ChatMessage.external_message_id == "user"))
            assert row.raw_payload is None and row.evidence_ref == digest(canonical({"new": "changed"}))
            assert (await db.get(ChatSession, session_id)).last_captured_at.minute == 2
            assert len(list((await db.scalars(select(SyncEvent))).all())) == 1
    finally:
        await engine.dispose()


def test_missing_catalog_and_corrupt_lookup_fail_closed(tmp_path):
    path, archive = database(tmp_path), MemoryArchive()
    with sqlite3.connect(path) as db:
        with pytest.raises(EvidenceUnavailable):
            resolve(db, archive, "a" * 64)
        with pytest.raises(EvidenceUnavailable):
            resolve(db, archive, "../escape")
    transfer_batch(path, archive)
    with sqlite3.connect(path) as db:
        key = db.execute("SELECT digest FROM evidence_objects").fetchone()[0]
        next(iter(archive.packs.values()))["objects"].clear()
        with pytest.raises(EvidenceUnavailable):
            resolve(db, archive, key)


def test_deduplicated_receipt_must_still_exist_remotely(tmp_path):
    path, archive = database(tmp_path), MemoryArchive()
    transfer_batch(path, archive)
    with sqlite3.connect(path) as db:
        db.execute("UPDATE chat_messages SET raw_payload=?,evidence_ref=NULL", (json.dumps({"nested": ["private fixture", {"unicode": "茶"}]}),))
    next(iter(archive.packs.values()))["objects"].clear()
    with pytest.raises(EvidenceUnavailable):
        transfer_batch(path, archive)
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT raw_payload IS NOT NULL FROM chat_messages").fetchone()[0]


@pytest.mark.asyncio
async def test_additive_schema_migration_is_repeatable(tmp_path):
    from app.db.migrations import apply_schema_migrations
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'old.sqlite'}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await connection.exec_driver_sql("ALTER TABLE sync_events DROP COLUMN evidence_ref")
            await connection.exec_driver_sql("ALTER TABLE chat_messages DROP COLUMN evidence_ref")
            await connection.run_sync(apply_schema_migrations)
            await connection.run_sync(apply_schema_migrations)
            columns = (await connection.exec_driver_sql("PRAGMA table_info(chat_messages)")).all()
            assert "evidence_ref" in {row[1] for row in columns}
            await connection.exec_driver_sql("INSERT INTO chat_sessions (id,provider,external_session_id,created_at,updated_at,custom_tags,pile_outputs,is_discarded,pile_assignment_locked,processing_pending,projection_pending) VALUES ('s','CHATGPT','s',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'[]','{}',0,0,0,0)")
            await connection.exec_driver_sql("INSERT INTO chat_messages (id,session_id,external_message_id,role,content,sequence_index,created_at,updated_at,evidence_ref) VALUES ('m','s','m','USER','text',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'old')")
            await connection.exec_driver_sql("UPDATE chat_messages SET raw_payload='{}' WHERE id='m'")
            assert (await connection.exec_driver_sql("SELECT evidence_ref FROM chat_messages")).scalar() is None
    finally:
        await engine.dispose()
