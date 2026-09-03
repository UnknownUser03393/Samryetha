import { useEffect, useState } from "react";
import { AppShell } from "./app-shell";
import { api, type AuthorRef, type ConversationSummary, type DirectMessage, type NotificationDTO } from "./lib/api";
import { useAuth } from "./lib/auth";
import { formatTime } from "./lib/format";

type InboxTab = "messages" | "notifications";

export function InboxPage() {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<InboxTab>("messages");

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [otherUser, setOtherUser] = useState<AuthorRef | null>(null);
  const [reply, setReply] = useState("");

  const [notifs, setNotifs] = useState<NotificationDTO[]>([]);

  const loadConversations = () => {
    api.messages.conversations().then((d) => setConversations(d.items)).catch(() => undefined);
  };

  const loadNotifications = () => {
    api.notifications.list().then((d) => setNotifs(d.items)).catch(() => undefined);
  };

  useEffect(() => {
    if (!user) return;
    loadConversations();
    loadNotifications();
  }, [user]);

  const openConversation = async (id: number) => {
    setActiveConvId(id);
    const d = await api.messages.list(id);
    setMessages(d.items);
    setOtherUser(d.otherUser);
    await api.messages.markRead(id);
    loadConversations();
  };

  const sendMessage = async () => {
    if (!otherUser || !reply.trim() || !activeConvId) return;
    await api.messages.send({ username: otherUser.username, body: reply.trim() });
    setReply("");
    await openConversation(activeConvId);
  };

  const openNotification = async (n: NotificationDTO) => {
    await api.notifications.markRead(n.id);
    loadNotifications();
    if (n.discussionId) window.location.href = `/d/${n.discussionId}`;
  };

  const markAllRead = async () => {
    await api.notifications.markAllRead();
    loadNotifications();
  };

  if (!loading && !user) {
    return <AppShell><div className="empty-state">Sign in to view your inbox. <a className="sender" href="/login">Sign in</a></div></AppShell>;
  }

  return (
    <AppShell current="inbox">
      <main className="shell inbox-layout">
        <header className="inbox-header">
          <h1 className="feed-title">Inbox</h1>
          <div className="inbox-tabs" role="tablist">
            <button className={`inbox-tab ${tab === "messages" ? "active" : ""}`} role="tab" aria-selected={tab === "messages"} onClick={() => setTab("messages")}>Messages</button>
            <button className={`inbox-tab ${tab === "notifications" ? "active" : ""}`} role="tab" aria-selected={tab === "notifications"} onClick={() => setTab("notifications")}>Notifications</button>
          </div>
        </header>

        {tab === "messages" && (
          <div className="inbox-messages">
            <aside className="conversation-list">
              {conversations.length === 0 ? (
                <div className="empty-state">No messages yet. Visit a profile to start a conversation.</div>
              ) : conversations.map((c) => (
                <button key={c.id} type="button" className={`conversation-item ${activeConvId === c.id ? "active" : ""}`} onClick={() => void openConversation(c.id)}>
                  <span className="conversation-name">{c.otherUser.displayName} <small>@{c.otherUser.handle}</small></span>
                  <span className="conversation-preview">{c.lastMessage ? c.lastMessage.body : "Say hi"}</span>
                  {c.unreadCount > 0 && <span className="badge">{c.unreadCount}</span>}
                </button>
              ))}
            </aside>

            <section className="conversation-thread">
              {activeConvId == null ? (
                <div className="empty-state">Select a conversation.</div>
              ) : (
                <>
                  <div className="conversation-thread-head">{otherUser ? <strong>{otherUser.displayName}</strong> : ""}</div>
                  <div className="message-list">
                    {messages.map((m) => (
                      <div key={m.id} className={`message ${m.senderId === user?.id ? "mine" : "theirs"}`}>
                        <span className="message-body">{m.body}</span>
                        <small className="message-time">{formatTime(m.createdAt)}</small>
                      </div>
                    ))}
                  </div>
                  <form className="message-compose" onSubmit={(e) => { e.preventDefault(); void sendMessage(); }}>
                    <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} maxLength={5000} placeholder="Write a message…" />
                    <button className="primary-action" type="submit" disabled={!reply.trim()}>Send</button>
                  </form>
                </>
              )}
            </section>
          </div>
        )}

        {tab === "notifications" && (
          <div className="inbox-notifications">
            <div className="inbox-notif-head">
              <button type="button" className="action-btn" onClick={() => void markAllRead()}>Mark all read</button>
            </div>
            <div className="notification-list">
              {notifs.length === 0 ? (
                <div className="empty-state">No notifications.</div>
              ) : notifs.map((n) => (
                <button key={n.id} type="button" className={`notification-item ${n.isRead ? "read" : "unread"}`} onClick={() => void openNotification(n)}>
                  <span className="notification-type">{n.type}</span>
                  <span className="notification-body">{n.body ?? (n.actor ? n.actor.displayName : "")}</span>
                  <small>{formatTime(n.createdAt)}</small>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}
