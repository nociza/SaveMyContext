"""Small agent-facing client. All state changes go through the shared API."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Redirect refused", headers, fp)


def request(path: str, *, method: str = "GET", payload=None, key: str | None = None):
    base = os.environ.get("SMC_API_URL") or os.environ.get("NEXUS_TODOS_API_URL")
    token_file = os.environ.get("SMC_TOKEN_FILE") or os.environ.get(
        "NEXUS_TODOS_API_TOKEN_FILE"
    )
    if not base or not token_file:
        raise ValueError(
            "Set SMC_API_URL and SMC_TOKEN_FILE to your private service and protected credential file."
        )
    if urlsplit(base).scheme not in {"https", "http"}:
        raise ValueError("Service URL must use HTTP or HTTPS")
    base = base.rstrip("/")
    if not base.endswith("/api/v1/workspace"):
        base += "/api/v1/workspace"
    token = Path(token_file).read_text().strip()
    if not token or len(token) > 4096:
        raise ValueError("Application credential is missing or invalid")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    req = Request(
        base + path,
        method=method,
        headers=headers,
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    with build_opener(NoRedirect).open(req, timeout=30) as response:
        content = response.read().decode()
        return (
            json.loads(content)
            if "json" in response.headers.get("content-type", "")
            else content
        )


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--mode", choices=["auto", "exact", "semantic"], default="auto")
    search.add_argument("--scope", choices=["all", "curated", "sources"], default="all")
    remember = sub.add_parser("remember")
    remember.add_argument("title")
    remember.add_argument("--text")
    remember.add_argument("--file", type=Path)
    remember.add_argument("--key")
    remember.add_argument("--project")
    source = sub.add_parser("source")
    source.add_argument("id")
    source.add_argument("--revision")
    sub.add_parser("inbox")
    review = sub.add_parser("review")
    review.add_argument("id")
    review.add_argument("action", choices=["accept", "dismiss"])
    review.add_argument("--version", required=True, type=int)
    projects = sub.add_parser("projects")
    projects.add_argument("--add")
    projects.add_argument("--description", default="")
    tasks = sub.add_parser("tasks")
    tasks.add_argument(
        "--status", choices=["open", "done", "archived", "all"], default="open"
    )
    add = sub.add_parser("add-task")
    add.add_argument("title")
    add.add_argument("--notes")
    add.add_argument("--due")
    add.add_argument("--remind-at")
    add.add_argument("--notify", action="store_true")
    add.add_argument("--list", default="Inbox")
    add.add_argument("--project")
    add.add_argument("--key")
    add.add_argument(
        "--priority", choices=["low", "normal", "high", "urgent"], default="normal"
    )
    for name in ["done", "reopen", "archive"]:
        action = sub.add_parser(name)
        action.add_argument("id", type=int)
        action.add_argument("--version", type=int, required=True)
    update = sub.add_parser("update-task")
    update.add_argument("id", type=int)
    update.add_argument("--version", type=int, required=True)
    update.add_argument("--title")
    update.add_argument("--notes")
    update.add_argument("--due")
    update.add_argument("--project")
    prefs = sub.add_parser("reminders")
    prefs.add_argument("--notifications", choices=["on", "off"])
    prefs.add_argument("--digest", choices=["on", "off"])
    prefs.add_argument("--time")
    prefs.add_argument("--timezone")
    sub.add_parser("export")
    return root


def execute(args):
    name = args.command
    if name == "status":
        return request("/overview")
    if name == "search":
        return request("/search?" + urlencode({"q": args.query, "mode": args.mode, "scope": args.scope}))
    if name == "remember":
        if bool(args.text) == bool(args.file):
            raise ValueError("Supply exactly one of --text or --file")
        body = args.file.read_text() if args.file else args.text
        return request(
            "/captures",
            method="POST",
            payload={
                "key": args.key or str(uuid4()),
                "title": args.title,
                "body": body,
                "project_id": args.project,
                "interface": "cli",
            },
        )
    if name == "source":
        return request(
            "/sources/"
            + quote(args.id, safe="")
            + ("?" + urlencode({"revision": args.revision}) if args.revision else "")
        )
    if name == "inbox":
        return request("/memories?status=suggested")
    if name == "review":
        return request(
            "/memories/" + quote(args.id, safe=""),
            method="PATCH",
            payload={
                "status": "accepted" if args.action == "accept" else "rejected",
                "expected_version": args.version,
            },
        )
    if name == "projects":
        return (
            request(
                "/projects",
                method="POST",
                payload={"name": args.add, "description": args.description},
            )
            if args.add
            else request("/projects")
        )
    if name == "tasks":
        return request("/tasks?" + urlencode({"status": args.status}))
    if name == "add-task":
        return request(
            "/tasks",
            method="POST",
            key=args.key or str(uuid4()),
            payload={
                "title": args.title,
                "notes": args.notes,
                "due_on": args.due,
                "remind_at": args.remind_at,
                "notify": args.notify,
                "list_name": args.list,
                "priority": args.priority,
                "project_id": args.project,
            },
        )
    if name in {"done", "reopen", "archive"}:
        return request(
            f"/tasks/{args.id}",
            method="PATCH",
            payload={
                "status": {"done": "done", "reopen": "open", "archive": "archived"}[
                    name
                ],
                "expected_version": args.version,
            },
        )
    if name == "update-task":
        fields = {
            "title": args.title,
            "notes": args.notes,
            "due_on": args.due,
            "project_id": args.project,
        }
        return request(
            f"/tasks/{args.id}",
            method="PATCH",
            payload={
                **{key: value for key, value in fields.items() if value is not None},
                "expected_version": args.version,
            },
        )
    if name == "reminders":
        fields = {
            "notifications_enabled": args.notifications == "on"
            if args.notifications
            else None,
            "daily_digest_enabled": args.digest == "on" if args.digest else None,
            "digest_time": args.time,
            "timezone": args.timezone,
        }
        values = {key: value for key, value in fields.items() if value is not None}
        return (
            request("/settings", method="PATCH", payload=values)
            if values
            else request("/settings")
        )
    if name == "export":
        return request("/export")
    raise ValueError("Unknown operation")


def main():
    args = parser().parse_args()
    try:
        result = execute(args)
    except HTTPError as exc:
        print(
            f"Workspace request failed ({exc.code}); no change was confirmed. Refresh before retrying.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    except (URLError, OSError):
        print("Workspace unavailable; no change was confirmed.", file=sys.stderr)
        raise SystemExit(1) from None
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
    print(
        json.dumps(result, ensure_ascii=False, indent=2)
        if not isinstance(result, str)
        else result
    )


if __name__ == "__main__":
    main()
