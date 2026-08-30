/**
 * Outbox：业务事务内写入的可靠事件（transactional outbox）。
 *
 * 业务代码在 db.tx() 内调用 emitter.emit(event)，事件行随业务数据同事务提交；
 * OutboxWorker 轮询消费，把副作用（通知 / 搜索 reindex / 邮件）dispatch 给注册的 handler。
 * 绝不把异步副作用直接写进业务事务里。
 */

export interface OutboxEvent {
  /** 形如 "discussion.created" / "reply.created" */
  type: string;
  aggregate?: { type: string; id: string };
  payload?: Record<string, unknown>;
}

/** 业务代码在事务内使用的唯一出口。 */
export interface OutboxEmitter {
  emit(event: OutboxEvent): Promise<void>;
}

export type OutboxHandler = (
  event: Omit<OutboxEvent, "type"> & { type: string; attempts: number },
) => Promise<void>;

export interface OutboxDispatcher {
  on(eventType: string, handler: OutboxHandler): void;
  handlersFor(eventType: string): OutboxHandler[];
}

export interface OutboxWorker {
  start(): void;
  stop(): Promise<void>;
}
