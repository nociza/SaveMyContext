#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any


SCHEMA_VERSION = "savemycontext.context.v1"
DEFAULT_BACKEND_URL = "http://127.0.0.1:18888"
DEFAULT_API_PREFIX = "/api/v1"


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def backend_url() -> str:
    return (
        os.environ.get("SAVEMYCONTEXT_BACKEND_URL")
        or os.environ.get("SMC_BACKEND_URL")
        or DEFAULT_BACKEND_URL
    ).rstrip("/")


def backend_token() -> str | None:
    return os.environ.get("SAVEMYCONTEXT_BACKEND_TOKEN") or os.environ.get("SMC_BACKEND_TOKEN")


def plugin_data_dir() -> Path:
    root = os.environ.get("CLAUDE_PLUGIN_DATA") or os.environ.get("PLUGIN_DATA")
    if root:
        return Path(root)
    return Path(os.environ.get("TMPDIR") or "/tmp") / "savemycontext-claude-plugin"


def save_offline_bundle(bundle: dict[str, Any], reason: str) -> Path:
    out_dir = plugin_data_dir() / "offline"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{bundle.get('provider', 'context')}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    payload = {"offline_reason": reason, "bundle": bundle}
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def copy_to_clipboard(text: str) -> tuple[bool, str | None]:
    commands: list[list[str]]
    if sys.platform == "darwin":
        commands = [["pbcopy"]]
    elif os.name == "nt":
        commands = [["clip"]]
    else:
        commands = [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]

    for command in commands:
        executable = command[0]
        if shutil.which(executable) is None:
            continue
        try:
            subprocess.run(
                command,
                input=text,
                text=True,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=5,
            )
            return True, None
        except (subprocess.SubprocessError, OSError) as error:
            return False, str(error)
    return False, "No clipboard command found. Tried pbcopy, clip, wl-copy, xclip, and xsel."


def post_context_import(bundle: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(bundle).encode("utf-8")
    request = urllib.request.Request(
        f"{backend_url()}{DEFAULT_API_PREFIX}/context/import",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    token = backend_token()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def title_from_markdown(markdown: str, fallback: str) -> str:
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()[:140] or fallback
        return stripped[:140]
    return fallback


def read_markdown(path: str | None) -> tuple[str, str | None]:
    if not path or path == "-":
        return sys.stdin.read(), None
    markdown_path = Path(path).expanduser()
    return markdown_path.read_text(encoding="utf-8", errors="replace"), str(markdown_path)


def parse_metadata_json(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("--metadata-json must decode to an object")
    return parsed


def bundle_from_markdown(
    markdown: str,
    *,
    provider: str,
    source_interface: str | None,
    session_id: str | None,
    title: str | None,
    cwd: str,
    markdown_path: str | None,
    metadata: dict[str, Any],
    custom_tags: list[str],
) -> dict[str, Any]:
    markdown = markdown.strip()
    if not markdown:
        raise ValueError("Markdown handoff is empty")
    captured_at = utcnow()
    provider_title = "Claude" if provider == "claude" else "Codex"
    external_session_id = session_id or stable_id(f"{provider}-markdown-session", f"{captured_at}:{markdown}")
    resolved_source_interface = source_interface or ("claude-code" if provider == "claude" else "codex-cli")
    tags = ["markdown-handoff", f"{provider}-markdown-dump"]
    tags.extend(custom_tags)
    merged_metadata = {
        "cwd": cwd,
        "handoff_format": "markdown",
        "handoff_author": provider,
        "markdown_path": markdown_path,
    }
    merged_metadata.update(metadata)

    return {
        "schema_version": SCHEMA_VERSION,
        "provider": provider,
        "external_session_id": external_session_id,
        "source_interface": resolved_source_interface,
        "account_key": f"{provider}:cli",
        "account_label": f"{provider_title} CLI",
        "title": title or title_from_markdown(markdown, f"{provider_title} markdown handoff"),
        "source_url": f"{provider}://{external_session_id}",
        "captured_at": captured_at,
        "custom_tags": sorted({tag for tag in tags if tag}),
        "metadata": merged_metadata,
        "artifacts": [
            {
                "kind": "handoff_markdown",
                "name": Path(markdown_path).name if markdown_path else f"{external_session_id}.md",
                "uri": markdown_path,
                "content_type": "text/markdown",
                "content": markdown,
            }
        ],
        "messages": [
            {
                "id": stable_id(f"{provider}-markdown", markdown),
                "role": "assistant",
                "content": markdown,
                "occurred_at": captured_at,
                "metadata": {
                    "source": "agent-authored-markdown",
                    "source_interface": resolved_source_interface,
                },
            }
        ],
        "handoff_markdown": markdown,
        "raw_transcript": None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload an agent-authored Markdown context handoff to SaveMyContext.")
    parser.add_argument("--markdown", help="Markdown file to upload. Omit or pass '-' to read stdin.")
    parser.add_argument("--provider", choices=["codex", "claude"], default="claude")
    parser.add_argument("--source-interface")
    parser.add_argument("--session-id")
    parser.add_argument("--title")
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--metadata-json")
    parser.add_argument("--custom-tag", action="append", default=[])
    parser.add_argument("--no-clipboard", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    markdown, markdown_path = read_markdown(args.markdown)
    bundle = bundle_from_markdown(
        markdown,
        provider=args.provider,
        source_interface=args.source_interface,
        session_id=args.session_id,
        title=args.title,
        cwd=args.cwd,
        markdown_path=markdown_path,
        metadata=parse_metadata_json(args.metadata_json),
        custom_tags=args.custom_tag,
    )
    if args.dry_run:
        print(json.dumps(bundle, indent=2, ensure_ascii=False))
        return 0
    clipboard_copied = False
    clipboard_error = None
    if not args.no_clipboard:
        clipboard_copied, clipboard_error = copy_to_clipboard(markdown)
    try:
        response = post_context_import(bundle)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        offline_path = save_offline_bundle(bundle, str(error))
        print(
            json.dumps(
                {
                    "offline_bundle": str(offline_path),
                    "error": str(error),
                    "clipboard_copied": clipboard_copied,
                    "clipboard_error": clipboard_error,
                },
                indent=2,
            )
        )
        return 1
    response["clipboard_copied"] = clipboard_copied
    if clipboard_error:
        response["clipboard_error"] = clipboard_error
    print(json.dumps(response, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
