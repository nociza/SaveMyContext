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
ROLE_VALUES = {"user", "assistant", "system", "tool", "unknown"}


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def load_hook_input() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"raw_stdin": raw}
    return parsed if isinstance(parsed, dict) else {"raw_stdin": parsed}


def read_transcript(path: str | None) -> tuple[list[Any], Any | None]:
    if not path:
        return [], None
    transcript_path = Path(path).expanduser()
    if not transcript_path.exists() or not transcript_path.is_file():
        return [], None
    text = transcript_path.read_text(encoding="utf-8", errors="replace")
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed, parsed
        return [parsed], parsed
    except json.JSONDecodeError:
        pass

    records: list[Any] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            records.append(json.loads(stripped))
        except json.JSONDecodeError:
            records.append({"text": stripped})
    return records, records


def normalize_role(value: Any) -> str:
    if not isinstance(value, str):
        return "unknown"
    lowered = value.lower()
    if lowered in ROLE_VALUES:
        return lowered
    if lowered in {"human", "prompt"} or "user" in lowered:
        return "user"
    if "assistant" in lowered or "model" in lowered or "agent" in lowered:
        return "assistant"
    if "system" in lowered or "developer" in lowered:
        return "system"
    if "tool" in lowered or "function" in lowered:
        return "tool"
    return "unknown"


def first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def nested_get(record: dict[str, Any], *keys: str) -> Any:
    current: Any = record
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "\n".join(part for part in (flatten_text(item) for item in value) if part)
    if not isinstance(value, dict):
        return ""

    fragments: list[str] = []
    for key in ("text", "content", "markdown", "value", "body", "message", "output", "summary"):
        if key in value:
            fragment = flatten_text(value[key])
            if fragment:
                fragments.append(fragment)
    if fragments:
        return "\n".join(fragments)
    return ""


def coerce_datetime(value: Any) -> str | None:
    if isinstance(value, (int, float)):
        try:
            seconds = value / 1000 if value > 10_000_000_000 else value
            return dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = dt.datetime.fromisoformat(text)
        except ValueError:
            return value.strip()
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc).isoformat()
    return None


def candidate_record(record: dict[str, Any]) -> dict[str, Any]:
    message = record.get("message")
    if isinstance(message, dict) and any(key in message for key in ("role", "content", "text")):
        return message
    item = record.get("item")
    if isinstance(item, dict) and any(key in item for key in ("role", "content", "text")):
        return item
    return record


def build_message(record: dict[str, Any], index: int, provider: str) -> dict[str, Any] | None:
    candidate = candidate_record(record)
    role = normalize_role(
        first_string(
            candidate.get("role"),
            nested_get(candidate, "author", "role"),
            record.get("role"),
            record.get("type") if record.get("type") in ROLE_VALUES else None,
        )
    )
    content = flatten_text(candidate.get("content"))
    if not content:
        content = flatten_text(candidate.get("text"))
    if not content and candidate is not record:
        content = flatten_text(record.get("content")) or flatten_text(record.get("text"))
    if not content:
        return None

    raw_id = first_string(
        candidate.get("id"),
        candidate.get("message_id"),
        candidate.get("uuid"),
        record.get("id"),
        record.get("message_id"),
        record.get("item_id"),
        record.get("turn_id"),
    )
    message_id = raw_id or stable_id(f"{provider}-msg", f"{index}:{role}:{content}")
    parent_id = first_string(
        candidate.get("parent_id"),
        candidate.get("parentId"),
        record.get("parent_id"),
        record.get("parentId"),
    )
    occurred_at = coerce_datetime(
        candidate.get("timestamp")
        or candidate.get("created_at")
        or candidate.get("createdAt")
        or record.get("timestamp")
        or record.get("created_at")
        or record.get("createdAt")
    )
    metadata = {
        "transcript_index": index,
        "record_type": first_string(record.get("type"), candidate.get("type")),
    }
    return {
        "id": message_id,
        "parent_id": parent_id,
        "role": role,
        "content": content,
        "occurred_at": occurred_at,
        "metadata": {key: value for key, value in metadata.items() if value is not None},
        "raw_payload": record,
    }


