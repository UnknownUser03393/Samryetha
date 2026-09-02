import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import type { DbProvider } from "../infrastructure/db/client.js";
import { and, eq } from "drizzle-orm";
import { feedbackApiKeys, type FeedbackKeyRole } from "../infrastructure/db/schema.js";
import { authRequired, forbidden, notFound, badRequest } from "../app/error.js";
import { requireActiveUser } from "../app/auth-hook.js";
import { Abilities, assertCan } from "../authz/can.js";
import type { FeedbackItemDTO, FeedbackService } from "./service.js";

const AGENT_KEY_PREFIX = "fb-agent:";
const KEY_PREFIX_SHOW = "fb_";

export function hashAgentKey(key: string): string {
  return createHash("sha256").update(AGENT_KEY_PREFIX + key).digest("hex");
}

export function generateAgentKey(): string {
  return KEY_PREFIX_SHOW + randomBytes(24).toString("hex");
}

export interface AgentKeyDTO {
  id: number;
  name: string;
  prefix: string;
  role: FeedbackKeyRole;
  projectIds: number[];
  enabled: boolean;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface AgentKeyInput {
  name: string;
  role: FeedbackKeyRole;
  projectIds: number[];
}

export interface AgentService {
  listKeys(): Promise<AgentKeyDTO[]>;
  createKey(input: AgentKeyInput): Promise<{ key: string; keyRow: AgentKeyDTO }>;
  setKeyEnabled(id: number, enabled: boolean): Promise<void>;
  deleteKey(id: number): Promise<void>;
  verifyKey(rawKey: string): Promise<AgentKeyDTO | null>;
}

export function createAgentService(db: DbProvider, feedbackService: FeedbackService): AgentService {
  async function rowToDTO(row: typeof feedbackApiKeys.$inferSelect): Promise<AgentKeyDTO> {
    return {
      id: row.id,
      name: row.name,
      prefix: row.key_prefix,
      role: row.role,
      projectIds: row.project_ids,
      enabled: Boolean(row.enabled),
      lastUsedAt: row.last_used_at ? row.last_used_at.getTime() : null,
      createdAt: row.created_at.getTime(),
    };
  }

  return {
    async listKeys() {
      const rows = await db.db.select().from(feedbackApiKeys).orderBy(feedbackApiKeys.created_at);
      return Promise.all(rows.map(rowToDTO));
    },

    async createKey(input) {
      const key = generateAgentKey();
      const [row] = await db.db
        .insert(feedbackApiKeys)
        .values({
          name: input.name,
          key_hash: hashAgentKey(key),
          key_prefix: key.slice(0, 8),
          role: input.role,
          project_ids: input.projectIds,
        })
        .returning();
      return { key, keyRow: await rowToDTO(row) };
    },

    async setKeyEnabled(id, enabled) {
      const row = await db.db.select().from(feedbackApiKeys).where(eq(feedbackApiKeys.id, id)).get();
      if (!row) throw notFound("API key not found");
      await db.db.update(feedbackApiKeys).set({ enabled: enabled ? 1 : 0 }).where(eq(feedbackApiKeys.id, id));
    },

    async deleteKey(id) {
      const row = await db.db.select().from(feedbackApiKeys).where(eq(feedbackApiKeys.id, id)).get();
      if (!row) throw notFound("API key not found");
      await db.db.delete(feedbackApiKeys).where(eq(feedbackApiKeys.id, id));
    },

    async verifyKey(rawKey) {
      if (!rawKey) return null;
      const row = await db.db
        .select()
        .from(feedbackApiKeys)
        .where(and(eq(feedbackApiKeys.key_hash, hashAgentKey(rawKey)), eq(feedbackApiKeys.enabled, 1)))
        .get();
      if (!row) return null;
      await db.db.update(feedbackApiKeys).set({ last_used_at: new Date() }).where(eq(feedbackApiKeys.id, row.id));
      return rowToDTO(row);
    },
  };
}

function extractKey(request: FastifyRequest): string | null {
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function agentCanAccessProject(agent: AgentKeyDTO, projectId: number): boolean {
  return agent.projectIds.length === 0 || agent.projectIds.includes(projectId);
}

export function registerFeedbackAgentApi(app: FastifyInstance, container: Container): void {
  const { feedbackService } = container;
  const agent = createAgentService(container.db, feedbackService);

  const requireAgent = async (request: FastifyRequest): Promise<AgentKeyDTO> => {
    const key = await agent.verifyKey(extractKey(request) ?? "");
    if (!key) throw authRequired("Invalid or missing API key");
    return key;
  };

  const requireWrite = async (request: FastifyRequest): Promise<AgentKeyDTO> => {
    const key = await requireAgent(request);
    if (key.role !== "write") throw forbidden("This API key is read-only");
    return key;
  };

  const taskSummary = (items: FeedbackItemDTO[]) => ({
    open: items.filter((i) => i.status === "open").length,
    done: items.filter((i) => i.status === "done").length,
    expired: items.filter((i) => i.status === "expired").length,
  });

  const listProjects = async () => (await feedbackService.listProjectsForAdmin()).map((p) => ({ id: p.id, name: p.name, description: p.description }));

  // 超媒体索引：免 key，AI 一条 curl 自助发现全部端点
  app.route({
    method: "GET",
    url: "/api/agent/v1",
    handler: async () => ({
      name: "Samryetha Feedback Agent API",
      version: "v1",
      auth: 'Header "X-Api-Key: <key>" (or Authorization: Bearer <key>)',
      endpoints: {
        index: { method: "GET", path: "/api/agent/v1", auth: "none" },
        readme: { method: "GET", path: "/api/agent/v1/README", auth: "none" },
        projects: { method: "GET", path: "/api/agent/v1/projects", auth: "any key" },
        tasks: { method: "GET", path: "/api/agent/v1/tasks", auth: "any key", query: "?projectId=&status=&type=" },
        task: { method: "GET", path: "/api/agent/v1/tasks/:id", auth: "any key" },
        status: { method: "POST", path: "/api/agent/v1/tasks/:id/status", auth: "write key", body: '{"status":"done"|"open"}' },
      },
    }),
  });

  app.route({
    method: "GET",
    url: "/api/agent/v1/README",
    handler: async () =>
      [
        "# Samryetha Feedback Agent API",
        "",
        "GET /api/agent/v1              端点索引（免 key）",
        "GET /api/agent/v1/projects     该 key 可访问的项目",
        "GET /api/agent/v1/tasks        任务列表 + open/done/expired 汇总，支持 ?projectId=&status=&type=",
        "GET /api/agent/v1/tasks/:id    单任务详情",
        "POST /api/agent/v1/tasks/:id/status  {status: \"done\"|\"open\"}（需 write 权限）",
        "",
        "鉴权头：X-Api-Key: <key>",
      ].join("\n"),
  });

  app.route({
    method: "GET",
    url: "/api/agent/v1/projects",
    handler: async (request) => {
      const key = await requireAgent(request);
      const all = await listProjects();
      return { items: all.filter((p) => agentCanAccessProject(key, p.id)) };
    },
  });

  const tasksQuery = z.object({
    projectId: z.coerce.number().int().positive().optional(),
    status: z.enum(["open", "done", "expired"]).optional(),
    type: z.enum(["bug", "suggestion"]).optional(),
  });

  app.route({
    method: "GET",
    url: "/api/agent/v1/tasks",
    schema: { querystring: tasksQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof tasksQuery> }>) => {
      const key = await requireAgent(request);
      const { projectId, status, type } = request.query;
      if (projectId && !agentCanAccessProject(key, projectId)) throw forbidden("This API key cannot access this project");
      let items = await feedbackService.listFeedbackForAgent(projectId);
      items = items.filter((i) => agentCanAccessProject(key, i.projectId));
      if (status) items = items.filter((i) => i.status === status);
      if (type) items = items.filter((i) => i.type === type);
      return { items, summary: taskSummary(items) };
    },
  });

  app.route({
    method: "GET",
    url: "/api/agent/v1/tasks/:id",
    schema: { params: z.object({ id: z.coerce.number().int().positive() }) },
    handler: async (request: FastifyRequest<{ Params: { id: number } }>) => {
      const key = await requireAgent(request);
      const item = await feedbackService.getFeedbackForAgent(request.params.id);
      if (!item) throw notFound("Task not found");
      if (!agentCanAccessProject(key, item.projectId)) throw forbidden("This API key cannot access this project");
      return item;
    },
  });

  app.route({
    method: "POST",
    url: "/api/agent/v1/tasks/:id/status",
    schema: {
      params: z.object({ id: z.coerce.number().int().positive() }),
      body: z.object({ status: z.enum(["done", "open"]) }),
    },
    handler: async (request: FastifyRequest<{ Params: { id: number }; Body: { status: "done" | "open" } }>) => {
      const key = await requireWrite(request);
      const item = await feedbackService.getFeedbackForAgent(request.params.id);
      if (!item) throw notFound("Task not found");
      if (!agentCanAccessProject(key, item.projectId)) throw forbidden("This API key cannot access this project");
      const updated = await feedbackService.setFeedbackStatus(request.params.id, request.body.status);
      return updated;
    },
  });
}

export function registerFeedbackAdminKeys(app: FastifyInstance, container: Container): void {
  const agent = createAgentService(container.db, container.feedbackService);

  // 密钥管理属敏感操作，必须登录且具备 admin 权限
  // Key management is sensitive and requires an authenticated admin
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const session = requireActiveUser(request);
    await assertCan(session, Abilities.adminView, null, container);
  };

