/**
 * 进程内事件总线（瞬时通道），供 SSE / presence 做实时推送。
 * outbox 处理完成后 publish 到这里；未来多实例换 Redis pub/sub，业务代码不变。
 * 注意：这是"即时"通道，不是可靠投递，断线重连靠客户端重拉通知兜底。
 */
export interface DomainEvent {
  type: string;
  data?: unknown;
}

export interface EventBus {
  publish(event: DomainEvent): void;
  subscribe(eventType: string, handler: (event: DomainEvent) => void): () => void;
}
