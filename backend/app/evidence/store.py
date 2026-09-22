"""Encrypted, content-addressed packs with verified read-after-write.

No network mounts, plaintext spool files, or provider-specific schema. The
catalog belongs to SQLite; the remote archive contains immutable ciphertext.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

MAX_PACK = 32 * 1024 * 1024
MAX_WIRE = 48 * 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}\Z")


class EvidenceUnavailable(RuntimeError):
    def __init__(self):
        super().__init__("Evidence archive unavailable or verification failed; retry later.")


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def valid_hash(value: str) -> str:
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise EvidenceUnavailable()
    return value


class Archive:
    def __init__(self, config: Path):
        try:
            self.config = json.loads(config.read_text())
        except (OSError, ValueError, TypeError):
            raise EvidenceUnavailable() from None

    def _run(self, command, data: bytes) -> bytes:
        try:
            result = subprocess.run(command, input=data, capture_output=True, timeout=60)
            if result.returncode or len(result.stdout) > MAX_WIRE:
                raise EvidenceUnavailable()
            return result.stdout
        except (OSError, subprocess.TimeoutExpired):
            raise EvidenceUnavailable() from None

    def _request(self, request: dict) -> dict:
        try:
            command = self.config["transport_command"]
            if not isinstance(command, list) or not command:
                raise EvidenceUnavailable()
            response = json.loads(self._run(command, canonical(request)))
            if response.get("ok") is not True:
                raise EvidenceUnavailable()
            return response
        except (KeyError, ValueError, TypeError):
            raise EvidenceUnavailable() from None

    def _decrypt(self, ciphertext: bytes) -> dict:
        compressed = self._run(
            [self.config.get("age", "age"), "--decrypt", "-i", self.config["identity"]], ciphertext
        )
        # Bound decompression, including corrupted/malicious archive files.
        import io
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
                plain = stream.read(MAX_PACK + 1)
            if len(plain) > MAX_PACK:
                raise EvidenceUnavailable()
            pack = json.loads(plain)
            if pack.get("version") != 1 or not isinstance(pack.get("objects"), dict):
                raise EvidenceUnavailable()
            for key, value in pack["objects"].items():
                if valid_hash(key) != digest(canonical(value)):
                    raise EvidenceUnavailable()
            return pack
        except (ValueError, OSError, EOFError, TypeError):
            raise EvidenceUnavailable() from None

    def read_pack(self, key: str) -> dict:
        response = self._request({"op": "get", "key": valid_hash(key)})
        try:
            ciphertext = base64.b64decode(response["data"], validate=True)
            if digest(ciphertext) != key:
                raise EvidenceUnavailable()
            return self._decrypt(ciphertext)
        except (KeyError, ValueError, TypeError):
            raise EvidenceUnavailable() from None

    def write_pack(self, pack: dict) -> str:
        plain = canonical(pack)
        if len(plain) > MAX_PACK:
            raise EvidenceUnavailable()
        ciphertext = self._run(
            [self.config.get("age", "age"), "--encrypt", "-r", self.config["recipient"]],
            gzip.compress(plain, compresslevel=6, mtime=0),
        )
        key = digest(ciphertext)
        self._request({"op": "put", "key": key, "data": base64.b64encode(ciphertext).decode("ascii")})
        # A write acknowledgment alone never permits retiring inline evidence.
        if canonical(self.read_pack(key)) != plain:
            raise EvidenceUnavailable()
        return key


def resolve(db, archive: Archive, key: str, cache: dict | None = None):
    """Resolve a raw JSON value, failing explicitly rather than omitting evidence."""
    key = valid_hash(key)
    row = db.execute("SELECT pack_hash FROM evidence_objects WHERE digest=?", (key,)).fetchone()
    if row is None:
        raise EvidenceUnavailable()
    packs = cache if cache is not None else {}
    pack_key = row[0]
    if pack_key not in packs:
        packs[pack_key] = archive.read_pack(pack_key)
    try:
        return packs[pack_key]["objects"][key]
    except KeyError:
        raise EvidenceUnavailable() from None
