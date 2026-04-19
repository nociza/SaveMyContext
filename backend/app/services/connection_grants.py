from __future__ import annotations

import base64
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import ConnectionGrant, User
from app.models.base import utcnow
from app.services.auth import CreatedToken, create_api_token, ensure_service_owner_user, hash_api_token_secret


ConnectionSecurityLevel = Literal["shared", "per_device", "per_device_code"]
SecondFactorMode = Literal["none", "one_time_code"]
CONNECTION_STRING_PREFIX = "smc_conn_1_"


@dataclass(frozen=True)
class CreatedConnectionGrant:
    grant: ConnectionGrant
    connection_string: str
    verification_code: str | None


@dataclass(frozen=True)
class DecodedConnectionBundle:
    version: int
    base_url: str
    grant_id: str
    secret: str
    security_level: ConnectionSecurityLevel


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")


def encode_connection_bundle(
    *,
    base_url: str,
    grant_id: str,
    secret: str,
    security_level: ConnectionSecurityLevel,
) -> str:
    payload = {
        "v": 1,
        "u": base_url.rstrip("/"),
        "g": grant_id,
        "s": secret,
        "l": security_level,
    }
    encoded = _base64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{CONNECTION_STRING_PREFIX}{encoded}"


def decode_connection_bundle(value: str) -> DecodedConnectionBundle:
    candidate = value.strip()
    if not candidate.startswith(CONNECTION_STRING_PREFIX):
        raise ValueError("Connection string has an unexpected prefix.")

    encoded_payload = candidate.removeprefix(CONNECTION_STRING_PREFIX)
    try:
        payload = json.loads(_base64url_decode(encoded_payload).decode("utf-8"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("Connection string could not be decoded.") from error

    if not isinstance(payload, dict):
        raise ValueError("Connection string payload must be an object.")

    version = payload.get("v")
    base_url = payload.get("u")
    grant_id = payload.get("g")
    secret = payload.get("s")
    security_level = payload.get("l")

    if version != 1:
        raise ValueError("Connection string version is not supported.")
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("Connection string is missing a backend URL.")
    if not isinstance(grant_id, str) or not grant_id.strip():
        raise ValueError("Connection string is missing a grant id.")
    if not isinstance(secret, str) or not secret.strip():
        raise ValueError("Connection string is missing a secret.")
    if security_level not in {"shared", "per_device", "per_device_code"}:
        raise ValueError("Connection string security level is not supported.")

    return DecodedConnectionBundle(
        version=1,
        base_url=base_url.rstrip("/"),
        grant_id=grant_id,
        secret=secret,
        security_level=security_level,
    )


def normalize_verification_code(value: str | None) -> str:
    return "".join((value or "").strip().upper().split())


def verification_code_required(security_level: ConnectionSecurityLevel) -> bool:
    return security_level == "per_device_code"


def build_verification_code() -> str:
    digits = "".join(secrets.choice("0123456789") for _ in range(8))
    return f"{digits[:4]}-{digits[4:]}"


async def create_connection_grant(
    db: AsyncSession,
    *,
    username: str | None,
    name: str,
    base_url: str,
    scopes: list[str],
    security_level: ConnectionSecurityLevel,
    device_label: str | None = None,
    expires_at: datetime | None = None,
) -> CreatedConnectionGrant:
    requested_username = (username or "").strip()
    if requested_username:
        result = await db.execute(select(User).where(User.username == requested_username))
        user = result.scalar_one_or_none()
        if user is None:
            raise RuntimeError(f"User not found: {requested_username}")
    else:
        user = await ensure_service_owner_user(db)

    secret = secrets.token_urlsafe(24)
    verification_code = build_verification_code() if verification_code_required(security_level) else None
    grant = ConnectionGrant(
        user_id=user.id,
        name=name.strip(),
        security_level=security_level,
        second_factor_mode="one_time_code" if verification_code else "none",
        device_label=device_label.strip() if device_label and device_label.strip() else None,
        secret_hash=hash_api_token_secret(secret),
        verification_code_hash=(
            hash_api_token_secret(normalize_verification_code(verification_code)) if verification_code else None
        ),
        scopes=sorted(set(scopes)),
        is_active=True,
        max_redemptions=None if security_level == "shared" else 1,
        redemption_count=0,
        expires_at=expires_at,
    )
    db.add(grant)
    await db.flush()
    await db.commit()
    await db.refresh(grant)

    connection_string = encode_connection_bundle(
        base_url=base_url,
        grant_id=grant.id,
        secret=secret,
        security_level=security_level,
    )
    return CreatedConnectionGrant(
        grant=grant,
        connection_string=connection_string,
        verification_code=verification_code,
    )


async def list_connection_grants(db: AsyncSession) -> list[ConnectionGrant]:
    result = await db.execute(select(ConnectionGrant).options(selectinload(ConnectionGrant.user)).order_by(ConnectionGrant.created_at.desc()))
    return list(result.scalars().all())


async def revoke_connection_grant(db: AsyncSession, *, grant_id: str) -> ConnectionGrant:
    result = await db.execute(select(ConnectionGrant).where(ConnectionGrant.id == grant_id))
    grant = result.scalar_one_or_none()
    if grant is None:
        raise RuntimeError(f"Connection grant not found: {grant_id}")
    grant.is_active = False
    grant.revoked_at = utcnow()
    await db.commit()
    await db.refresh(grant)
    return grant


def build_connection_grant_token_name(
    grant: ConnectionGrant,
    *,
    installation_id: str,
    client_name: str | None,
) -> str:
    if grant.device_label:
        return grant.device_label
    if client_name and client_name.strip():
        return f"{grant.name} [{client_name.strip()}]"
    return f"{grant.name} [{installation_id[:8]}]"


async def redeem_connection_grant(
    db: AsyncSession,
    *,
    grant_id: str,
    secret: str,
    installation_id: str,
    client_name: str | None,
    verification_code: str | None = None,
) -> tuple[ConnectionGrant, CreatedToken]:
    result = await db.execute(
        select(ConnectionGrant)
        .options(selectinload(ConnectionGrant.user))
        .where(ConnectionGrant.id == grant_id)
    )
    grant = result.scalar_one_or_none()
    if grant is None:
        raise RuntimeError("Connection string is invalid.")
    if not grant.is_active or grant.revoked_at is not None:
        raise RuntimeError("Connection string has been revoked.")
    if grant.expires_at is not None and grant.expires_at <= utcnow():
        raise RuntimeError("Connection string has expired.")
    if grant.secret_hash != hash_api_token_secret(secret):
        raise RuntimeError("Connection string is invalid.")
    if grant.max_redemptions is not None and grant.redemption_count >= grant.max_redemptions:
        raise RuntimeError("Connection string has already been used.")
    if grant.second_factor_mode == "one_time_code":
        normalized_code = normalize_verification_code(verification_code)
        if not normalized_code:
            raise RuntimeError("A verification code is required.")
        if grant.verification_code_hash != hash_api_token_secret(normalized_code):
            raise RuntimeError("The verification code is invalid.")

    token_name = build_connection_grant_token_name(
        grant,
        installation_id=installation_id,
        client_name=client_name,
    )
    created = await create_api_token(
        db,
        username=grant.user.username,
        name=token_name,
        scopes=grant.scopes,
    )
    grant.redemption_count += 1
    grant.last_used_at = utcnow()
    await db.commit()
    await db.refresh(grant)
    return grant, created


def parse_expiry_hours(hours: float | None) -> datetime | None:
    if hours is None:
        return None
    return utcnow() + timedelta(hours=hours)
