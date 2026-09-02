"""/api/presence — 镜像 backend/src/presence/routes.ts。

heartbeat 需 active 用户；列表公开（含在线用户名）。TTL 60s（客户端 ~45s 上报）。
"""

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select

from ..deps import CurrentUser, DbConn, require_active_user
from ..presence import MemoryPresenceStore
from ..schema import users
from ..users import make_handle

router = APIRouter()

_HEARTBEAT_TTL_MS = 60_000


@router.post("/api/presence/heartbeat")
def heartbeat(
    request: Request,
    user: CurrentUser = Depends(require_active_user),
) -> dict:
    presence: MemoryPresenceStore = request.app.state.presence
    presence.heartbeat(user.id, _HEARTBEAT_TTL_MS)
    return {"onlineCount": presence.online_count()}


@router.get("/api/presence")
def online_users(conn: DbConn, request: Request) -> dict:
    presence: MemoryPresenceStore = request.app.state.presence
    user_ids = presence.online_user_ids()
    rows = []
    if user_ids:
        rows = [
            dict(r._mapping)
            for r in conn.execute(select(users).where(users.c.id.in_(user_ids))).all()
        ]
    return {
        "onlineCount": len(rows),
        "onlineUsers": [
            {
                "id": u["id"],
                "username": u["username"],
                "handle": make_handle(u["username"], u["discriminator"]),
                "displayName": u["display_name"],
            }
            for u in rows
        ],
    }
