from __future__ import annotations

import re
from typing import Any

from app.models.enums import ProviderName


GEMINI_SCOPED_SESSION_RE = re.compile(r"^(u\d+)__.+$")


def _provider_value(provider: ProviderName | str | None) -> str:
    if isinstance(provider, ProviderName):
        return provider.value
    return str(provider or "").strip().lower()


def provider_display_name(provider: ProviderName | str | None) -> str:
    value = _provider_value(provider)
    if value == "chatgpt":
        return "ChatGPT"
    if value == "gemini":
        return "Gemini"
    if value == "grok":
        return "Grok"
    return value.title() if value else "Provider"


def default_account_key(provider: ProviderName | str | None) -> str:
    value = _provider_value(provider)
    return f"{value}:default" if value else "default"


def normalize_account_key(
    provider: ProviderName | str | None,
    account_key: str | None,
    external_session_id: str | None = None,
) -> str:
    provider_value = _provider_value(provider)
    cleaned = (account_key or "").strip().lower()
    if cleaned:
        return cleaned if ":" in cleaned else f"{provider_value}:{cleaned}" if provider_value else cleaned

    if provider_value == "gemini" and external_session_id:
        match = GEMINI_SCOPED_SESSION_RE.match(external_session_id.strip())
        if match:
            return f"gemini:{match.group(1)}"

    return default_account_key(provider)


def account_key_suffix(account_key: str | None) -> str:
    cleaned = (account_key or "").strip()
    return cleaned.split(":", 1)[1] if ":" in cleaned else cleaned


def account_label_for_key(provider: ProviderName | str | None, account_key: str | None) -> str:
    suffix = account_key_suffix(account_key)
    display = provider_display_name(provider)
    if not suffix or suffix == "default":
        return f"{display} account"
    if _provider_value(provider) == "gemini" and re.fullmatch(r"u\d+", suffix):
        return f"{display} {suffix}"
    return suffix


def normalize_account_label(
    provider: ProviderName | str | None,
    account_key: str | None,
    account_label: str | None,
) -> str:
    cleaned = (account_label or "").strip()
    return cleaned or account_label_for_key(provider, account_key)


def session_account_key(session: Any) -> str:
    return normalize_account_key(
        getattr(session, "provider", None),
        getattr(session, "account_key", None),
        getattr(session, "external_session_id", None),
    )


def session_account_label(session: Any) -> str:
    key = session_account_key(session)
    return normalize_account_label(getattr(session, "provider", None), key, getattr(session, "account_label", None))


def session_matches_account(session: Any, requested_account_key: str | None) -> bool:
    requested = (requested_account_key or "").strip().lower()
    if not requested:
        return True
    actual = session_account_key(session).lower()
    suffix = account_key_suffix(actual).lower()
    return requested == actual or requested == suffix
