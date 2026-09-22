"""Stdlib-only forced-command receiver. No shell, arbitrary paths, or deletion.

Install a private JSON config and invoke with that fixed config in authorized_keys.
Every request validates the mounted macOS volume UUID before accessing the root.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile

MAX_WIRE = 48 * 1024 * 1024
MAX_OBJECT = 32 * 1024 * 1024


def archive_root(config: dict) -> Path:
    mount = Path(config["mount"])
    result = subprocess.run(["/usr/sbin/diskutil", "info", "-plist", str(mount)],
                            capture_output=True, check=True, timeout=15)
    info = plistlib.loads(result.stdout)
    if (info.get("VolumeUUID", "").upper() != config["volume_uuid"].upper()
            or info.get("MountPoint") != str(mount)):
        raise ValueError("Wrong or missing archive volume")
    relative = Path(config["relative_root"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Unsafe archive root")
    root = mount
    for part in relative.parts:
        root = root / part
        if root.is_symlink():
            raise ValueError("Symlink in archive root")
    if not root.is_dir():
        raise ValueError("Archive root must be provisioned explicitly")
    return root


def handle(root: Path, request: dict) -> dict:
    key = request.get("key", "")
    if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{64}", key):
        raise ValueError("Invalid key")
    encoding = request.get("encoding", "gzip+age")
    if encoding not in ("gzip", "gzip+age"):
        raise ValueError("Unsupported encoding")
    if request.get("op") == "get" and "encoding" not in request:
        encoding = "gzip" if (root / (key + ".json.gz")).exists() else "gzip+age"
    target = root / (key + (".json.gz" if encoding == "gzip" else ".json.gz.age"))
    if target.is_symlink():
        raise ValueError("Symlink object")
    if request.get("op") == "put":
        data = base64.b64decode(request["data"], validate=True)
        if len(data) > MAX_OBJECT or hashlib.sha256(data).hexdigest() != key:
            raise ValueError("Invalid object")
        if not target.exists():
            fd, temporary = tempfile.mkstemp(prefix=".incoming-", dir=root)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, target)  # immutable, atomic, no overwrite
                except FileExistsError:
                    pass
                directory = os.open(root, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                os.unlink(temporary)
        if target.read_bytes() != data:
            raise ValueError("Object collision or corruption")
        return {"ok": True, "encoding": encoding}
    if request.get("op") == "get":
        with target.open("rb") as stream:
            data = stream.read(MAX_OBJECT + 1)
        if len(data) > MAX_OBJECT or hashlib.sha256(data).hexdigest() != key:
            raise ValueError("Corrupt object")
        return {"ok": True, "encoding": encoding, "data": base64.b64encode(data).decode("ascii")}
    raise ValueError("Unsupported operation")


def main():
    os.umask(0o077)
    try:
        if len(sys.argv) != 2 or os.environ.get("SSH_ORIGINAL_COMMAND", "") not in ("", "smc-evidence-v1"):
            raise ValueError("Invalid invocation")
        config = json.loads(Path(sys.argv[1]).read_text())
        raw = sys.stdin.buffer.read(MAX_WIRE + 1)
        if len(raw) > MAX_WIRE:
            raise ValueError("Request too large")
        response = handle(archive_root(config), json.loads(raw))
        print(json.dumps(response, separators=(",", ":")))
    except Exception:
        print('{"ok":false,"error":"archive unavailable"}')
        sys.exit(1)


if __name__ == "__main__":
    main()
