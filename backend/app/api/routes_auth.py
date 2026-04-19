from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_bearer_token_context, require_scope
from app.db.session import get_db_session
from app.models import APIToken
from app.schemas.auth import APITokenRead, ConnectionRedeemRequest, ConnectionRedeemResponse, TokenVerifyResponse
from app.services.connection_grants import redeem_connection_grant


router = APIRouter()


@router.get("/auth/token/verify", response_model=TokenVerifyResponse)
async def verify_token(context: AuthContext = Depends(require_bearer_token_context)) -> TokenVerifyResponse:
    return TokenVerifyResponse(
        valid=True,
        token_name=context.token_name,
        scopes=sorted(context.scopes),
        username=context.username,
    )


@router.get("/auth/tokens", response_model=list[APITokenRead])
async def list_tokens(
    _: AuthContext = Depends(require_scope("admin")),
    db: AsyncSession = Depends(get_db_session),
) -> list[APITokenRead]:
    result = await db.execute(select(APIToken).order_by(APIToken.created_at.desc()))
    return [APITokenRead.model_validate(token) for token in result.scalars().all()]


@router.post("/auth/connections/redeem", response_model=ConnectionRedeemResponse)
async def redeem_connection(
    payload: ConnectionRedeemRequest,
    db: AsyncSession = Depends(get_db_session),
) -> ConnectionRedeemResponse:
    try:
        grant, created = await redeem_connection_grant(
            db,
            grant_id=payload.grant_id,
            secret=payload.secret,
            installation_id=payload.installation_id,
            client_name=payload.client_name,
            verification_code=payload.verification_code,
        )
    except RuntimeError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(error)) from error

    return ConnectionRedeemResponse(
        token=created.plain_text,
        token_id=created.token.id,
        token_name=created.token.name,
        scopes=created.token.scopes,
        security_level=grant.security_level,
        second_factor_mode=grant.second_factor_mode,
    )
