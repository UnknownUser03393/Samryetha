import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";

/**
 * SSE 实时通道：客户端连上后，进程内事件总线把属于该用户的事件实时推下来。
 * 断线重连由客户端重拉通知兜底（EventBus 是瞬时通道，不保证可靠）。
 */
export function registerRealtimeRoutes(app: FastifyInstance, container: Container): void {
  app.route({
    method: "GET",
    url: "/api/events",
    sse: "only",
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const session = requireActiveUser(request);
      const userId = session.id;

      // 建连心跳，告诉客户端 channel 就绪
      await reply.sse.send({ event: "connected", data: JSON.stringify({ userId, at: Date.now() }) });

      const unsubscribe = container.events.subscribe("notification.created", (ev) => {
        const d = ev.data as { userId?: number } | undefined;
        if (d?.userId !== userId) return;
        void reply.sse.send({ event: "notification.created", data: JSON.stringify(d) });
      });
      reply.sse.onClose(() => unsubscribe());

      // 保持连接直到客户端断开
      reply.sse.keepAlive();
    },
  });
}