  app.route({
    method: "GET",
    url: "/api/admin/feedback/keys",
    handler: async (request) => {
      await requireAdmin(request);
      return { items: await agent.listKeys() };
    },
  });

  const keyBody = z.object({
    name: z.string().min(1).max(64),
    role: z.enum(["read", "write"]),
    projectIds: z.array(z.number().int().positive()).default([]),
  });

  app.route({
    method: "POST",
    url: "/api/admin/feedback/keys",
    schema: { body: keyBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof keyBody> }>, reply) => {
      await requireAdmin(request);
      // 过滤掉不存在的项目 id
      const projects = await container.feedbackService.listProjectsForAdmin();
      const validIds = new Set(projects.map((p) => p.id));
      const projectIds = request.body.projectIds.filter((id) => validIds.has(id));
      const { key, keyRow } = await agent.createKey({ name: request.body.name, role: request.body.role, projectIds });
      return reply.code(201).send({ key, keyRow });
    },
  });

  app.route({
    method: "PUT",
    url: "/api/admin/feedback/keys/:id",
    schema: { params: z.object({ id: z.coerce.number().int().positive() }), body: z.object({ enabled: z.boolean() }) },
    handler: async (request: FastifyRequest<{ Params: { id: number }; Body: { enabled: boolean } }>) => {
      await requireAdmin(request);
      await agent.setKeyEnabled(request.params.id, request.body.enabled);
      return { ok: true };
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/admin/feedback/keys/:id",
    schema: { params: z.object({ id: z.coerce.number().int().positive() }) },
    handler: async (request: FastifyRequest<{ Params: { id: number } }>) => {
      await requireAdmin(request);
      await agent.deleteKey(request.params.id);
      return { ok: true };
    },
  });
}
