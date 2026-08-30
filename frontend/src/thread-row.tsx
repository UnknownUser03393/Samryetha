import type { ThreadSummary } from "./lib/api";
import { formatTime } from "./lib/format";

export function ThreadRow({ thread, showSender = true }: { thread: ThreadSummary; showSender?: boolean }) {
  return (
    <a className="thread" href={`/d/${thread.id}`}>
      <div className="thread-main">
        <h3 className="thread-title">{thread.title}</h3>
        {thread.preview && <p className="thread-preview">{thread.preview}</p>}
        <div className="meta">
          {showSender && (
            <>
              <span className="sender">{thread.author.displayName}</span>
              <span className="dot" />
            </>
          )}
          <span className="tag">{thread.board.name}</span>
          <span className="dot" />
          <span>{formatTime(thread.lastActivityAt)}</span>
        </div>
      </div>
      <div className="count" aria-label={`${thread.replyCount} replies`} title={`${thread.replyCount} replies`}>
        {thread.replyCount}
      </div>
    </a>
  );
}
