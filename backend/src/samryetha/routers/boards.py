"""/api/boards — 镜像 backend/src/boards/routes.ts。"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, ConfigDict, Field

from .. import boards as boards_service
from .. import discussions as discussions_service
from ..authz import Abilities, assert_can
from ..errors import internal_error
from ..deps import CurrentUser, DbConn, get_current_user, require_active_user

router = APIRouter()

Slug = Annotated[str, Path(min_length=1, max_length=50)]
MemberUserId = Annotated[int, Path(ge=1)]


class BoardBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Annotated[str, Field(min_length=1, max_length=60)]
    slug: Annotated[str, Field(min_length=1, max_length=50, pattern=r"^[a-z0-9-]+$")]
    description: str | None = Field(default=None, max_length=500)
    visibility: Literal["public", "members", "private"] | None = None
    postingPolicy: Literal["everyone", "members", "moderators"] | None = None


class BoardPatch(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Annotated[str, Field(min_length=1, max_length=60)] | None = None
    description: Annotated[str, Field(max_length=500)] | None = None
    visibility: Literal["public", "members", "private"] | None = None
    postingPolicy: Literal["everyone", "members", "moderators"] | None = None


class DeleteBoardBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: Annotated[str, Field(max_length=500)] | None = None


class MemberRoleBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    role: Literal["member", "moderator"]


@router.get("/api/boards")
def list_boards(
    conn: DbConn,
    viewer: CurrentUser | None = Depends(get_current_user),
) -> dict:
    return {"items": boards_service.list_boards(conn, viewer.id if viewer else None)}


@router.get("/api/boards/{slug}")
def get_board(slug: Slug, conn: DbConn, viewer: CurrentUser | None = Depends(get_current_user)) -> dict:
    return boards_service.get_board(conn, viewer.id if viewer else None, slug)


@router.post("/api/boards", status_code=201)
def create_board(
    body: BoardBody,
    conn: DbConn,
    user: CurrentUser = Depends(require_active_user),
) -> dict:
    assert_can(user, Abilities.BOARD_CREATE, None, conn)
    return boards_service.create_board(conn, user.id, body.model_dump(exclude_none=True))


@router.patch("/api/boards/{slug}")
def patch_board(
    slug: Slug,
    body: BoardPatch,
    conn: DbConn,
    user: CurrentUser = Depends(require_active_user),
) -> dict:
    board = boards_service.get_board_for_authz(conn, slug)
    if board is None:
        raise internal_error()
    assert_can(user, Abilities.BOARD_UPDATE, {"type": "board", **board}, conn)
    patch = {k: v for k, v in body.model_dump(exclude_none=True).items() if k in {"name", "description", "visibility", "postingPolicy"}}
    return boards_service.update_board(conn, slug, patch)


@router.delete("/api/boards/{slug}")
def delete_board(
    slug: Slug,
    conn: DbConn,
    user: CurrentUser = Depends(require_active_user),
    body: DeleteBoardBody | None = Body(default=None),
) -> dict:
    board = boards_service.get_board_for_authz(conn, slug)
    if board is None:
        raise internal_error()
    assert_can(user, Abilities.BOARD_DELETE, {"type": "board", **board}, conn)
    boards_service.delete_board(conn, user.id, slug, (body.reason if body else None))
    return {"ok": True}


@router.get("/api/boards/{slug}/discussions")
def board_discussions(
    slug: Slug,
    conn: DbConn,
    viewer: CurrentUser | None = Depends(get_current_user),
    cursor: str | None = None,
    limit: int = Query(default=20, ge=1, le=50),
) -> dict:
    return discussions_service.list_discussions(
        conn, viewer, {"feed": "board", "boardSlug": slug, "cursor": cursor, "limit": limit}
    )


@router.post("/api/boards/{slug}/join")
def join_board(
    slug: Slug,
    conn: DbConn,
    user: CurrentUser = Depends(require_active_user),
) -> dict:
    board = boards_service.get_board_for_authz(conn, slug)
    if board is None:
        raise internal_error()
    assert_can(user, Abilities.BOARD_JOIN, {"type": "board", **board}, conn)
    boards_service.join_board(conn, user.id, slug)
    return {"member": True}


@router.delete("/api/boards/{slug}/leave")
def leave_board(
    slug: Slug,
    conn: DbConn,
    user: CurrentUser = Depends(require_active_user),
) -> dict:
    boards_service.leave_board(conn, user.id, slug)
    return {"member": False}


@router.get("/api/boards/{slug}/members")
def members(slug: Slug, conn: DbConn) -> dict:
    return {"items": boards_service.list_members(conn, slug)}


@router.patch("/api/boards/{slug}/members/{userId}")
def set_member_role(
    slug: Slug,
    userId: MemberUserId,
    body: MemberRoleBody,
    conn: DbConn,
    user: CurrentUser = Depends(require_active_user),
) -> dict:
    board = boards_service.get_board_for_authz(conn, slug)
    if board is None:
        raise internal_error()
    assert_can(user, Abilities.BOARD_MANAGE_MEMBERS, {"type": "board", **board}, conn)
    boards_service.update_member_role(conn, slug, userId, body.role)
    return {"ok": True}
