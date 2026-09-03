"""站内信（私信）service — 镜像 backend/src/messages/service.ts。

conversations：两人一个会话（user_a < user_b 归一，避免重复会话）。
direct_messages：会话内消息，source 字段预留其他平台接入。
"""

from __future__ import annotations

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.engine import Connection

from .db import now_ms
from .errors import not_found
from .schema import conversations, direct_messages, users
from .users import make_handle


def _pair(a: int, b: int) -> tuple[int, int]:
    # 归一化参与者：a 恒为较小 id，避免同一对用户产生两条会话
    return (a, b) if a <= b else (b, a)


def _other_user(row) -> dict:
    return {
        "id": row.id,
        "username": row.username,
        "handle": make_handle(row.username, row.discriminator),
        "displayName": row.display_name,
    }


def _find_or_create_conversation(conn: Connection, a: int, b: int) -> int:
    row = conn.execute(
        select(conversations.c.id).where(
            and_(conversations.c.user_a_id == a, conversations.c.user_b_id == b)
        )
    ).first()
    if row is not None:
        return row[0]
    _now = now_ms()
    res = conn.execute(
        conversations.insert().values(user_a_id=a, user_b_id=b, last_message_at=_now, created_at=_now)
    )
    return res.inserted_primary_key[0]


def _get_conversation(conn: Connection, user_id: int, conversation_id: int):
    row = conn.execute(select(conversations).where(conversations.c.id == conversation_id)).first()
    if row is None or (row.user_a_id != user_id and row.user_b_id != user_id):
        raise not_found("Conversation not found")
    return row


def send(conn: Connection, sender_id: int, recipient_username: str, body: str) -> dict:
    recip = conn.execute(
        select(users).where(
            and_(users.c.username == recipient_username.strip().lower(), users.c.deleted_at.is_(None))
        )
    ).first()
    if recip is None:
        raise not_found("User not found")
    if recip.id == sender_id:
        raise not_found("Cannot message yourself")
    a, b = _pair(sender_id, recip.id)
    conversation_id = _find_or_create_conversation(conn, a, b)
    conn.execute(
        direct_messages.insert().values(
            conversation_id=conversation_id,
            sender_id=sender_id,
            body=body,
            source="user",
            created_at=now_ms(),
        )
    )
    conn.execute(
        update(conversations)
        .where(conversations.c.id == conversation_id)
        .values(last_message_at=now_ms())
    )
    return {"conversationId": conversation_id}


def list_conversations(conn: Connection, user_id: int) -> list[dict]:
    rows = conn.execute(
        select(conversations)
        .where(or_(conversations.c.user_a_id == user_id, conversations.c.user_b_id == user_id))
        .order_by(conversations.c.last_message_at.desc())
    ).all()
    if not rows:
        return []

    other_ids = [r.user_a_id if r.user_b_id == user_id else r.user_b_id for r in rows]
    other_map = {u.id: u for u in conn.execute(select(users).where(users.c.id.in_(other_ids))).all()}

    conv_ids = [r.id for r in rows]
    last_rows = conn.execute(
        select(direct_messages)
        .where(direct_messages.c.conversation_id.in_(conv_ids))
        .order_by(direct_messages.c.id.desc())
    ).all()
    last_map: dict[int, dict] = {}
    for m in last_rows:
        if m.conversation_id not in last_map:
            last_map[m.conversation_id] = m

    unread_rows = conn.execute(
        select(direct_messages.c.conversation_id, func.count())
        .where(
            and_(
                direct_messages.c.conversation_id.in_(conv_ids),
                direct_messages.c.sender_id != user_id,
                direct_messages.c.read_at.is_(None),
            )
        )
        .group_by(direct_messages.c.conversation_id)
    ).all()
    unread_map = {r[0]: r[1] for r in unread_rows}

    out = []
    for r in rows:
        other_id = r.user_a_id if r.user_b_id == user_id else r.user_b_id
        other = other_map.get(other_id)
        last = last_map.get(r.id)
        out.append(
            {
                "id": r.id,
                "otherUser": _other_user(other) if other else {"id": other_id, "username": "deleted", "handle": "deleted", "displayName": "Deleted user"},
                "lastMessage": {"body": last.body, "senderId": last.sender_id, "createdAt": last.created_at} if last else None,
                "unreadCount": unread_map.get(r.id, 0),
                "lastMessageAt": r.last_message_at,
            }
        )
    return out


def list_messages(conn: Connection, user_id: int, conversation_id: int) -> dict:
    conv = _get_conversation(conn, user_id, conversation_id)
    other_id = conv.user_a_id if conv.user_b_id == user_id else conv.user_b_id
    other = conn.execute(select(users).where(users.c.id == other_id)).first()
    rows = conn.execute(
        select(direct_messages)
        .where(direct_messages.c.conversation_id == conversation_id)
        .order_by(direct_messages.c.created_at)
    ).all()
    return {
        "items": [
            {
                "id": m.id,
                "senderId": m.sender_id,
                "body": m.body,
                "source": m.source,
                "isRead": m.read_at is not None,
                "createdAt": m.created_at,
            }
            for m in rows
        ],
        "otherUser": _other_user(other) if other else {"id": other_id, "username": "deleted", "handle": "deleted", "displayName": "Deleted user"},
    }


def mark_read(conn: Connection, user_id: int, conversation_id: int) -> None:
    conv = _get_conversation(conn, user_id, conversation_id)
    conn.execute(
        update(direct_messages)
        .where(
            and_(
                direct_messages.c.conversation_id == conv.id,
                direct_messages.c.sender_id != user_id,
                direct_messages.c.read_at.is_(None),
            )
        )
        .values(read_at=now_ms())
    )


def unread_count(conn: Connection, user_id: int) -> int:
    convs = conn.execute(
        select(conversations.c.id).where(
            or_(conversations.c.user_a_id == user_id, conversations.c.user_b_id == user_id)
        )
    ).all()
    if not convs:
        return 0
    ids = [c[0] for c in convs]
    return (
        conn.execute(
            select(func.count())
            .select_from(direct_messages)
            .where(
                and_(
                    direct_messages.c.conversation_id.in_(ids),
                    direct_messages.c.sender_id != user_id,
                    direct_messages.c.read_at.is_(None),
                )
            )
        ).scalar()
        or 0
    )
