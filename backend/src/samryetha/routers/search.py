"""/api/search — 镜像 backend/src/search/routes.ts。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import search as search_service
from ..deps import CurrentUser, DbConn, get_current_user

router = APIRouter()


@router.get("/api/search")
def search(
    conn: DbConn,
    viewer: CurrentUser | None = Depends(get_current_user),
    q: str = Query(min_length=1, max_length=100),
    board: str | None = Query(default=None, max_length=50),
    limit: int = Query(default=20, ge=1, le=50),
) -> dict:
    return search_service.search_discussions(
        conn, viewer, {"q": q, "boardSlug": board, "limit": limit}
    )
