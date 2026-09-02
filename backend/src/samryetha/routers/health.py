"""GET /api/health — 镜像 server.ts 的 health route。"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from sqlalchemy import text

router = APIRouter()

_PROC_START = time.time()


@router.get("/api/health")
def health(request: Request) -> dict:
    db_status = "ok"
    try:
        db = request.app.state.db
        with db.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        db_status = "error"
    return {
        "status": "ok",
        "uptime": int(round(time.time() - _PROC_START)),
        "db": db_status,
    }
