from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass

from app.cli_config import CLIConfig


TAILSCALE_PROVIDER = "tailscale-funnel"
HTTPS_URL_PATTERN = re.compile(r"https://[^\s|]+")


@dataclass(frozen=True)
class ExposureStatus:
    provider: str
    public_url: str | None


def ensure_tailscale_available() -> str:
    executable = shutil.which("tailscale")
    if not executable:
        raise RuntimeError("tailscale is not installed or not on PATH.")
    return executable


def run_tailscale_command(*args: str) -> subprocess.CompletedProcess[str]:
    executable = ensure_tailscale_available()
    return subprocess.run(
        [executable, *args],
        check=True,
        text=True,
        capture_output=True,
    )


def extract_https_urls_from_text(value: str) -> list[str]:
    return [match.rstrip("/").rstrip(".") for match in HTTPS_URL_PATTERN.findall(value)]


def extract_https_urls_from_json(payload: object) -> list[str]:
    urls: list[str] = []

    def visit(value: object) -> None:
        if isinstance(value, str):
            urls.extend(extract_https_urls_from_text(value))
            return
        if isinstance(value, dict):
            for nested in value.values():
                visit(nested)
            return
        if isinstance(value, list):
            for nested in value:
                visit(nested)

    visit(payload)
    deduped: list[str] = []
    for url in urls:
        if url not in deduped:
            deduped.append(url)
    return deduped


def parse_tailscale_funnel_status_output(stdout: str) -> list[str]:
    stdout = stdout.strip()
    if not stdout:
        return []
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return extract_https_urls_from_text(stdout)
    return extract_https_urls_from_json(payload)


def local_backend_target_url(config: CLIConfig) -> str:
    return f"http://127.0.0.1:{config.port}"


def enable_tailscale_funnel(config: CLIConfig) -> str:
    target_url = local_backend_target_url(config)
    result = run_tailscale_command("funnel", "--bg", "--yes", target_url)
    urls = extract_https_urls_from_text(result.stdout)
    if urls:
        return urls[0]
    status = tailscale_funnel_status()
    if status.public_url:
        return status.public_url
    raise RuntimeError("Tailscale Funnel did not report a public URL.")


def tailscale_funnel_status() -> ExposureStatus:
    result = run_tailscale_command("funnel", "status", "--json")
    urls = parse_tailscale_funnel_status_output(result.stdout)
    return ExposureStatus(
        provider=TAILSCALE_PROVIDER,
        public_url=urls[0] if urls else None,
    )


def disable_tailscale_funnel() -> None:
    run_tailscale_command("funnel", "reset")
