from __future__ import annotations

import os

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.router import api_router
from app.db.session import get_db_session
from app.models import User
from app.models.base import Base
from app.services.auth import SYSTEM_SERVICE_OWNER_USERNAME, ensure_admin_user
from app.services.connection_grants import create_connection_grant, decode_connection_bundle


def _build_test_app(session_factory: async_sessionmaker) -> FastAPI:
    app = FastAPI()
    app.include_router(api_router, prefix="/api/v1")

    async def override_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_db_session
    return app


async def _create_admin(session_factory: async_sessionmaker) -> None:
    async with session_factory() as session:
        await ensure_admin_user(
            session,
            username="admin",
            password="correct horse battery staple",
        )


@pytest.mark.asyncio
async def test_shared_connection_string_redeems_to_a_normal_api_token(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-connection-grants.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    await _create_admin(session_factory)
    async with session_factory() as session:
        created = await create_connection_grant(
            session,
            username="admin",
            name="Shared Browser Bundle",
            base_url="https://notes.example.com",
            scopes=["ingest", "read"],
            security_level="shared",
        )

    decoded = decode_connection_bundle(created.connection_string)
    assert decoded.base_url == "https://notes.example.com"
    assert decoded.security_level == "shared"

    app = _build_test_app(session_factory)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://notes.example.com") as client:
        redeem_response = await client.post(
            "/api/v1/auth/connections/redeem",
            json={
                "grant_id": decoded.grant_id,
                "secret": decoded.secret,
                "installation_id": "install-alpha",
                "client_name": "Chrome macOS",
            },
        )

        assert redeem_response.status_code == 200
        payload = redeem_response.json()
        assert payload["security_level"] == "shared"
        assert payload["second_factor_mode"] == "none"
        assert payload["token"].startswith("savemycontext_pat_")

        verify_response = await client.get(
            "/api/v1/auth/token/verify",
            headers={"Authorization": f"Bearer {payload['token']}"},
        )

    assert verify_response.status_code == 200
    assert verify_response.json()["valid"] is True
    assert verify_response.json()["scopes"] == ["ingest", "read"]

    await engine.dispose()


@pytest.mark.asyncio
async def test_connection_grant_creation_can_self_manage_the_local_owner_account(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-connection-grants-managed-owner.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with session_factory() as session:
        created = await create_connection_grant(
            session,
            username=None,
            name="Shared Browser Bundle",
            base_url="https://notes.example.com",
            scopes=["ingest", "read"],
            security_level="shared",
        )
        assert created.connection_string.startswith("smc_conn_1_")

    async with session_factory() as session:
        user = await session.get(User, created.grant.user_id)
        assert user is not None
        assert user.username == SYSTEM_SERVICE_OWNER_USERNAME
        assert user.is_admin is True

    await engine.dispose()


@pytest.mark.asyncio
async def test_per_device_code_requires_a_second_factor_and_allows_only_one_redemption(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-connection-grants-code.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    await _create_admin(session_factory)
    async with session_factory() as session:
        created = await create_connection_grant(
            session,
            username="admin",
            name="Work Laptop",
            base_url="https://notes.example.com",
            scopes=["ingest", "read"],
            security_level="per_device_code",
            device_label="Work Laptop",
        )

    decoded = decode_connection_bundle(created.connection_string)
    assert created.verification_code is not None

    app = _build_test_app(session_factory)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://notes.example.com") as client:
        missing_code = await client.post(
            "/api/v1/auth/connections/redeem",
            json={
                "grant_id": decoded.grant_id,
                "secret": decoded.secret,
                "installation_id": "install-work-laptop",
            },
        )
        assert missing_code.status_code == 401
        assert missing_code.json()["detail"] == "A verification code is required."

        redeemed = await client.post(
            "/api/v1/auth/connections/redeem",
            json={
                "grant_id": decoded.grant_id,
                "secret": decoded.secret,
                "installation_id": "install-work-laptop",
                "verification_code": created.verification_code,
            },
        )
        assert redeemed.status_code == 200
        assert redeemed.json()["security_level"] == "per_device_code"

        reused = await client.post(
            "/api/v1/auth/connections/redeem",
            json={
                "grant_id": decoded.grant_id,
                "secret": decoded.secret,
                "installation_id": "install-work-laptop-2",
                "verification_code": created.verification_code,
            },
        )

    assert reused.status_code == 401
    assert reused.json()["detail"] == "Connection string has already been used."

    await engine.dispose()


@pytest.mark.asyncio
async def test_capabilities_redacts_storage_paths_for_remote_unauthenticated_requests(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capabilities.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    os.environ["SAVEMYCONTEXT_PUBLIC_URL"] = "https://notes.example.com"
    app = _build_test_app(session_factory)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://notes.example.com") as client:
        response = await client.get("/api/v1/meta/capabilities")

    assert response.status_code == 200
    payload = response.json()
    assert payload["storage"]["public_url"] == "https://notes.example.com"
    assert payload["storage"]["markdown_root"] is None
    assert payload["storage"]["vault_root"] is None

    await engine.dispose()


@pytest.mark.asyncio
async def test_capabilities_still_include_storage_paths_for_loopback_bootstrap_requests(tmp_path) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'savemycontext-capabilities-loopback.db'}")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    app = _build_test_app(session_factory)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:18888") as client:
        response = await client.get("/api/v1/meta/capabilities")

    assert response.status_code == 200
    payload = response.json()
    assert payload["storage"]["markdown_root"]
    assert payload["storage"]["vault_root"]

    await engine.dispose()
