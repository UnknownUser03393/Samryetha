import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { UserMenu } from "./user-menu";
import { Loading } from "./loading";
import { api, ApiError, type AdminStats, type AdminUser, type BoardSummary, type BoardVisibility, type DeletedDiscussion, type DeletedReply, type ModerationAction, type ReportDTO, type UserRole, type UserStatus } from "./lib/api";
import { useAuth } from "./lib/auth";
import { formatTime } from "./lib/format";

type AdminSection = "dashboard" | "users" | "boards" | "moderation" | "audit";

const sections: { id: AdminSection; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "users", label: "Users" },
  { id: "boards", label: "Boards" },
  { id: "moderation", label: "Moderation" },
  { id: "audit", label: "Audit log" },
];

const STATUS_PILLS: { key: UserStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "active", label: "Active" },
  { key: "banned", label: "Banned" },
  { key: "deactivated", label: "Deactivated" },
];

const ROLE_OPTIONS: { key: UserRole | "all"; label: string }[] = [
  { key: "all", label: "All roles" },
  { key: "student", label: "Student" },
  { key: "moderator", label: "Moderator" },
  { key: "admin", label: "Admin" },
];

function SearchIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" /><path d="M16 16L21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
}

function Badge({ children, variant }: { children: React.ReactNode; variant: string }) {
  return <span className={`admin-badge ${variant}`}>{children}</span>;
}

export function AdminPage() {
  const { user, loading } = useAuth();
  const [section, setSection] = useState<AdminSection>("dashboard");
  const [selectedSection, setSelectedSection] = useState<AdminSection>("dashboard");
  const [contentPhase, setContentPhase] = useState<"" | "is-leaving" | "is-entering">("");
  const [navIndicator, setNavIndicator] = useState({ width: 0, height: 0, x: 0, y: 0, ready: false });
  const adminNavRef = useRef<HTMLElement>(null);
  const transitionToken = useRef(0);

  // SSR-safe：首帧恒为 dashboard，挂载后再从 ?section= 切入（避免 hydration mismatch）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const s = new URLSearchParams(window.location.search).get("section");
    if (s === "users" || s === "boards" || s === "moderation" || s === "audit") {
      setSelectedSection(s);
      setSection(s);
    }
  }, []);

  useLayoutEffect(() => {
    const moveIndicator = () => {
      const activeButton = adminNavRef.current?.querySelector<HTMLElement>(`[data-admin-section="${selectedSection}"]`);
      if (activeButton) setNavIndicator({ width: activeButton.offsetWidth, height: activeButton.offsetHeight, x: activeButton.offsetLeft, y: activeButton.offsetTop, ready: true });
    };
    moveIndicator();
    window.addEventListener("resize", moveIndicator);
    return () => window.removeEventListener("resize", moveIndicator);
  }, [selectedSection]);

  const switchSection = (nextSection: AdminSection) => {
    if (nextSection === selectedSection) return;
    setSelectedSection(nextSection);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setSection(nextSection);
      return;
    }

    const token = ++transitionToken.current;
    setContentPhase("is-leaving");
    window.setTimeout(() => {
      if (token !== transitionToken.current) return;
      setSection(nextSection);
      setContentPhase("is-entering");
      requestAnimationFrame(() => setContentPhase(""));
    }, 125);
  };

  if (!loading && !user) {
    return (
      <Shell>
        <main className="shell admin-layout">
          <section className="admin-content">
            <div className="empty-state">Sign in to access the admin panel. <a className="sender" href="/login">Sign in</a></div>
          </section>
        </main>
      </Shell>
    );
  }
  if (!loading && user && user.role !== "admin") {
    return (
      <Shell>
        <main className="shell admin-layout">
          <section className="admin-content">
            <div className="empty-state">You don’t have permission to access the admin panel.</div>
          </section>
        </main>
      </Shell>
    );
  }

  return (
    <Shell>
      <main className="shell admin-layout">
        <aside className="settings-sidebar">
          <h1>Admin</h1>
          <nav className="settings-nav" aria-label="Admin sections" ref={adminNavRef}>
            {sections.map((item) => (
              <button data-admin-section={item.id} className={selectedSection === item.id ? "active" : ""} key={item.id} type="button" aria-current={selectedSection === item.id ? "page" : undefined} onClick={() => switchSection(item.id)}>
                <span>{item.label}</span>
              </button>
            ))}
            <span className={`settings-nav-indicator ${navIndicator.ready ? "ready" : ""}`} style={{ width: navIndicator.width, height: navIndicator.height, transform: `translate(${navIndicator.x}px, ${navIndicator.y}px)` }} aria-hidden="true" />
            <span className={`settings-nav-accent ${navIndicator.ready ? "ready" : ""}`} style={{ transform: `translate(${navIndicator.x}px, ${navIndicator.y + 10}px)` }} aria-hidden="true" />
          </nav>
        </aside>

        <section className={`settings-content admin-content ${contentPhase}`} aria-live="polite">
          {section === "dashboard" && <DashboardSection />}
          {section === "users" && <UsersSection />}
          {section === "boards" && <BoardsSection />}
          {section === "moderation" && <ModerationSection />}
          {section === "audit" && <AuditSection />}
        </section>
      </main>
    </Shell>
  );
}

