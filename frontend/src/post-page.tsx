import { FormEvent, useEffect, useRef, useState } from "react";
import { AppShell } from "./app-shell";
import { api, ApiError, type BoardSummary } from "./lib/api";
import { useAuth } from "./lib/auth";

export function PostPage({ onPublished }: { onPublished: (id: number) => void }) {
  const { user, loading } = useAuth();
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedBoard, setSelectedBoard] = useState<BoardSummary | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const boardPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.boards
      .list()
      .then((data) => {
        setBoards(data.items);
        setSelectedBoard((current) => current ?? data.items[0] ?? null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!boardOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!boardPickerRef.current?.contains(event.target as Node)) setBoardOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBoardOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [boardOpen]);

  const moveBoard = (direction: -1 | 1) => {
    if (boards.length === 0 || !selectedBoard) return;
    const current = boards.findIndex((option) => option.slug === selectedBoard.slug);
    setSelectedBoard(boards[(current + direction + boards.length) % boards.length]);
    setBoardOpen(true);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || !body.trim() || !selectedBoard || submitting) return;
    setSubmitting(true);
    setError(null);
    setHint(null);
    try {
      const created = await api.discussions.create({
        boardSlug: selectedBoard.slug,
        title: title.trim(),
        bodyMarkdown: body.trim(),
      });
      onPublished(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not post. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!loading && !user) {
    return (
      <AppShell current="post">
        <main className="shell post-layout">
          <section className="post-editor" aria-labelledby="post-title">
            <div className="post-heading"><h1 className="feed-title" id="post-title">New discussion</h1></div>
            <div className="empty-state">
              Sign in to start a discussion. <a className="sender" href="/login">Sign in</a>
            </div>
          </section>
        </main>
      </AppShell>
    );
  }

  return (
    <AppShell current="post">
      <main className="shell post-layout">
        <section className="post-editor" aria-labelledby="post-title">
          <div className="post-heading">
            <h1 className="feed-title" id="post-title">New discussion</h1>
          </div>

          <form className="post-form" onSubmit={submit} noValidate>
              <div className="post-title-row">
                <label className="form-field">
                  <span className="sr-only">Title</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} placeholder="What do you want to discuss?" autoFocus />
                  <small>{title.length}/100</small>
                </label>

                <div className="form-field compact-field board-picker" ref={boardPickerRef}>
                  <span className="sr-only">Board</span>
                  <button
                    className={`board-select ${boardOpen ? "open" : ""}`}
                    type="button"
                    aria-label="Board"
                    aria-haspopup="listbox"
                    aria-expanded={boardOpen}
                    aria-controls="board-options"
                    onClick={() => setBoardOpen((open) => !open)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") { event.preventDefault(); moveBoard(1); }
                      if (event.key === "ArrowUp") { event.preventDefault(); moveBoard(-1); }
                    }}
                  >
                    <span>{selectedBoard?.name ?? "Choose a board"}</span>
                    <span className="board-chevron" aria-hidden="true" />
                  </button>
                  <div className={`board-options ${boardOpen ? "open" : ""}`} id="board-options" role="listbox" aria-label="Board" aria-hidden={!boardOpen}>
                    {boards.map((option) => (
                      <button
                        className={`board-option ${selectedBoard?.slug === option.slug ? "selected" : ""}`}
                        key={option.slug}
                        type="button"
                        role="option"
                        tabIndex={boardOpen ? 0 : -1}
                        aria-selected={selectedBoard?.slug === option.slug}
                        onClick={() => { setSelectedBoard(option); setBoardOpen(false); }}
                      >
                        <span>{option.name}</span>
                        {selectedBoard?.slug === option.slug && <span className="board-option-mark" aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <label className="form-field body-field">
                <span>Message (markdown supported)</span>
                <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={11} placeholder="Add context, details, or a question…" />
              </label>

              {error && <p className="form-error" role="alert">{error}</p>}
              {hint && <p className="form-hint" role="status">{hint}</p>}

              <div className="editor-actions">
                <button className="attachment-action" type="button" onClick={() => setHint("Attachments aren’t wired up yet — plain text works fine.")}>Add attachment</button>
                <div className="submit-actions">
                  <button className="draft-action" type="button" disabled>Save draft</button>
                  <button className="primary-action" type="submit" disabled={!title.trim() || !body.trim() || !selectedBoard || submitting}>{submitting ? "Posting…" : "Post discussion"}</button>
                </div>
              </div>
          </form>
        </section>

        <aside className="post-aside" aria-label="Posting guidance">
          <h2>Before you post</h2>
          <ol>
            <li><span>01</span><p><strong>Choose the closest board.</strong> It helps the right people find your discussion.</p></li>
            <li><span>02</span><p><strong>Make the title specific.</strong> A clear title usually gets a better answer.</p></li>
            <li><span>03</span><p><strong>Keep personal details private.</strong> This space is visible across campus.</p></li>
          </ol>
          <p className="community-note">Be curious, constructive, and kind.</p>
        </aside>
      </main>
    </AppShell>
  );
}
