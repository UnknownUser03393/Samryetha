import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";
import { Abilities, assertCan } from "../authz/can.js";
import { notFound } from "../app/error.js";
import { registerFeedbackAgentApi, registerFeedbackAdminKeys } from "./agent.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const feedbackBody = z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(1).max(120),
  detail: z.string().max(5000).optional(),
  type: z.enum(["bug", "suggestion"]),
  urgency: z.enum(["urgent", "normal"]).optional(),
});

const feedbackPatch = z.object({
  title: z.string().min(1).max(120).optional(),
  detail: z.string().max(5000).optional(),
  type: z.enum(["bug", "suggestion"]).optional(),
  urgency: z.enum(["urgent", "normal"]).optional(),
});

const statusBody = z.object({ status: z.enum(["done", "expired", "open"]) });

const projectBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
});

const projectPatch = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
});

const membersBody = z.object({
  members: z.array(z.object({ userId: z.number().int().positive(), isProgrammer: z.boolean() })).max(500),
});

export function registerFeedbackModule(app: FastifyInstance, container: Container): void {
  const { feedbackService, feedbackBackupService } = container;

  /* ---------- 反馈列表 / 提交 ---------- */

  app.route({
    method: "GET",
    url: "/api/feedback/projects/mine",
    handler: async (request) => {
      const session = requireActiveUser(request);
      return { items: await feedbackService.listMyProjects(session.id, session.role === "admin") };
    },
  });

  app.route({
    method: "GET",
    url: "/api/feedback",
    schema: { querystring: z.object({ projectId: z.coerce.number().int().positive() }) },
    handler: async (request: FastifyRequest<{ Querystring: { projectId: number } }>) => {
      const session = requireActiveUser(request);
      const project = await feedbackService.getProjectForAuthz(request.query.projectId);
      if (!project) throw notFound("Project not found");
      await assertCan(session, Abilities.feedbackView, { type: "feedbackProject", id: project.id }, container);
      return feedbackService.listFeedback(session.id, session.role === "admin", project.id);
    },
  });

  app.route({
    method: "POST",
    url: "/api/feedback",
    schema: { body: feedbackBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof feedbackBody> }>, reply) => {
      const session = requireActiveUser(request);
      const project = await feedbackService.getProjectForAuthz(request.body.projectId);
      if (!project) throw notFound("Project not found");
      await assertCan(session, Abilities.feedbackCreate, { type: "feedbackProject", id: project.id }, container);
      const item = await feedbackService.createFeedback(session.id, request.body);
      return reply.code(201).send(item);
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/feedback/:id",
    schema: { params: idParam, body: feedbackPatch },
    handler: async (request: FastifyRequest<{ Params: { id: number }; Body: z.infer<typeof feedbackPatch> }>) => {
      const session = requireActiveUser(request);
      const item = await feedbackService.getItemForAuthz(request.params.id);
      if (!item) throw notFound("Feedback item not found");
      await assertCan(session, Abilities.feedbackUpdate, { type: "feedbackItem", ...item }, container);
      return feedbackService.updateFeedback(request.params.id, request.body);
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/feedback/:id",
    schema: { params: idParam },
    handler: async (request: FastifyRequest<{ Params: { id: number } }>) => {
      const session = requireActiveUser(request);
      const item = await feedbackService.getItemForAuthz(request.params.id);
      if (!item) throw notFound("Feedback item not found");
      await assertCan(session, Abilities.feedbackDelete, { type: "feedbackItem", ...item }, container);
      await feedbackService.deleteFeedback(session.id, request.params.id);
      return { ok: true };
    },
  });

  app.route({
    method: "POST",
    url: "/api/feedback/:id/status",
    schema: { params: idParam, body: statusBody },
    handler: async (request: FastifyRequest<{ Params: { id: number }; Body: { status: "done" | "expired" | "open" } }>) => {
      const session = requireActiveUser(request);
      const item = await feedbackService.getItemForAuthz(request.params.id);
      if (!item) throw notFound("Feedback item not found");
      await assertCan(session, Abilities.feedbackManage, { type: "feedbackItem", ...item }, container);
      return feedbackService.setFeedbackStatus(request.params.id, request.body.status);
    },
  });

  /* ---------- 管理员：项目 / 成员 ---------- */

  app.route({
    method: "GET",
    url: "/api/feedback/projects",
    handler: async (request) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.feedbackProjectManage, null, container);
      return { items: await feedbackService.listProjectsForAdmin() };
    },
  });

  app.route({
    method: "POST",
    url: "/api/feedback/projects",
    schema: { body: projectBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof projectBody> }>, reply) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.feedbackProjectManage, null, container);
      const project = await feedbackService.createProject(session.id, request.body);
      return reply.code(201).send(project);
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/feedback/projects/:id",
    schema: { params: idParam, body: projectPatch },
    handler: async (request: FastifyRequest<{ Params: { id: number }; Body: z.infer<typeof projectPatch> }>) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.feedbackProjectManage, null, container);
      await feedbackService.updateProject(request.params.id, request.body);
      return { ok: true };
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/feedback/projects/:id",
    schema: { params: idParam },
    handler: async (request: FastifyRequest<{ Params: { id: number } }>) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.feedbackProjectManage, null, container);
      await feedbackService.deleteProject(session.id, request.params.id);
      return { ok: true };
    },
  });

  app.route({
    method: "PUT",
    url: "/api/feedback/projects/:id/members",
    schema: { params: idParam, body: membersBody },
    handler: async (request: FastifyRequest<{ Params: { id: number }; Body: z.infer<typeof membersBody> }>) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.feedbackProjectManage, null, container);
      await feedbackService.setProjectMembers(request.params.id, request.body.members);
      return { ok: true };
    },
  });

  /* ---------- 管理员：备份 / Agent 密钥 / Agent API ---------- */

  app.route({
    method: "GET",
    url: "/api/admin/feedback/backups",
    handler: async (request) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.adminView, null, container);
      return { backups: await feedbackBackupService.list(), settings: await feedbackBackupService.getSettings() };
    },
  });

  app.route({
    method: "POST",
    url: "/api/admin/feedback/backups/create",
    handler: async (request) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.adminView, null, container);
      return { backup: await feedbackBackupService.create() };
    },
  });

  app.route({
    method: "POST",
    url: "/api/admin/feedback/backups/restore",
    schema: { body: z.object({ name: z.string().min(1).max(100) }) },
    handler: async (request: FastifyRequest<{ Body: { name: string } }>) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.adminView, null, container);
      await feedbackBackupService.restore(request.body.name);
      return { ok: true, restartRequired: true };
    },
  });

  app.route({
    method: "PUT",
    url: "/api/admin/feedback/backups/settings",
    schema: { body: z.object({ backupCron: z.string().max(100), backupKeep: z.number().int().min(1).max(500) }) },
    handler: async (request: FastifyRequest<{ Body: { backupCron: string; backupKeep: number } }>) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.adminView, null, container);
      await feedbackBackupService.setSettings(request.body);
      await feedbackBackupService.start(); // 重读设置并重排 cron
      return { ok: true };
    },
  });

  registerFeedbackAdminKeys(app, container);
  registerFeedbackAgentApi(app, container);
}