// ---------------------------------------------------------------- dashboard

function StatGrid({ title, stats }: { title: string; stats: [string, number][] }) {
  return (
    <div className="admin-stat-group">
      <p className="admin-stat-group-title">{title}</p>
      <div className="admin-stat-grid">
        {stats.map(([label, value]) => (
          <div className="admin-stat" key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardSection() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStats(await api.admin.stats());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load stats.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="empty-state">
        {error}
        <button className="admin-btn" type="button" onClick={() => void load()}>Try again</button>
      </div>
    );
  }
  if (!stats) return <Loading />;

  return (
    <div className="content-fade">
      <header><h2>Dashboard</h2><p>Site-wide numbers at a glance.</p></header>
      <StatGrid title="Users" stats={[["Total", stats.users.total], ["Pending", stats.users.pending], ["Active", stats.users.active], ["Banned", stats.users.banned], ["Deactivated", stats.users.deactivated]]} />
      <StatGrid title="Content" stats={[["Discussions", stats.content.discussions], ["Replies", stats.content.replies], ["Boards", stats.content.boards]]} />
      <StatGrid title="Moderation" stats={[["Open reports", stats.moderation.openReports], ["Active bans", stats.moderation.activeBans]]} />
      <StatGrid title="Activity today" stats={[["Active authors", stats.activity.activeToday], ["New users", stats.activity.newUsersToday], ["New discussions", stats.activity.newDiscussionsToday], ["New replies", stats.activity.newRepliesToday], ["Online now", stats.activity.onlineNow]]} />
      <p className="community-note">Dashboard figures update on refresh. Pending users can be verified in the Users tab.</p>
    </div>
  );
}

// ---------------------------------------------------------------- users

function UsersSection() {
  const { user: me } = useAuth();
  const [items, setItems] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<UserStatus | "all">("all");
  const [role, setRole] = useState<UserRole | "all">("all");

  const loadFirst = useCallback(async () => {
    try {
      const data = await api.admin.users({
        q: query || undefined,
        status: status === "all" ? undefined : status,
        role: role === "all" ? undefined : role,
        limit: 20,
      });
      setItems(data.items);
      setNextCursor(data.nextCursor ? Number(data.nextCursor) : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load users.");
    } finally {
      setLoading(false);
    }
  }, [query, status, role]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.admin
      .users({ q: query || undefined, status: status === "all" ? undefined : status, role: role === "all" ? undefined : role, limit: 20 })
      .then((data) => {
        if (!alive) return;
        setItems(data.items);
        setNextCursor(data.nextCursor ? Number(data.nextCursor) : null);
      })
      .catch((err) => { if (alive) setError(err instanceof ApiError ? err.message : "Could not load users."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query, status, role]);

  const runAction = async (user: AdminUser, fn: () => Promise<unknown>, success: string) => {
    setBusyId(user.id);
    setNotice(null);
    try {
      await fn();
      await loadFirst();
      setNotice(success);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <header><h2>Users</h2><p>Manage accounts, roles, and status.</p></header>

      <div className="admin-filters">
        <label className="search-field admin-search">
          <SearchIcon />
          <span className="sr-only">Search users</span>
          <input type="search" placeholder="Search by username, name, or email" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="admin-pills" role="group" aria-label="Filter by status">
          {STATUS_PILLS.map((pill) => (
            <button className={`admin-pill ${status === pill.key ? "active" : ""}`} type="button" key={pill.key} onClick={() => setStatus(pill.key)}>{pill.label}</button>
          ))}
        </div>
        <label className="admin-select">
          <span className="sr-only">Filter by role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as UserRole | "all")}>
            {ROLE_OPTIONS.map((opt) => <option value={opt.key} key={opt.key}>{opt.label}</option>)}
          </select>
        </label>
      </div>

      {notice && <p className="form-error saved-note" role="status">{notice}</p>}
      {error && <div className="empty-state">{error}</div>}
      {loading ? (
        <Loading />
      ) : (
        <div className="admin-list content-fade">
          {items.map((user) => (
            <div className="admin-row" key={user.id}>
              <div className="admin-row-main">
                <strong>{user.displayName}</strong>
                <span className="admin-muted">@{user.username} · {user.email}</span>
                <div className="admin-row-tags">
                  <Badge variant={user.role}>{user.role}</Badge>
                  <Badge variant={user.status}>{user.status}</Badge>
                  {user.banActive && <Badge variant="banned">ban active</Badge>}
                  {!user.emailVerified && <Badge variant="pending">unverified</Badge>}
                  <span className="admin-muted">joined {formatTime(user.createdAt)}</span>
                </div>
              </div>
              <div className="admin-row-actions" data-busy={busyId === user.id || undefined}>
                <label className="admin-select">
                  <span className="sr-only">Role</span>
                  <select
                    value={user.role}
                    disabled={busyId !== null || user.id === me?.id}
                    onChange={(event) => void runAction(user, () => api.admin.changeRole(user.id, { role: event.target.value as AdminUser["role"] }), "Role updated.")}
                  >
                    <option value="student">student</option>
                    <option value="moderator">moderator</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                {user.status === "pending" && (
                  <button className="admin-btn" type="button" disabled={busyId !== null} onClick={() => void runAction(user, () => api.admin.verifyUser(user.id), "User verified.")}>Verify</button>
                )}
                {user.status === "active" && (
                  <>
                    <button className="admin-btn danger" type="button" disabled={busyId !== null} onClick={() => void runAction(user, () => api.moderation.ban({ username: user.username }), "User banned.")}>Ban</button>
                    <button className="admin-btn" type="button" disabled={busyId !== null} onClick={() => void runAction(user, () => api.admin.changeStatus(user.id, { status: "deactivated" }), "User deactivated.")}>Deactivate</button>
                  </>
                )}
                {user.status === "banned" && (
                  <button className="admin-btn" type="button" disabled={busyId !== null} onClick={() => void runAction(user, () => api.moderation.unban(user.username), "User unbanned.")}>Unban</button>
                )}
                {user.status === "deactivated" && (
                  <button className="admin-btn" type="button" disabled={busyId !== null} onClick={() => void runAction(user, () => api.admin.changeStatus(user.id, { status: "active" }), "User reactivated.")}>Reactivate</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && nextCursor !== null && (
        <button className="admin-btn load-more" type="button" onClick={() => void (async () => {
          try {
            const data = await api.admin.users({ q: query || undefined, status: status === "all" ? undefined : status, role: role === "all" ? undefined : role, cursor: nextCursor, limit: 20 });
            setItems((prev) => [...prev, ...data.items]);
            setNextCursor(data.nextCursor ? Number(data.nextCursor) : null);
          } catch (err) {
            setNotice(err instanceof ApiError ? err.message : "Could not load more.");
          }
        })()}>Load more</button>
      )}
      {!loading && items.length === 0 && <div className="empty-state">No users found.</div>}
    </>
  );
}

// ---------------------------------------------------------------- boards

const VISIBILITIES = ["public", "members", "private"];
const POSTING_POLICIES = ["everyone", "members", "moderators"];

function BoardsSection() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [membersSlug, setMembersSlug] = useState<string | null>(null);
  const [membersMap, setMembersMap] = useState<Record<string, { id: number; username: string; displayName: string; role: "member" | "moderator" }[]>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createVisibility, setCreateVisibility] = useState<BoardVisibility>("public");
  const [createPosting, setCreatePosting] = useState<"everyone" | "members" | "moderators">("everyone");
  const [createBusy, setCreateBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.boards.list();
      setBoards(data.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load boards.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2500);
  };

  const createBoard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createBusy) return;
    setCreateBusy(true);
    try {
      await api.boards.create({ name: createName.trim(), slug: createSlug.trim(), description: createDesc.trim(), visibility: createVisibility, postingPolicy: createPosting });
      setCreateOpen(false);
      setCreateName("");
      setCreateSlug("");
      setCreateDesc("");
      setCreateVisibility("public");
      setCreatePosting("everyone");
      flash("Board created.");
      await load();
    } catch (err) {
      flash(err instanceof ApiError ? err.message : "Could not create board.");
    } finally {
      setCreateBusy(false);
    }
  };

  const deleteBoard = async (board: BoardSummary) => {
    try {
      await api.boards.del(board.slug, { reason: "admin delete" });
      flash("Board deleted.");
      await load();
    } catch (err) {
      flash(err instanceof ApiError ? err.message : "Could not delete board.");
    }
  };

  const toggleMembers = async (slug: string) => {
    if (membersSlug === slug) {
      setMembersSlug(null);
      return;
    }
    setMembersSlug(slug);
    try {
      const data = await api.boards.members(slug);
      setMembersMap((prev) => ({ ...prev, [slug]: data.items }));
    } catch (err) {
      flash(err instanceof ApiError ? err.message : "Could not load members.");
    }
  };

  return (
    <>
      <header><h2>Boards</h2><p>Create, edit, and organize boards.</p></header>

      {notice && <p className="form-error saved-note" role="status">{notice}</p>}
      {error && <div className="empty-state">{error}</div>}

      <div className="admin-create-toggle">
        <button className="admin-btn" type="button" onClick={() => setCreateOpen((v) => !v)}>{createOpen ? "Cancel" : "Create board"}</button>
      </div>
      {createOpen && (
        <form className="admin-inline-form" onSubmit={createBoard} noValidate>
          <label><span>Name</span><input value={createName} onChange={(e) => setCreateName(e.target.value)} maxLength={60} required /></label>
          <label><span>Slug</span><input value={createSlug} onChange={(e) => setCreateSlug(e.target.value)} pattern="[a-z0-9-]+" maxLength={50} required placeholder="campus-life" /></label>
          <label><span>Description</span><input value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} maxLength={500} /></label>
          <div className="admin-inline-selects">
            <label className="admin-select"><span>Visibility</span>
              <select value={createVisibility} onChange={(e) => setCreateVisibility(e.target.value as BoardVisibility)}>
                {VISIBILITIES.map((v) => <option key={v}>{v}</option>)}
              </select>
            </label>
            <label className="admin-select"><span>Posting</span>
              <select value={createPosting} onChange={(e) => setCreatePosting(e.target.value as "everyone" | "members" | "moderators")}>
                {POSTING_POLICIES.map((v) => <option key={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <button className="primary-action" type="submit" disabled={createBusy || !createName.trim() || !createSlug.trim()}>{createBusy ? "Creating…" : "Create board"}</button>
        </form>
      )}

      {loading ? (
        <Loading />
      ) : (
        <div className="admin-list content-fade">
          {boards.map((board) => (
            <div className="admin-row admin-row-stacked" key={board.slug}>
              <div className="admin-row-main">
                <strong>{board.name}</strong>
                <span className="admin-muted">{board.description || board.slug}</span>
                <div className="admin-row-tags">
                  <Badge variant={board.visibility}>{board.visibility}</Badge>
                  <Badge variant="active">{board.postingPolicy}</Badge>
                  <span className="admin-muted">{board.memberCount} members · {board.todayActivity} today</span>
                </div>
              </div>
              <div className="admin-row-actions">
                <button className="admin-btn" type="button" onClick={() => { setEditingSlug(editingSlug === board.slug ? null : board.slug); setMembersSlug(null); }}>{editingSlug === board.slug ? "Done" : "Edit"}</button>
                <button className="admin-btn" type="button" onClick={() => void toggleMembers(board.slug)}>{membersSlug === board.slug ? "Hide members" : "Members"}</button>
                <AlertDialog.Root>
                  <AlertDialog.Trigger asChild>
                    <button className="admin-btn danger" type="button">Delete</button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Portal>
                    <AlertDialog.Overlay className="dialog-overlay" />
                    <AlertDialog.Content className="dialog-content">
                      <AlertDialog.Title className="dialog-title">Delete board “{board.name}”?</AlertDialog.Title>
                      <AlertDialog.Description className="dialog-description">
                        This hides the board and all of its discussions.
                      </AlertDialog.Description>
                      <div className="dialog-actions">
                        <AlertDialog.Cancel asChild>
                          <button type="button" className="action-btn">Cancel</button>
                        </AlertDialog.Cancel>
                        <AlertDialog.Action asChild>
                          <button type="button" className="dialog-danger" onClick={() => void deleteBoard(board)}>Delete</button>
                        </AlertDialog.Action>
                      </div>
                    </AlertDialog.Content>
                  </AlertDialog.Portal>
                </AlertDialog.Root>
              </div>

              {editingSlug === board.slug && (
                <BoardEditForm board={board} onDone={() => { setEditingSlug(null); void load(); }} onError={flash} />
              )}
              {membersSlug === board.slug && (
                <div className="admin-members">
                  {(membersMap[board.slug] ?? []).map((member) => (
                    <div className="admin-member" key={member.id}>
                      <span className="admin-muted">@{member.username}</span>
                      <label className="admin-select">
                        <span className="sr-only">Member role</span>
                        <select
                          value={member.role}
                          onChange={(event) => void (async () => {
                            try {
                              await api.boards.updateMemberRole(board.slug, member.id, { role: event.target.value as "member" | "moderator" });
                              setMembersMap((prev) => ({ ...prev, [board.slug]: (prev[board.slug] ?? []).map((m) => (m.id === member.id ? { ...m, role: event.target.value as "member" | "moderator" } : m)) }));
                              flash("Member role updated.");
                            } catch (err) {
                              flash(err instanceof ApiError ? err.message : "Could not update member role.");
                            }
                          })()}
                        >
                          <option value="member">member</option>
                          <option value="moderator">moderator</option>
                        </select>
                      </label>
                    </div>
                  ))}
                  {membersMap[board.slug]?.length === 0 && <p className="admin-muted">No members yet.</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!loading && boards.length === 0 && <div className="empty-state">No boards found.</div>}
    </>
  );
}

function BoardEditForm({ board, onDone, onError }: { board: BoardSummary; onDone: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState(board.name);
  const [desc, setDesc] = useState(board.description);
  const [visibility, setVisibility] = useState(board.visibility);
  const [posting, setPosting] = useState(board.postingPolicy);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.boards.update(board.slug, { name: name.trim(), description: desc.trim(), visibility, postingPolicy: posting });
      onDone();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not save board.");
      setBusy(false);
    }
  };

  return (
    <form className="admin-inline-form" onSubmit={save} noValidate>
      <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></label>
      <label><span>Description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} /></label>
      <div className="admin-inline-selects">
        <label className="admin-select"><span>Visibility</span>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as BoardVisibility)}>
            {VISIBILITIES.map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label className="admin-select"><span>Posting</span>
          <select value={posting} onChange={(e) => setPosting(e.target.value as "everyone" | "members" | "moderators")}>
            {POSTING_POLICIES.map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
      </div>
      <button className="primary-action" type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save board"}</button>
    </form>
  );
}

// ---------------------------------------------------------------- moderation

function ModerationSection() {
  const [tab, setTab] = useState<"reports" | "deleted">("reports");
  return (
    <>
      <header><h2>Moderation</h2><p>Review reports and restore deleted content.</p></header>
      <div className="admin-pills" role="tablist" aria-label="Moderation views">
        <button className={`admin-pill ${tab === "reports" ? "active" : ""}`} type="button" role="tab" aria-selected={tab === "reports"} onClick={() => setTab("reports")}>Open reports</button>
        <button className={`admin-pill ${tab === "deleted" ? "active" : ""}`} type="button" role="tab" aria-selected={tab === "deleted"} onClick={() => setTab("deleted")}>Deleted content</button>
      </div>
      {tab === "reports" ? <ReportsList /> : <DeletedList />}
    </>
  );
}

function ReportsList() {
  const [items, setItems] = useState<ReportDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.moderation.reports({ status: "open", limit: 30 });
      setItems(data.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load reports.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (report: ReportDTO, fn: () => Promise<unknown>, success: string) => {
    setBusyId(report.id);
    setNotice(null);
    try {
      await fn();
      await load();
      setNotice(success);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  };

  const targetHref = (report: ReportDTO) => {
    const t = report.target;
    if (!t) return null;
    if (t.type === "discussion") return `/d/${t.id}`;
    if (t.type === "reply" && t.discussionId) return `/d/${t.discussionId}`;
    if (t.type === "user") return `/profile?username=${t.username}`;
    return null;
  };

  return (
    <>
      {notice && <p className="form-error saved-note" role="status">{notice}</p>}
      {error && <div className="empty-state">{error}</div>}
      {loading ? (
        <Loading />
      ) : (
        <div className="admin-list content-fade">
          {items.map((report) => {
            const href = targetHref(report);
            const t = report.target;
            return (
              <div className="admin-row" key={report.id}>
                <div className="admin-row-main">
                  <strong>{t?.title ?? t?.displayName ?? t?.username ?? `#${report.reportableId}`}</strong>
                  {href && <a className="sender" href={href}>view</a>}
                  <span className="admin-muted">{report.reason || "No reason given"} · reported by @{report.reporter.username} · {formatTime(report.createdAt)}</span>
                </div>
                <div className="admin-row-actions">
                  <button className="admin-btn" type="button" disabled={busyId !== null} onClick={() => void run(report, () => api.moderation.resolveReport(report.id, { status: "in_progress", action: "report.in_progress" }), "Marked in progress.")}>In progress</button>
                  <button className="admin-btn" type="button" disabled={busyId !== null} onClick={() => void run(report, () => api.moderation.resolveReport(report.id, { status: "resolved", action: "report.resolved" }), "Report resolved.")}>Resolve</button>
                  <button className="admin-btn" type="button" disabled={busyId !== null} onClick={() => void run(report, () => api.moderation.resolveReport(report.id, { status: "dismissed", action: "report.dismissed" }), "Report dismissed.")}>Dismiss</button>
                  {t?.type === "user" && (
                    <button className="admin-btn danger" type="button" disabled={busyId !== null} onClick={() => void run(report, () => api.moderation.ban({ username: t.username! }), "User banned.")}>Ban</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!loading && items.length === 0 && <div className="empty-state">No open reports.</div>}
    </>
  );
}

function DeletedList() {
  const [discussions, setDiscussions] = useState<DeletedDiscussion[]>([]);
  const [replies, setReplies] = useState<DeletedReply[]>([]);
  const [nextDiscCursor, setNextDiscCursor] = useState<number | null>(null);
  const [nextReplyCursor, setNextReplyCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.admin.deletedContent({ limit: 10 });
      setDiscussions(data.discussions);
      setReplies(data.replies);
      setNextDiscCursor(data.nextDiscussionCursor);
      setNextReplyCursor(data.nextReplyCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load deleted content.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (targetType: "discussion" | "reply", targetId: number) => {
    setBusyKey(`${targetType}:${targetId}`);
    setNotice(null);
    try {
      await api.moderation.restore({ targetType, targetId });
      await load();
      setNotice("Content restored.");
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Could not restore.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      {notice && <p className="form-error saved-note" role="status">{notice}</p>}
      {error && <div className="empty-state">{error}</div>}
      {loading ? (
        <Loading />
      ) : (
        <div className="content-fade">
          <p className="admin-group-label">Deleted discussions</p>
          <div className="admin-list">
            {discussions.map((d) => (
              <div className="admin-row" key={d.id}>
                <div className="admin-row-main">
                  <strong>{d.title}</strong>
                  <span className="admin-muted">{d.preview} · /{d.boardSlug}</span>
                  <div className="admin-row-tags">
                    {d.deletedBy && <span className="admin-muted">by @{d.deletedBy.username}</span>}
                    <span className="admin-muted">{formatTime(d.deletedAt)}</span>
                  </div>
                </div>
                <div className="admin-row-actions">
                  <button className="admin-btn" type="button" disabled={busyKey !== null} onClick={() => void restore("discussion", d.id)}>Restore</button>
                </div>
              </div>
            ))}
          </div>
          {nextDiscCursor !== null && (
            <button className="admin-btn load-more" type="button" onClick={() => void (async () => {
              try {
                const data = await api.admin.deletedContent({ discussionCursor: nextDiscCursor, limit: 10 });
                setDiscussions((prev) => [...prev, ...data.discussions]);
                setNextDiscCursor(data.nextDiscussionCursor);
              } catch (err) {
                setNotice(err instanceof ApiError ? err.message : "Could not load more.");
              }
            })()}>Load more discussions</button>
          )}

          <p className="admin-group-label">Deleted replies</p>
          <div className="admin-list">
            {replies.map((r) => (
              <div className="admin-row" key={r.id}>
                <div className="admin-row-main">
                  <strong>{r.discussionTitle || "Reply"}</strong>
                  <span className="admin-muted">{r.preview}</span>
                  <div className="admin-row-tags">
                    <a className="sender" href={`/d/${r.discussionId}`}>view thread</a>
                    <span className="admin-muted">{formatTime(r.deletedAt)}</span>
                  </div>
                </div>
                <div className="admin-row-actions">
                  <button className="admin-btn" type="button" disabled={busyKey !== null} onClick={() => void restore("reply", r.id)}>Restore</button>
                </div>
              </div>
            ))}
          </div>
          {nextReplyCursor !== null && (
            <button className="admin-btn load-more" type="button" onClick={() => void (async () => {
              try {
                const data = await api.admin.deletedContent({ replyCursor: nextReplyCursor, limit: 10 });
                setReplies((prev) => [...prev, ...data.replies]);
                setNextReplyCursor(data.nextReplyCursor);
              } catch (err) {
                setNotice(err instanceof ApiError ? err.message : "Could not load more.");
              }
            })()}>Load more replies</button>
          )}
          {discussions.length === 0 && replies.length === 0 && <div className="empty-state">No deleted content.</div>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- audit

function AuditSection() {
  const [items, setItems] = useState<ModerationAction[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.moderation
      .actions({ limit: 30 })
      .then((data) => { if (!alive) return; setItems(data.items); setNextCursor(data.nextCursor ? Number(data.nextCursor) : null); })
      .catch((err) => { if (alive) setError(err instanceof ApiError ? err.message : "Could not load audit log."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return (
    <>
      <header><h2>Audit log</h2><p>Every moderation and admin action, most recent first.</p></header>
      {error && <div className="empty-state">{error}</div>}
      {loading ? (
        <Loading />
      ) : (
        <div className="admin-list content-fade">
          {items.map((action) => (
            <div className="admin-row" key={action.id}>
              <div className="admin-row-main">
                <strong>{action.action}</strong>
                <span className="admin-muted">{action.actor.displayName} (@{action.actor.username}) → {action.targetType}#{action.targetId}</span>
                {action.reason && <span className="admin-muted">· {action.reason}</span>}
              </div>
              <div className="admin-row-tags"><span className="admin-muted">{formatTime(action.createdAt)}</span></div>
            </div>
          ))}
        </div>
      )}
      {!loading && nextCursor !== null && (
        <button className="admin-btn load-more" type="button" onClick={() => void (async () => {
          try {
            const data = await api.moderation.actions({ cursor: nextCursor, limit: 30 });
            setItems((prev) => [...prev, ...data.items]);
            setNextCursor(data.nextCursor ? Number(data.nextCursor) : null);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Could not load more.");
          }
        })()}>Load more</button>
      )}
      {!loading && items.length === 0 && <div className="empty-state">No moderation actions yet.</div>}
    </>
  );
}

// ---------------------------------------------------------------- shell

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="shell topbar-inner">
          <a href="/" className="wordmark" aria-label="Samryetha home">Samryetha</a>
          <nav className="primary-nav" aria-label="Primary navigation">
            <a className="nav-link" href="/" data-view="latest">Latest</a>
            <a className="nav-link" href="/" data-view="followed">Followed</a>
            <a className="nav-link" href="/" data-view="boards">Boards</a>
          </nav>
          <div className="actions">
            <label className="search-field">
              <SearchIcon />
              <span className="sr-only">Search discussions</span>
              <input type="search" placeholder="Search discussions" autoComplete="off" />
            </label>
            <UserMenu current="admin" />
            <a className="compose" href="/post">Post</a>
          </div>
        </div>
      </header>
      {children}
    </>
  );
}
