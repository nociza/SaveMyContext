"""Optional static-site adapter. Dry-run by default; no summarizer credentials.

Fetch exact approved output from SMC, validate locally, then optionally commit and
push only the configured article collection. No arbitrary shell commands or paths
are accepted from a draft. A push receipt is not a deployment confirmation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import subprocess
from urllib.parse import quote

from app.services.files import atomic_write_text
from app.workspace.client import request
from app.workspace.editorial import privacy_findings
from app.workspace.store import digest


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.rstrip("\n")


def collection(repo: Path):
    repo = repo.resolve(strict=True)
    if Path(git(repo, "rev-parse", "--show-toplevel")).resolve() != repo:
        raise ValueError("Select the exact site Git root")
    target = repo / "public/data/articles.json"
    if (
        target.is_symlink()
        or target.resolve(strict=True) != target
        or not target.is_file()
    ):
        raise ValueError(
            "Article collection must be a regular file inside the selected site"
        )
    return repo, target


def merge_article(rows, payload):
    if (
        set(payload) != {"format", "title", "slug", "body"}
        or payload["format"] != "smc-article-v1"
    ):
        raise ValueError("Unsupported public article payload")
    if privacy_findings(payload):
        raise ValueError("Public copy contains privacy or executable-content findings")
    if not isinstance(rows, list) or any(
        not isinstance(r, dict) or "slug" not in r for r in rows
    ):
        raise ValueError("Invalid existing collection")
    if len({r["slug"] for r in rows}) != len(rows):
        raise ValueError("Duplicate article slugs")
    return (
        [payload if row["slug"] == payload["slug"] else row for row in rows]
        if any(row["slug"] == payload["slug"] for row in rows)
        else [*rows, payload]
    )


def destination_binding(repo, label):
    configured = os.environ.get("SMC_PUBLISH_TARGETS_FILE")
    if not configured:
        raise ValueError("Configure protected SMC_PUBLISH_TARGETS_FILE before writing")
    path = Path(configured).resolve(strict=True)
    if path.is_relative_to(repo):
        raise ValueError("Publication target bindings belong outside the public site")
    binding = json.loads(path.read_text()).get(label)
    if not isinstance(binding, dict) or set(binding) != {
        "repository",
        "remote",
        "url",
        "branch",
    }:
        raise ValueError("Unknown or invalid publication destination")
    if Path(binding["repository"]).resolve() != repo:
        raise ValueError("Destination approval does not match this site checkout")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", binding["remote"]) or binding[
        "remote"
    ].startswith("-"):
        raise ValueError("Invalid Git remote")
    git(repo, "check-ref-format", "refs/heads/" + binding["branch"])
    if git(repo, "remote", "get-url", "--push", binding["remote"]) != binding["url"]:
        raise ValueError("Destination Git URL changed; review the binding")
    return binding


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("draft_id")
    parser.add_argument("--hash", required=True, dest="content_hash")
    parser.add_argument("--destination", required=True)
    parser.add_argument("--site", type=Path, required=True)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--commit", action="store_true")
    parser.add_argument("--push", action="store_true")
    args = parser.parse_args()
    if args.commit and not args.write or args.push and not args.commit:
        parser.error("--push requires --commit; --commit requires --write")
    repo, target = collection(args.site)
    route = "/drafts/" + quote(args.draft_id, safe="")
    preview = request(route + "/preview")
    draft = request(route)
    if (
        preview["content_hash"] != args.content_hash
        or preview["destination"] != args.destination
        or draft["approval_hash"] != args.content_hash
        or draft["status"] != "approved"
        or preview["findings"]
        or preview["stale_sources"]
    ):
        raise ValueError(
            "Current exact-copy approval and clean privacy/source review are required"
        )
    before = target.read_text()
    rows = merge_article(json.loads(before), preview["payload"])
    after = json.dumps(rows, ensure_ascii=False, indent=2) + "\n"
    receipt_dir = (
        Path(os.environ["SMC_TOKEN_FILE"]).resolve().parent / "publication-receipts"
    )
    if receipt_dir.is_relative_to(repo):
        raise ValueError(
            "Private credentials and receipts must stay outside the public repository"
        )
    receipt_path = receipt_dir / (
        digest([str(repo), args.draft_id, args.content_hash]) + ".json"
    )
    previous = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
    if not args.write:
        print(
            json.dumps(
                {
                    "status": "preview",
                    "destination": args.destination,
                    "content_hash": args.content_hash,
                    "changes": before != after,
                    "path": "public/data/articles.json",
                }
            )
        )
        return
    binding = destination_binding(repo, args.destination)
    if previous and previous.get("target_hash") != digest(binding):
        raise ValueError("Publication target changed since recorded attempt")
    dirty = git(repo, "status", "--porcelain")
    own_retry = (
        previous
        and previous.get("status") == "written"
        and before == after
        and dirty
        in {
            " M public/data/articles.json",
            "M  public/data/articles.json",
            "MM public/data/articles.json",
        }
    )
    if dirty and not own_retry:
        raise ValueError("Site worktree must be clean, including unrelated files")
    if before == after:
        if not previous:
            print(json.dumps({"status": "already-present", "pushed": False}))
            return
        if (
            previous.get("commit")
            and git(repo, "rev-parse", "HEAD") != previous["commit"]
        ):
            raise ValueError(
                "HEAD changed since recorded publication; inspect before retrying"
            )
    else:
        receipt = request(
            route + "/export",
            method="POST",
            payload={
                "expected_version": draft["version"],
                "content_hash": args.content_hash,
            },
        )
        if receipt["payload"] != preview["payload"]:
            raise ValueError("Export changed after preview")
        atomic_write_text(target, after)
        try:
            subprocess.run(["npm", "run", "validate:content"], cwd=repo, check=True)
        except Exception:
            # Restore only the exact file bytes written by this invocation.
            if target.read_text() == after:
                atomic_write_text(target, before)
            raise
        previous = {
            "receipt": receipt["id"],
            "hash": args.content_hash,
            "destination": args.destination,
            "target_hash": digest(binding),
            "status": "written",
        }
        receipt_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        atomic_write_text(receipt_path, json.dumps(previous))
    if args.commit and not previous.get("commit"):
        git(repo, "add", "--", "public/data/articles.json")
        git(
            repo,
            "commit",
            "-m",
            f"Publish article {preview['payload']['slug']}",
            "--",
            "public/data/articles.json",
        )
        previous.update(commit=git(repo, "rev-parse", "HEAD"), status="committed")
        atomic_write_text(receipt_path, json.dumps(previous))
    if args.push:
        if not previous.get("commit"):
            raise ValueError("No recorded commit to push")
        current = request(route)
        if (
            current["approval_hash"] != args.content_hash
            or current["status"] != "approved"
            or current["stale_sources"]
        ):
            raise ValueError("Approval or evidence changed before push")
        # Ordinary non-force push; remote divergence fails safely.
        git(repo, "push", binding["remote"], "HEAD:refs/heads/" + binding["branch"])
        previous["status"] = "pushed"
        atomic_write_text(receipt_path, json.dumps(previous))
    print(json.dumps({**previous, "deployment_verified": False}))


if __name__ == "__main__":
    main()
