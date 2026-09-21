from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from httpx import ASGITransport, AsyncClient

from app.middleware.request_size import RequestSizeLimitMiddleware


async def test_request_size_middleware_rejects_declared_oversized_body() -> None:
    app = FastAPI()
    app.add_middleware(RequestSizeLimitMiddleware, max_body_bytes=8)

    @app.post("/payload")
    async def payload(request: Request):
        return {"size": len(await request.body())}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/payload", content=b"123456789")

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body is too large."}


async def test_request_size_middleware_allows_bounded_body() -> None:
    app = FastAPI()
    app.add_middleware(RequestSizeLimitMiddleware, max_body_bytes=8)

    @app.post("/payload")
    async def payload(request: Request):
        return {"size": len(await request.body())}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/payload", content=b"12345678")

    assert response.status_code == 200
    assert response.json() == {"size": 8}


async def test_request_size_middleware_rejects_chunked_body_even_when_route_does_not_read_it() -> None:
    app = FastAPI()
    app.add_middleware(RequestSizeLimitMiddleware, max_body_bytes=8)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    async def chunks():
        yield b"12345"
        yield b"6789"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.request("GET", "/health", content=chunks())

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body is too large."}


async def test_cors_wraps_early_request_size_rejections() -> None:
    allowed_origin = f"chrome-extension://{'a' * 32}"
    app = FastAPI()
    app.add_middleware(RequestSizeLimitMiddleware, max_body_bytes=8)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[allowed_origin],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.post("/payload")
    async def payload(request: Request):
        return {"size": len(await request.body())}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/payload",
            content=b"123456789",
            headers={"Origin": allowed_origin},
        )

    assert response.status_code == 413
    assert response.headers["Access-Control-Allow-Origin"] == allowed_origin