def collect_messages(value: Any, provider: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    def visit(item: Any) -> None:
        if len(messages) >= 5000:
            return
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if not isinstance(item, dict):
            return

        built = build_message(item, len(messages) + 1, provider)
        if built:
            key = f"{built['id']}:{built['role']}:{hashlib.sha1(built['content'].encode('utf-8', errors='ignore')).hexdigest()}"
            if key not in seen_keys:
                seen_keys.add(key)
                messages.append(built)

        for nested in item.values():
            if isinstance(nested, (dict, list)):
                visit(nested)

    visit(value)
    return messages


def title_from_messages(messages: list[dict[str, Any]], fallback: str) -> str:
    for message in messages:
        if message.get("role") != "user":
            continue
        content = str(message.get("content") or "").strip()
        if content:
            first_line = content.splitlines()[0]
            return first_line[:140]
    return fallback


def bundle_from_hook(event: dict[str, Any], provider: str = "codex") -> dict[str, Any] | None:
    transcript_path = event.get("transcript_path")
    records, raw_transcript = read_transcript(transcript_path if isinstance(transcript_path, str) else None)
    messages = collect_messages(records, provider)
    last_assistant = event.get("last_assistant_message")
    if not messages and isinstance(last_assistant, str) and last_assistant.strip():
        messages.append(
            {
                "id": stable_id(f"{provider}-assistant", last_assistant),
                "role": "assistant",
                "content": last_assistant.strip(),
                "metadata": {"source": "last_assistant_message"},
            }
        )
    if not messages:
        return None

    session_id = str(event.get("session_id") or stable_id(f"{provider}-session", str(transcript_path or utcnow())))
    cwd = str(event.get("cwd") or "")
    cwd_name = Path(cwd).name if cwd else provider
    title = title_from_messages(messages, f"{provider.title()} session in {cwd_name}")
    return {
        "schema_version": SCHEMA_VERSION,
        "provider": provider,
        "external_session_id": session_id,
        "source_interface": f"{provider}-cli",
        "account_key": f"{provider}:cli",
        "account_label": f"{provider.title()} CLI",
        "title": title,
        "source_url": f"{provider}://{session_id}",
        "captured_at": utcnow(),
        "custom_tags": ["codex-hook" if provider == "codex" else f"{provider}-import"],
        "metadata": {
            "cwd": cwd,
            "model": event.get("model"),
            "permission_mode": event.get("permission_mode"),
            "turn_id": event.get("turn_id"),
            "hook_event_name": event.get("hook_event_name"),
            "transcript_path": transcript_path,
        },
        "artifacts": [
            {
                "kind": "transcript",
                "name": Path(str(transcript_path)).name if transcript_path else None,
                "uri": str(transcript_path) if transcript_path else None,
                "content_type": "application/jsonl",
            }
        ]
        if transcript_path
        else [],
        "messages": messages,
        "raw_transcript": raw_transcript if isinstance(raw_transcript, (dict, list)) else None,
    }


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
    source_interface: str | None = None,
    session_id: str | None = None,
    title: str | None = None,
    cwd: str | None = None,
    markdown_path: str | None = None,
    metadata: dict[str, Any] | None = None,
    custom_tags: list[str] | None = None,
) -> dict[str, Any]:
    markdown = markdown.strip()
    if not markdown:
        raise ValueError("Markdown handoff is empty")
    captured_at = utcnow()
    provider_title = "Codex" if provider == "codex" else "Claude"
    external_session_id = session_id or stable_id(f"{provider}-markdown-session", f"{captured_at}:{markdown}")
    resolved_title = title or title_from_markdown(markdown, f"{provider_title} markdown handoff")
    resolved_cwd = cwd or os.getcwd()
    resolved_source_interface = source_interface or ("codex-cli" if provider == "codex" else "claude-code")
    tags = ["markdown-handoff", f"{provider}-markdown-dump"]
    tags.extend(custom_tags or [])
    merged_metadata = {
        "cwd": resolved_cwd,
        "handoff_format": "markdown",
        "handoff_author": provider,
        "markdown_path": markdown_path,
    }
    if metadata:
        merged_metadata.update(metadata)

    return {
        "schema_version": SCHEMA_VERSION,
        "provider": provider,
        "external_session_id": external_session_id,
        "source_interface": resolved_source_interface,
        "account_key": f"{provider}:cli",
        "account_label": f"{provider_title} CLI",
        "title": resolved_title,
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


def backend_url() -> str:
    return (
        os.environ.get("SAVEMYCONTEXT_BACKEND_URL")
        or os.environ.get("SMC_BACKEND_URL")
        or DEFAULT_BACKEND_URL
    ).rstrip("/")


def backend_token() -> str | None:
    return os.environ.get("SAVEMYCONTEXT_BACKEND_TOKEN") or os.environ.get("SMC_BACKEND_TOKEN")


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


def plugin_data_dir() -> Path:
    root = os.environ.get("PLUGIN_DATA") or os.environ.get("CLAUDE_PLUGIN_DATA")
    if root:
        return Path(root)
    return Path(os.environ.get("TMPDIR") or "/tmp") / "savemycontext-codex-plugin"


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


def stop_success() -> None:
    sys.stdout.write(json.dumps({"continue": True, "suppressOutput": True}))


def handle_stop() -> int:
    event = load_hook_input()
    bundle = bundle_from_hook(event, "codex")
    if bundle:
        try:
            post_context_import(bundle)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            save_offline_bundle(bundle, str(error))
    stop_success()
    return 0


def handle_session_start() -> int:
    return 0


def write_bundle_files(bundle: dict[str, Any], out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    session = str(bundle.get("external_session_id") or "context")
    base = stable_id("bundle", session)
    json_path = out_dir / f"{base}.json"
    md_path = out_dir / f"{base}.md"
    handoff = render_handoff(bundle)
    bundle["handoff_markdown"] = handoff
    json_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False), encoding="utf-8")
    md_path.write_text(handoff, encoding="utf-8")
    return json_path, md_path


