import json
from pathlib import Path
import subprocess
import sys

import pytest

from app.workspace import publish
from app.workspace.store import digest


@pytest.fixture
def publishing(tmp_path, monkeypatch):
    repo = tmp_path / "site"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    publish.git(repo, "config", "user.name", "Synthetic test")
    publish.git(repo, "config", "user.email", "synthetic@example.invalid")
    target = repo / "public/data/articles.json"
    target.parent.mkdir(parents=True)
    target.write_text("[]\n")
    publish.git(repo, "add", ".")
    publish.git(repo, "commit", "-qm", "Initial fixture")
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
    publish.git(repo, "remote", "add", "origin", str(remote))
    branch = publish.git(repo, "branch", "--show-current")
    publish.git(repo, "push", "-u", "origin", branch)
    token = tmp_path / "private/token"
    token.parent.mkdir()
    token.write_text("fixture-only")
    monkeypatch.setenv("SMC_TOKEN_FILE", str(token))
    targets = token.parent / "targets.json"
    targets.write_text(
        json.dumps(
            {
                "test-site": {
                    "repository": str(repo),
                    "remote": "origin",
                    "url": str(remote),
                    "branch": branch,
                }
            }
        )
    )
    monkeypatch.setenv("SMC_PUBLISH_TARGETS_FILE", str(targets))
    public = {
        "format": "smc-article-v1",
        "title": "Test article",
        "slug": "test-article",
        "body": "Approved public prose.",
    }
    fingerprint = digest(["test-site", public])
    calls = []

    def request(path, **kwargs):
        calls.append(path)
        if path.endswith("/preview"):
            return {
                "content_hash": fingerprint,
                "destination": "test-site",
                "findings": [],
                "stale_sources": [],
                "payload": public,
            }
        if path.endswith("/export"):
            return {"id": "test-receipt", "payload": public}
        return {
            "status": "approved",
            "approval_hash": fingerprint,
            "version": 2,
            "stale_sources": [],
        }

    monkeypatch.setattr(publish, "request", request)
    real_run = subprocess.run

    def run(args, **kwargs):
        if args[0] == "npm":
            return subprocess.CompletedProcess(args, 0)
        return real_run(args, **kwargs)

    monkeypatch.setattr(publish.subprocess, "run", run)
    argv = [
        "publish",
        "test-draft",
        "--hash",
        fingerprint,
        "--destination",
        "test-site",
        "--site",
        str(repo),
    ]
    return repo, target, calls, argv, token.parent


def test_default_is_read_only_preview(publishing, monkeypatch, capsys):
    repo, target, calls, argv, private = publishing
    monkeypatch.setattr(sys, "argv", argv)
    publish.main()
    assert target.read_text() == "[]\n" and not publish.git(
        repo, "status", "--porcelain"
    )
    assert not any(p.endswith("/export") for p in calls)
    assert not (private / "publication-receipts").exists()
    assert json.loads(capsys.readouterr().out)["status"] == "preview"


def test_push_failure_resumes_same_commit_without_duplicate_export(
    publishing, monkeypatch
):
    repo, target, calls, argv, private = publishing
    monkeypatch.setattr(sys, "argv", [*argv, "--write", "--commit", "--push"])
    original = publish.git
    fail = True

    def git(path, *args):
        nonlocal fail
        if args[0] == "push" and fail:
            fail = False
            raise subprocess.CalledProcessError(1, "git push")
        return original(path, *args)

    monkeypatch.setattr(publish, "git", git)
    with pytest.raises(subprocess.CalledProcessError):
        publish.main()
    commit = original(repo, "rev-parse", "HEAD")
    publish.main()
    assert original(repo, "rev-parse", "HEAD") == commit
    assert len(json.loads(target.read_text())) == 1
    assert len([p for p in calls if p.endswith("/export")]) == 1
    receipt = json.loads(
        next((private / "publication-receipts").glob("*.json")).read_text()
    )
    assert receipt["status"] == "pushed"
    assert original(repo, "rev-list", "--count", "HEAD") == "2"


def test_unrelated_dirty_file_prevents_write(publishing, monkeypatch):
    repo, target, _, argv, _ = publishing
    (repo / "unrelated.txt").write_text("User work")
    monkeypatch.setattr(sys, "argv", [*argv, "--write"])
    with pytest.raises(ValueError, match="clean"):
        publish.main()
    assert target.read_text() == "[]\n"


def test_symlink_collection_is_rejected(publishing):
    repo, target, _, _, _ = publishing
    original = target.read_text()
    target.unlink()
    other = repo.parent / "unrelated.json"
    other.write_text(original)
    target.symlink_to(other)
    with pytest.raises(ValueError, match="regular file"):
        publish.collection(Path(repo))


def test_destination_binding_cannot_be_redirected(publishing, monkeypatch):
    repo, target, _, argv, _ = publishing
    publish.git(repo, "remote", "set-url", "origin", str(repo.parent / "other-remote"))
    monkeypatch.setattr(sys, "argv", [*argv, "--write"])
    with pytest.raises(ValueError, match="URL changed"):
        publish.main()
    assert target.read_text() == "[]\n"
