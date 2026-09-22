"""Explicit, resumable age-to-gzip conversion; no file deletion or key removal.

Supply an administrator-verified list of encrypted pack hashes (including orphans)
and a mixed-reader Archive configured with encryption=none. New pack bytes are
independently verified before changing catalog pointers. Existing raw references,
source history, and all encrypted packs remain untouched. Default is read-only.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from app.evidence.store import Archive, EvidenceUnavailable, canonical, valid_hash


def migrate_pack(database: Path, archive: Archive, old_key: str, *, apply=False):
    old_key = valid_hash(old_key)
    if archive.encryption != "none":
        raise ValueError("Destination must explicitly disable encryption")
    pack = archive.read_pack(old_key)
    mode = "rw" if apply else "ro"
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=" + mode, uri=True, timeout=30)) as db:
        before = db.execute("SELECT digest,plaintext_bytes FROM evidence_objects WHERE pack_hash=? ORDER BY digest", (old_key,)).fetchall()
        for key, size in before:
            if key not in pack["objects"] or len(canonical(pack["objects"][key])) != size:
                raise EvidenceUnavailable()
        if not apply:
            return {"catalog_objects": len(before), "pack_objects": len(pack["objects"]), "applied": False}
        new_key = archive.write_pack(pack)  # read-back is part of the write contract
        with db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT digest,plaintext_bytes FROM evidence_objects WHERE pack_hash=? ORDER BY digest", (old_key,)).fetchall()
            if current != before:
                raise RuntimeError("Catalog changed concurrently; retry without deleting either pack")
            db.execute("UPDATE evidence_objects SET pack_hash=? WHERE pack_hash=?", (new_key, old_key))
        return {"catalog_objects": len(before), "pack_objects": len(pack["objects"]), "applied": True,
                "old_pack": old_key, "new_pack": new_key}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--pack-list", required=True, type=Path, help="JSON array of inventoried encrypted pack hashes")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    keys = json.loads(args.pack_list.read_text())
    if not isinstance(keys, list):
        parser.error("Pack inventory must be a unique JSON list")
    keys = [valid_hash(key) for key in keys]
    if len(keys) != len(set(keys)):
        parser.error("Pack inventory must be unique")
    archive = Archive(args.config)
    for index, key in enumerate(keys, 1):
        result = migrate_pack(args.database, archive, key, apply=args.apply)
        print(json.dumps({"pack": index, "total": len(keys), **result}), flush=True)


if __name__ == "__main__":
    main()
