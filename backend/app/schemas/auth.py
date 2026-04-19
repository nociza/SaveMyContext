from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TokenVerifyResponse(BaseModel):
    valid: bool
    token_name: str | None = None
    scopes: list[str] = Field(default_factory=list)
    username: str | None = None


class APITokenRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    token_prefix: str
    scopes: list[str]
    is_active: bool
    last_used_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    updated_at: datetime


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    username: str
    is_admin: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime


ConnectionSecurityLevel = Literal["shared", "per_device", "per_device_code"]
SecondFactorMode = Literal["none", "one_time_code"]


class ConnectionGrantRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    security_level: ConnectionSecurityLevel
    second_factor_mode: SecondFactorMode
    device_label: str | None = None
    scopes: list[str]
    is_active: bool
    max_redemptions: int | None = None
    redemption_count: int
    expires_at: datetime | None = None
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ConnectionRedeemRequest(BaseModel):
    grant_id: str = Field(min_length=1)
    secret: str = Field(min_length=1)
    installation_id: str = Field(min_length=1, max_length=128)
    client_name: str | None = Field(default=None, max_length=128)
    verification_code: str | None = Field(default=None, max_length=64)


class ConnectionRedeemResponse(BaseModel):
    token: str
    token_id: str
    token_name: str
    scopes: list[str]
    security_level: ConnectionSecurityLevel
    second_factor_mode: SecondFactorMode
