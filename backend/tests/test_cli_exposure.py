from __future__ import annotations

from pathlib import Path

import pytest

from app.cli import main
from app.cli_config import load_cli_config
from app.cli_paths import CLIPaths, default_cli_paths
from app.cli_exposure import parse_tailscale_funnel_status_output


def configure_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> CLIPaths:
    config_home = tmp_path / ".config"
    data_home = tmp_path / ".local" / "share"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config_home))
    monkeypatch.setenv("XDG_DATA_HOME", str(data_home))
    return default_cli_paths()


def reset_runtime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(__import__("os").environ):
        if key.startswith("SAVEMYCONTEXT_") or key.startswith("OPENAI_") or key.startswith("OPENROUTER_"):
            monkeypatch.delenv(key, raising=False)


def test_parse_tailscale_funnel_status_output_handles_plain_text() -> None:
    urls = parse_tailscale_funnel_status_output(
        "Available on the internet:\nhttps://host.example.ts.net\n|-- / proxy http://127.0.0.1:18888"
    )
    assert urls == ["https://host.example.ts.net"]


def test_expose_enable_sets_public_url_and_prints_a_connection_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    reset_runtime_env(monkeypatch)
    paths = configure_xdg(monkeypatch, tmp_path)
    assert main(["config", "init"]) == 0

    monkeypatch.setattr("app.cli.enable_tailscale_funnel", lambda config: "https://host.example.ts.net")

    assert main(["expose", "enable", "--security", "shared"]) == 0

    config = load_cli_config(paths.config_path, paths=paths)
    output = capsys.readouterr().out

    assert config.public_url == "https://host.example.ts.net"
    assert "Remote exposure enabled." in output
    assert "smc_conn_1_" in output


def test_share_shortcut_sets_public_url_and_prints_a_connection_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    reset_runtime_env(monkeypatch)
    paths = configure_xdg(monkeypatch, tmp_path)
    assert main(["config", "init"]) == 0

    monkeypatch.setattr("app.cli.enable_tailscale_funnel", lambda config: "https://shared.example.ts.net")

    assert main(["share"]) == 0

    config = load_cli_config(paths.config_path, paths=paths)
    output = capsys.readouterr().out

    assert config.public_url == "https://shared.example.ts.net"
    assert "Remote exposure enabled." in output
    assert "smc_conn_1_" in output


def test_expose_bundle_create_can_emit_a_per_device_code_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    reset_runtime_env(monkeypatch)
    paths = configure_xdg(monkeypatch, tmp_path)
    assert main(["config", "init", "--public-url", "https://host.example.ts.net"]) == 0

    assert main(
        [
            "expose",
            "bundle",
            "create",
            "--security",
            "per_device_code",
            "--device-label",
            "Work Laptop",
        ]
    ) == 0

    output = capsys.readouterr().out
    assert "Connection bundle created." in output
    assert "Verification Code" in output
    assert "smc_conn_1_" in output


def test_invite_shortcut_can_emit_a_per_device_code_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    reset_runtime_env(monkeypatch)
    configure_xdg(monkeypatch, tmp_path)
    assert main(["config", "init", "--public-url", "https://host.example.ts.net"]) == 0

    assert main(["invite", "--security", "per_device_code", "--device", "Work Laptop"]) == 0

    output = capsys.readouterr().out
    assert "Connection bundle created." in output
    assert "Verification Code" in output
    assert "smc_conn_1_" in output