def render_handoff(bundle: dict[str, Any]) -> str:
    lines = [
        "# Context Handoff",
        "",
        f"- Schema: `{SCHEMA_VERSION}`",
        f"- Provider: `{bundle.get('provider')}`",
        f"- Interface: `{bundle.get('source_interface')}`",
        f"- Session: `{bundle.get('external_session_id')}`",
        "",
        "## Conversation",
        "",
    ]
    for index, message in enumerate(bundle.get("messages") or [], start=1):
        role = str(message.get("role") or "unknown").title()
        lines.extend([f"### {index}. {role}", str(message.get("content") or "").strip(), ""])
    return "\n".join(lines).rstrip() + "\n"


def export_command(args: argparse.Namespace) -> int:
    event = {
        "session_id": args.session_id,
        "transcript_path": args.transcript,
        "cwd": args.cwd or os.getcwd(),
        "model": args.model,
    }
    bundle = bundle_from_hook(event, args.provider)
    if bundle is None:
        print("No messages found in transcript.", file=sys.stderr)
        return 1
    json_path, md_path = write_bundle_files(bundle, Path(args.out_dir))
    print(json.dumps({"bundle": str(json_path), "handoff_markdown": str(md_path)}, indent=2))
    return 0


def import_command(args: argparse.Namespace) -> int:
    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    if "bundle" in bundle and isinstance(bundle["bundle"], dict):
        bundle = bundle["bundle"]
    response = post_context_import(bundle)
    print(json.dumps(response, indent=2))
    return 0


def dump_markdown_command(args: argparse.Namespace) -> int:
    markdown, markdown_path = read_markdown(args.markdown)
    bundle = bundle_from_markdown(
        markdown,
        provider=args.provider,
        source_interface=args.source_interface,
        session_id=args.session_id,
        title=args.title,
        cwd=args.cwd or os.getcwd(),
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


def main() -> int:
    parser = argparse.ArgumentParser(description="SaveMyContext Codex hook and context migration utility.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("session-start")
    subparsers.add_parser("stop")

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--transcript", required=True)
    export_parser.add_argument("--provider", choices=["codex", "claude"], default="codex")
    export_parser.add_argument("--session-id")
    export_parser.add_argument("--cwd")
    export_parser.add_argument("--model")
    export_parser.add_argument("--out-dir", default="savemycontext-context-bundles")

    import_parser = subparsers.add_parser("import")
    import_parser.add_argument("bundle")

    dump_parser = subparsers.add_parser("dump-markdown")
    dump_parser.add_argument("--markdown", help="Markdown file to upload. Omit or pass '-' to read stdin.")
    dump_parser.add_argument("--provider", choices=["codex", "claude"], default="codex")
    dump_parser.add_argument("--source-interface")
    dump_parser.add_argument("--session-id")
    dump_parser.add_argument("--title")
    dump_parser.add_argument("--cwd")
    dump_parser.add_argument("--metadata-json")
    dump_parser.add_argument("--custom-tag", action="append", default=[])
    dump_parser.add_argument("--no-clipboard", action="store_true")
    dump_parser.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()
    if args.command == "session-start":
        return handle_session_start()
    if args.command == "stop":
        return handle_stop()
    if args.command == "export":
        return export_command(args)
    if args.command == "import":
        return import_command(args)
    if args.command == "dump-markdown":
        return dump_markdown_command(args)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
