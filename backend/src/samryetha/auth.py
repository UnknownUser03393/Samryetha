"""Auth service — 镜像 backend/src/auth/service.ts + bootstrap.ts。

注册建 pending 用户；登录发会话；启动时 ensure_builtin admin/dev。
密码用 argon2id（m=19456,t=2,p=1），存量哈希直接可验。
"""

from __future__ import annotations

import secrets

from sqlalchemy import and_, select, update
from sqlalchemy.engine import Connection

from .config import Settings
from .db import now_ms
from .errors import (
    banned,
    conflict,
    forbidden,
    invalid_credentials,
    token_invalid,
)
from .schema import password_reset_tokens, users as users_table
from .security import (
    create_session,
    delete_session,
    delete_user_sessions,
    hash_password,
    hash_token,
    verify_against_dummy,
    verify_password,
)
from .users import (
    FAKE_EMAIL_DOMAIN,
    normalize_username,
    next_discriminator,
    register_user_row,
    to_dto,
    get_by_id,
)

# ---------------------------------------------------------------- register


def register(conn: Connection, username: str, password: str) -> int:
    wanted = normalize_username(username)
    existing = conn.execute(
        select(users_table.c.id).where(users_table.c.username == wanted)
    ).first()
    if existing:
        raise conflict("That username is already taken")
    password_hash = hash_password(password)
    return register_user_row(conn, wanted, wanted, password_hash)


# ---------------------------------------------------------------- login


def login(
    conn: Connection,
    identifier: str,
    password: str,
    ip: str | None,
    user_agent: str | None,
    session_ttl_ms: int,
) -> dict:
    wanted = normalize_username(identifier)
    user = conn.execute(
        select(users_table).where(
            (users_table.c.username == wanted) & (users_table.c.deleted_at.is_(None))
        )
    ).first()
    if user is None:
        # 防枚举时序：对不存在的账号也跑一次 dummy 校验
        verify_against_dummy(secrets.token_urlsafe(16))
        raise invalid_credentials()
    row = dict(user._mapping)

    if not verify_password(password, row["password_hash"]):
        raise invalid_credentials()
    if row["status"] == "banned":
        raise banned()
    if row["status"] == "pending":
        raise forbidden("Your account is awaiting admin approval")
    if row["status"] != "active":
        raise forbidden("This account is not active")

    token, expires = create_session(
        conn, row["id"], {"ip": ip, "user_agent": user_agent}, ttl_ms=session_ttl_ms
    )
    return {"user": to_dto(row), "token": token, "expiresAt": expires}


# ---------------------------------------------------------------- session mgmt


def logout(conn: Connection, token: str) -> None:
    if token:
        delete_session(conn, token)


def change_password(conn: Connection, user_id: int, current_password: str, new_password: str) -> None:
    user = get_by_id(conn, user_id)
    if user is None:
        raise invalid_credentials()
    if not verify_password(current_password, user["password_hash"]):
        raise invalid_credentials("Current password is incorrect")
    new_hash = hash_password(new_password)
    conn.execute(
        update(users_table)
        .where(users_table.c.id == user_id)
        .values(password_hash=new_hash, updated_at=now_ms())
    )
    delete_user_sessions(conn, user_id)


# ---------------------------------------------------------------- password reset


def forgot_password(conn: Connection, username: str, recovery_email: str) -> str | None:
    """生成一次性重置 token；不匹配时返回 None（不泄露账号是否存在）。"""
    user = conn.execute(
        select(users_table).where(
            (users_table.c.username == normalize_username(username)) & (users_table.c.deleted_at.is_(None))
        )
    ).first()
    if user is None or not user.recovery_email:
        return None
    if user.recovery_email.strip().lower() != recovery_email.strip().lower():
        return None
    token = secrets.token_urlsafe(32)
    conn.execute(
        password_reset_tokens.insert().values(
            user_id=user.id,
            token_hash=hash_token(token),
            expires_at=now_ms() + 60 * 60 * 1000,
            created_at=now_ms(),
        )
    )
    return token


def reset_password(conn: Connection, token: str, new_password: str) -> None:
    """校验一次性 token 并重置密码，踢掉旧会话。"""
    token_hash = hash_token(token)
    row = conn.execute(
        select(password_reset_tokens).where(
            and_(
                password_reset_tokens.c.token_hash == token_hash,
                password_reset_tokens.c.expires_at > now_ms(),
                password_reset_tokens.c.used_at.is_(None),
            )
        )
    ).first()
    if row is None:
        raise token_invalid("Reset link is invalid or expired")
    new_hash = hash_password(new_password)
    conn.execute(
        update(users_table)
        .where(users_table.c.id == row.user_id)
        .values(password_hash=new_hash, updated_at=now_ms())
    )
    conn.execute(
        update(password_reset_tokens)
        .where(password_reset_tokens.c.id == row.id)
        .values(used_at=now_ms())
    )
    delete_user_sessions(conn, row.user_id)


# ---------------------------------------------------------------- bootstrap

def ensure_builtin_accounts(conn: Connection, settings: Settings) -> None:
    """幂等确保 admin / dev 存在，启动时调用。镜像 auth/bootstrap.ts。"""
    accounts = [
        ("admin", settings.admin_password),
        ("dev", settings.dev_password),
    ]
    for username, password in accounts:
        existing = conn.execute(
            select(users_table.c.id).where(users_table.c.username == username)
        ).first()
        if existing:
            # 已存在账号：只确保角色/状态可用，绝不重置密码哈希——否则每次重启都会把密码
            # 重置回 env 默认值，形成默认凭据后门（镜像 auth/bootstrap.ts 修复）。
            conn.execute(
                update(users_table)
                .where(users_table.c.id == existing[0])
                .values(
                    role="admin",
                    status="active",
                    email_verified_at=now_ms(),
                )
            )
            continue
        password_hash = hash_password(password)
        disc = next_discriminator(conn)
        email = f"{username}@{FAKE_EMAIL_DOMAIN}"
        _now = now_ms()
        conn.execute(
            users_table.insert().values(
                username=username,
                display_name=username,
                email=email,
                email_domain=FAKE_EMAIL_DOMAIN,
                password_hash=password_hash,
                role="admin",
                status="active",
                discriminator=disc,
                email_verified_at=_now,
                bio="",
                settings="{}",
                created_at=_now,
                updated_at=_now,
            )
        )
