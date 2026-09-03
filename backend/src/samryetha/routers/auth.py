"""/api/auth/* — 镜像 backend/src/auth/routes.ts。"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .. import auth as auth_service
from ..deps import CurrentUser, DbConn, get_db, require_user
from ..security import SESSION_COOKIE
from ..errors import internal_error
from ..users import get_by_id, to_dto

router = APIRouter()


def _strip(v: Any) -> Any:
    return v.strip() if isinstance(v, str) else v


class RegisterBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    username: Annotated[str, Field(min_length=3, max_length=30, pattern=r"^[A-Za-z0-9_]+$")]
    password: Annotated[str, Field(min_length=8, max_length=200)]

    @field_validator("username", mode="before")
    @classmethod
    def _strip_u(cls, v: Any) -> Any:
        return _strip(v)


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    username: Annotated[str, Field(min_length=1, max_length=30)]
    password: Annotated[str, Field(min_length=1)]

    @field_validator("username", mode="before")
    @classmethod
    def _strip_u(cls, v: Any) -> Any:
        return _strip(v)


class ChangePasswordBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    currentPassword: Annotated[str, Field(min_length=1)]
    newPassword: Annotated[str, Field(min_length=8, max_length=200)]


@router.post("/api/auth/register", status_code=201)
def register(body: RegisterBody, conn: DbConn) -> dict:
    user_id = auth_service.register(conn, body.username, body.password)
    return {"userId": user_id, "message": "pending"}


@router.post("/api/auth/login")
def login(body: LoginBody, conn: DbConn, request: Request, response: Response) -> dict:
    settings = request.app.state.settings
    result = auth_service.login(
        conn,
        body.username,
        body.password,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        session_ttl_ms=settings.session_ttl_ms,
    )
    response.set_cookie(
        key=SESSION_COOKIE,
        value=result["token"],
        max_age=settings.session_ttl_ms // 1000,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return {"user": result["user"], "sessionExpiresAt": result["expiresAt"]}


@router.post("/api/auth/logout", status_code=204)
def logout(request: Request, conn: DbConn, response: Response) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        auth_service.logout(conn, token)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return None


@router.get("/api/auth/me")
def me(
    conn: DbConn,
    user: CurrentUser = Depends(require_user),
) -> dict:
    row = get_by_id(conn, user.id)
    if row is None:
        # TS: throw new Error("Session user vanished") → 500
        raise internal_error()
    return {"user": to_dto(row)}


@router.post("/api/auth/change-password")
def change_password(
    body: ChangePasswordBody,
    conn: DbConn,
    user: CurrentUser = Depends(require_user),
) -> dict:
    auth_service.change_password(conn, user.id, body.currentPassword, body.newPassword)
    return {"ok": True}
