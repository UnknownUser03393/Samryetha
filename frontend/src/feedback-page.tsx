import { useEffect, useMemo, useState, type FormEvent } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AppShell } from "./app-shell";
import { Loading } from "./loading";
import {
  api,
  ApiError,
  type FeedbackItem,
  type FeedbackProjectSummary,
  type FeedbackStatus,
  type FeedbackType,
  type FeedbackUrgency,
} from "./lib/api";
import { useAuth } from "./lib/auth";
import { formatTime } from "./lib/format";

type TypeFilter = "" | FeedbackType;
type UrgencyFilter = "" | FeedbackUrgency;
type SortKey = "latest" | "urgent" | "oldest";

const TYPE_LABEL: Record<FeedbackType, string> = { bug: "Bug", suggestion: "Suggestion" };
const URGENCY_LABEL: Record<FeedbackUrgency, string> = { urgent: "Urgent", normal: "Normal" };
const STATUS_LABEL: Record<FeedbackStatus, string> = { open: "Open", done: "Done", expired: "Expired" };

export function FeedbackPage() {
  const { user, loading } = useAuth();
  const [projects, setProjects] = useState<FeedbackProjectSummary[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<number | null>(null);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("");
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("");
  const [sort, setSort] = useState<SortKey>("latest");
  const [scope, setScope] = useState<"all" | "mine">("all");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<FeedbackItem | null>(null);
  const [form, setForm] = useState({ title: "", detail: "", type: "suggestion" as FeedbackType, urgency: "normal" as FeedbackUrgency });
  const [formError, setFormError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<FeedbackItem | null>(null);

  useEffect(() => {
    if (!user) return;
    api.feedback
      .myProjects()
      .then(({ items: list }) => {
        setProjects(list);
        if (list.length) setCurrentProjectId((prev) => (list.some((p) => p.id === prev) ? prev : list[0].id));
      })
      .catch(() => setProjects([]));
  }, [user]);

  useEffect(() => {
    if (currentProjectId == null) {
      setItems([]);
      return;
    }
    let alive = true;
    setLoadingItems(true);
    setLoadError("");
    api.feedback
      .list(currentProjectId)
      .then((data) => {
        if (!alive) return;
        setItems(data.items);
        setCanManage(data.canManage);
      })
      .catch(() => {
        if (alive) setLoadError("Failed to load feedback.");
      })
      .finally(() => {
        if (alive) setLoadingItems(false);
      });
    return () => {
      alive = false;
    };
  }, [currentProjectId]);

  const me = user?.id;

  const visible = useMemo(() => {
    const kw = query.trim().toLowerCase();
    let list = items.filter((i) => {
      if (scope === "mine" && i.author.id !== me) return false;
      if (typeFilter && i.type !== typeFilter) return false;
      if (urgencyFilter && i.urgency !== urgencyFilter) return false;
      if (kw) {
        if (!i.title.toLowerCase().includes(kw) && !i.detail.toLowerCase().includes(kw) && !i.author.handle.toLowerCase().includes(kw)) return false;
      }
      return true;
    });
    if (sort === "urgent") list = [...list].sort((a, b) => (a.urgency === b.urgency ? b.createdAt - a.createdAt : a.urgency === "urgent" ? -1 : 1));
    else if (sort === "oldest") list = [...list].sort((a, b) => a.createdAt - b.createdAt);
    else list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [items, query, typeFilter, urgencyFilter, sort, scope, me]);

  const openItems = visible.filter((i) => i.status === "open");
  const closedItems = visible.filter((i) => i.status !== "open");
  const stats = useMemo(
    () => ({
      bug: items.filter((i) => i.type === "bug").length,
      suggestion: items.filter((i) => i.type === "suggestion").length,
      urgent: items.filter((i) => i.urgency === "urgent").length,
      done: items.filter((i) => i.status === "done").length,
      expired: items.filter((i) => i.status === "expired").length,
    }),
    [items],
  );

  if (!loading && !user) {
    return (
      <AppShell>
        <main className="shell feedback-layout">
          <section className="feedback-main">
            <div className="empty-state">
              Sign in to view and submit feedback. <a className="sender" href="/login">Sign in</a>
            </div>
          </section>
        </main>
      </AppShell>
    );
  }

  const openCreate = () => {
    setEditing(null);
    setForm({ title: "", detail: "", type: "suggestion", urgency: "normal" });
    setFormError("");
    setModalOpen(true);
  };

  const openEdit = (item: FeedbackItem) => {
    setEditing(item);
    setForm({ title: item.title, detail: item.detail, type: item.type, urgency: item.urgency });
    setFormError("");
    setModalOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.title.trim()) {
      setFormError("Title is required.");
      return;
    }
    try {
      if (editing) {
        await api.feedback.update(editing.id, { title: form.title.trim(), detail: form.detail, type: form.type, urgency: form.urgency });
      } else if (currentProjectId != null) {
        await api.feedback.create({ projectId: currentProjectId, title: form.title.trim(), detail: form.detail, type: form.type, urgency: form.urgency });
      }
      setModalOpen(false);
      const data = await api.feedback.list(currentProjectId!);
      setItems(data.items);
      setCanManage(data.canManage);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to save.");
    }
  };

  const setStatus = async (item: FeedbackItem, status: FeedbackStatus) => {
    try {
      const updated = await api.feedback.setStatus(item.id, status);
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch {
      setLoadError("Failed to update status.");
    }
  };

  const confirmDeleteAction = async () => {
    if (!confirmDelete) return;
    try {
      await api.feedback.del(confirmDelete.id);
      setItems((prev) => prev.filter((i) => i.id !== confirmDelete.id));
    } catch {
      setLoadError("Failed to delete.");
    }
    setConfirmDelete(null);
  };

  const renderRow = (item: FeedbackItem) => {
    const isOwner = item.author.id === me;
    const canEdit = isOwner || canManage;
    return (
      <div className="admin-row" key={item.id}>
        <div className="admin-row-main">
          <strong>
            <span className="fb-seq">#{item.seq}</span> {item.title}
          </strong>
          <div className="admin-row-tags">
            <span className={`admin-badge ${item.type === "bug" ? "bug" : "suggestion"}`}>{TYPE_LABEL[item.type]}</span>
            {item.urgency === "urgent" ? <span className="admin-badge urgent">Urgent</span> : null}
            {item.status !== "open" ? <span className={`admin-badge ${item.status}`}>{STATUS_LABEL[item.status]}</span> : null}
            <span className="admin-muted">
              by <b>{item.author.handle}</b> · {formatTime(item.createdAt)}
              {item.closedAt ? ` · closed ${formatTime(item.closedAt)}` : ""}
              {item.editedAt ? ` · edited ${formatTime(item.editedAt)}` : ""}
            </span>
          </div>
          {item.detail ? <span className="admin-muted fb-detail">{item.detail}</span> : null}
        </div>
        <div className="admin-row-actions">
          {canManage && item.status === "open" && (
            <>
              <button className="admin-btn" type="button" onClick={() => void setStatus(item, "done")}>Mark done</button>
              <button className="admin-btn" type="button" onClick={() => void setStatus(item, "expired")}>Expire</button>
            </>
          )}
          {canManage && item.status !== "open" && (
            <button className="admin-btn" type="button" onClick={() => void setStatus(item, "open")}>Restore</button>
          )}
          {canEdit && (
            <>
              <button className="admin-btn" type="button" onClick={() => openEdit(item)}>Edit</button>
              <AlertDialog.Root open={confirmDelete?.id === item.id} onOpenChange={(o) => !o && setConfirmDelete(null)}>
                <AlertDialog.Trigger asChild>
                  <button className="admin-btn danger" type="button" onClick={() => setConfirmDelete(item)}>Delete</button>
                </AlertDialog.Trigger>
                <AlertDialog.Portal>
                  <AlertDialog.Overlay className="dialog-overlay" />
                  <AlertDialog.Content className="dialog-content">
                    <AlertDialog.Title className="dialog-title">Delete feedback #{item.seq}?</AlertDialog.Title>
                    <AlertDialog.Description className="dialog-description">
                      This permanently removes the feedback item. You can’t undo this.
                    </AlertDialog.Description>
                    <div className="dialog-actions">
                      <AlertDialog.Cancel asChild>
                        <button type="button" className="action-btn">Cancel</button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action asChild>
                        <button type="button" className="dialog-danger" onClick={() => void confirmDeleteAction()}>Delete</button>
                      </AlertDialog.Action>
                    </div>
                  </AlertDialog.Content>
                </AlertDialog.Portal>
              </AlertDialog.Root>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <AppShell current="feedback">
      <main className="shell feedback-layout">
        <aside className="feedback-sidebar">
          <h1>Feedback</h1>
          <button className="primary-action feedback-submit" type="button" onClick={openCreate} disabled={!currentProjectId}>Submit feedback</button>
          <nav className="feedback-projects" aria-label="Feedback projects">
            {projects.map((p) => (
              <button
                key={p.id}
                className={`feedback-project ${currentProjectId === p.id ? "active" : ""}`}
                type="button"
                aria-current={currentProjectId === p.id ? "page" : undefined}
                onClick={() => setCurrentProjectId(p.id)}
              >
                <span>{p.name}</span>
                <small>{p.isProgrammer ? "Programmer" : `${p.memberCount} members`}</small>
              </button>
            ))}
          </nav>
        </aside>

        <section className="feedback-main">
          {loadingItems ? (
            <Loading />
          ) : loadError ? (
            <div className="empty-state">{loadError}</div>
          ) : !currentProjectId ? (
            <div className="empty-state">
              {projects.length ? "Select a project to get started." : "You’re not a member of any feedback project yet."}
            </div>
          ) : (
            <>
              <div className="admin-stat-grid">
                <div className="admin-stat"><strong>{items.length}</strong><span>Total</span></div>
                <div className="admin-stat"><strong>{stats.bug}</strong><span>Bugs</span></div>
                <div className="admin-stat"><strong>{stats.suggestion}</strong><span>Suggestions</span></div>
                <div className="admin-stat"><strong>{stats.urgent}</strong><span>Urgent</span></div>
                <div className="admin-stat"><strong>{stats.done}</strong><span>Done</span></div>
                <div className="admin-stat"><strong>{stats.expired}</strong><span>Expired</span></div>
              </div>

              <div className="admin-filters">
                <label className="admin-search">
                  <span className="sr-only">Search feedback</span>
                  <input type="search" placeholder="Search title, detail, author…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <div className="admin-pills">
                  {(["", "bug", "suggestion"] as TypeFilter[]).map((t) => (
                    <button key={t || "all"} className={`admin-pill ${typeFilter === t ? "active" : ""}`} type="button" onClick={() => setTypeFilter(t)}>
                      {t === "" ? "All types" : TYPE_LABEL[t]}
                    </button>
                  ))}
                  {(["", "urgent", "normal"] as UrgencyFilter[]).map((u) => (
                    <button key={u || "allu"} className={`admin-pill ${urgencyFilter === u ? "active" : ""}`} type="button" onClick={() => setUrgencyFilter(u)}>
                      {u === "" ? "All urgency" : URGENCY_LABEL[u]}
                    </button>
                  ))}
                </div>
                <label className="admin-select">
                  <span className="sr-only">Sort</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                    <option value="latest">Latest first</option>
                    <option value="urgent">Urgent first</option>
                    <option value="oldest">Oldest first</option>
                  </select>
                </label>
                <div className="admin-pills">
                  <button className={`admin-pill ${scope === "all" ? "active" : ""}`} type="button" onClick={() => setScope("all")}>All</button>
                  <button className={`admin-pill ${scope === "mine" ? "active" : ""}`} type="button" onClick={() => setScope("mine")}>Mine</button>
                </div>
              </div>

              <div className="admin-list content-fade">
                {openItems.length === 0 ? <div className="empty-state">No open feedback here.</div> : openItems.map(renderRow)}
              </div>

              {closedItems.length > 0 && (
                <details className="feedback-closed">
                  <summary>Completed / expired ({closedItems.length})</summary>
                  <div className="admin-list">{closedItems.map(renderRow)}</div>
                </details>
              )}
            </>
          )}
        </section>
      </main>

      {modalOpen && (
        <div className="dialog-overlay" onClick={() => setModalOpen(false)}>
          <div className="dialog-content feedback-modal" role="dialog" aria-modal="true" aria-label={editing ? `Edit feedback #${editing.seq}` : "Submit feedback"} onClick={(e) => e.stopPropagation()}>
            <h2 className="dialog-title">{editing ? `Edit feedback #${editing.seq}` : "Submit feedback"}</h2>
            <form onSubmit={submit}>
              <label className="form-field">
                <span>Title</span>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} placeholder="One-line summary" autoFocus />
              </label>
              <div className="feedback-field-row">
                <label className="form-field">
                  <span>Type</span>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as FeedbackType })}>
                    <option value="bug">Bug</option>
                    <option value="suggestion">Suggestion</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>Urgency</span>
                  <select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value as FeedbackUrgency })}>
                    <option value="normal">Normal</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
              </div>
              <label className="form-field">
                <span>Detail</span>
                <textarea value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} maxLength={5000} rows={5} placeholder="Steps to reproduce, expected behavior…" />
              </label>
              {formError && <div className="dialog-error">{formError}</div>}
              <div className="dialog-actions">
                <button type="button" className="action-btn" onClick={() => setModalOpen(false)}>Cancel</button>
                <button type="submit" className="primary-action">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
