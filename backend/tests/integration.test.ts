import { describe, it, expect, beforeAll, afterAll } from "vitest";

// 必须在加载 env 之前设置（.env 无此键，process.env 优先级最高）
process.env.DATABASE_URL = ":memory:";
process.env.NODE_ENV = "test";

import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { loadEnv } from "../src/config/env.js";
import { buildContainer, type Container } from "../src/app/container.js";
import { buildApp } from "../src/app/server.js";
import { outboxEvents, notifications, users, boards, boardMembers, discussions, moderationActions, bans, reports } from "../src/infrastructure/db/schema.js";
import { can, Abilities, type Actor, type AuthzCtx } from "../src/authz/can.js";
import { createDiscussionService } from "../src/discussions/service.js";
import { FAKE_EMAIL_DOMAIN } from "../src/auth/service.js";

const EMAIL_DOMAIN = "example.edu.cn";
const PASSWORD = "TestPass123!";

let container: Container;
let app: FastifyInstance;
let env: ReturnType<typeof loadEnv>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cookieHeader(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers["set-cookie"];
  const arr = Array.isArray(sc) ? sc : [sc as string];
  return arr.map((c: string) => c.split(";")[0]).join("; ");
}

async function waitForOutbox(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await container.db.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.event_type, type))
      .orderBy(desc(outboxEvents.id))
      .get();
    // 只认最新一条，且必须已消费（processed/failed）
    if (row && row.status !== "pending" && row.payload) {
      return JSON.parse(row.payload) as Record<string, unknown>;
    }
    await sleep(100);
  }
  throw new Error(`outbox event ${type} not processed within ${timeoutMs}ms`);
}

async function registerUser(username: string): Promise<string> {
  // 幂等：已注册则直接登录，避免跨用例重复注册冲突
  const existing = await container.db.db.select().from(users).where(eq(users.username, username)).get();
  if (existing) {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    return cookieHeader(login);
  }
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: PASSWORD },
  });
  expect(reg.statusCode).toBe(201);
  // 模拟管理员审批：pending → active（真实流程走 /api/admin/users/:id/verify）
  await container.db.db
    .update(users)
    .set({ status: "active", email_verified_at: new Date(), updated_at: new Date() })
    .where(eq(users.username, username));
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return cookieHeader(login);
}

function actor(role: string, status = "active", id = 999): Actor {
  return {
    id,
    username: `u${id}`,
    displayName: `U${id}`,
    email: `u${id}@${EMAIL_DOMAIN}`,
    role: role as never,
    status: status as never,
  };
}

beforeAll(async () => {
  env = loadEnv();
  container = await buildContainer(env, { runMigrations: true });
  app = await buildApp(container);
  container.outboxWorker.start();
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await container.close();
});

describe("M0 健康检查", () => {
  it("GET /api/health 返回 ok", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });
});

describe("M1 身份认证", () => {
  it("注册→待审核→管理员通过→登录→me→登出 全链路", async () => {
    // 造一个管理员用于审批
    const adminReg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "rootadmin", password: PASSWORD } });
    expect(adminReg.statusCode).toBe(201);
    await container.db.db
      .update(users)
      .set({ role: "admin", status: "active", email_verified_at: new Date(), updated_at: new Date() })
      .where(eq(users.username, "rootadmin"));
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "rootadmin", password: PASSWORD } });
    expect(adminLogin.statusCode).toBe(200);
    const adminCookie = cookieHeader(adminLogin);

    // 注册新用户 → pending，且分配了 #号
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "bob", password: PASSWORD } });
    expect(reg.statusCode).toBe(201);
    const row = await container.db.db.select().from(users).where(eq(users.username, "bob")).get();
    expect(row!.status).toBe("pending");
    expect(row!.discriminator).toBeGreaterThanOrEqual(1000);
    expect(row!.email).toBe(`bob@${FAKE_EMAIL_DOMAIN}`);

    // pending 用户登录被拒
    const pendingLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "bob", password: PASSWORD } });
    expect(pendingLogin.statusCode).toBe(403);

    // 管理员通过审批
    const approve = await app.inject({ method: "POST", url: `/api/admin/users/${row!.id}/verify`, headers: { cookie: adminCookie } });
    expect(approve.statusCode).toBe(200);
    expect(JSON.parse(approve.body).status).toBe("active");

    // 重复通过 → 409
    const dup = await app.inject({ method: "POST", url: `/api/admin/users/${row!.id}/verify`, headers: { cookie: adminCookie } });
    expect(dup.statusCode).toBe(409);

    // 登录 → me → 登出；handle 形如 bob#NNNN
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "bob", password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const cookie = cookieHeader(login);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).user.status).toBe("active");
    expect(JSON.parse(me.body).user.handle).toMatch(/^bob#\d{4}$/);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(meAfter.statusCode).toBe(401);
  });
});

describe("M2/M3 内容与互动", () => {
  it("学生发帖→回复→作者收到通知", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const admin = await registerUser("admin");

    // 把 admin 提权（测试环境直接改库）
    await container.db.db.update(users).set({ role: "admin" }).where(eq(users.username, "admin"));

    // admin 建 board
    const board = await app.inject({
      method: "POST",
      url: "/api/boards",
      headers: { cookie: admin },
      payload: { slug: "test-board", name: "Test Board", description: "test", visibility: "public", postingPolicy: "everyone" },
    });
    expect(board.statusCode).toBe(201);

    // alice 发帖
    const post = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie: alice },
      payload: { boardSlug: "test-board", title: "Integration test thread", bodyMarkdown: "Hello world" },
    });
    expect(post.statusCode).toBe(201);
    const discussion = JSON.parse(post.body);
    const discussionId = discussion.id;

    // bob 回复
    const reply = await app.inject({
      method: "POST",
      url: `/api/discussions/${discussionId}/replies`,
      headers: { cookie: bob },
      payload: { bodyMarkdown: "Nice thread!" },
    });
    expect(reply.statusCode).toBe(201);

    // 等 outbox 处理 reply.created → 生成通知
    await waitForOutbox("reply.created");
    await sleep(600); // 等 worker 消费完 outbox
    const notif = await app.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { cookie: alice },
    });
    expect(notif.statusCode).toBe(200);
    const items = JSON.parse(notif.body).items;
    expect(items.some((n: { type: string }) => n.type === "reply")).toBe(true);
  });

  it("学生删除他人帖被 403", async () => {
    const eve = await registerUser("eve");
    const mallory = await registerUser("mallory");
    const admin = await registerUser("admin2");
    await container.db.db.update(users).set({ role: "admin" }).where(eq(users.username, "admin2"));

    const board = await app.inject({
      method: "POST",
      url: "/api/boards",
      headers: { cookie: admin },
      payload: { slug: "board-2", name: "Board 2", description: "b", visibility: "public", postingPolicy: "everyone" },
    });
    expect(board.statusCode).toBe(201);

    const post = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie: eve },
      payload: { boardSlug: "board-2", title: "Eve thread", bodyMarkdown: "mine" },
    });
    const discussionId = JSON.parse(post.body).id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/discussions/${discussionId}`,
      headers: { cookie: mallory },
      payload: {},
    });
    expect(del.statusCode).toBe(403);

    const delAdmin = await app.inject({
      method: "DELETE",
      url: `/api/discussions/${discussionId}`,
      headers: { cookie: admin },
      payload: {},
    });
    expect(delAdmin.statusCode).toBe(200);
  });

  it("学生访问治理接口被 403", async () => {
    const student = await registerUser("norm");
    const res = await app.inject({
      method: "GET",
      url: "/api/moderation/actions",
      headers: { cookie: student },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("can() 能力矩阵", () => {
  const ctx = (): AuthzCtx => ({ db: container.db });

  beforeAll(async () => {
    // 准备：board 1 = everyone 公开，board 2 = members 私有；测试成员用户 998
    await container.db.db.insert(boards).values([
      { slug: "board-everyone", name: "Everyone Board", visibility: "public", posting_policy: "everyone" },
      { slug: "board-members", name: "Members Board", visibility: "members", posting_policy: "members" },
    ]);
    await container.db.db.insert(users).values({
      username: "member-user",
      email: "member-user@example.edu.cn",
      display_name: "Member User",
      password_hash: "unused",
      role: "student",
      status: "active",
    });
    const member = await container.db.db.select().from(users).where(eq(users.username, "member-user")).get();
    await container.db.db.insert(boardMembers).values({ board_id: 2, user_id: member!.id, role: "member" });
  });

  it("学生可发帖到 everyone 板", async () => {
    expect(await can(actor("student"), Abilities.discussionCreate, { type: "board", id: 1, visibility: "public", postingPolicy: "everyone" }, ctx())).toBe(true);
  });

  it("学生不可发帖到 members 板（非成员）", async () => {
    expect(await can(actor("student"), Abilities.discussionCreate, { type: "board", id: 2, visibility: "members", postingPolicy: "members" }, ctx())).toBe(false);
  });

  it("board 成员可发帖到 members 板", async () => {
    const member = await container.db.db.select().from(users).where(eq(users.username, "member-user")).get();
    expect(await can(actor("student", "active", member!.id), Abilities.discussionCreate, { type: "board", id: 2, visibility: "members", postingPolicy: "members" }, ctx())).toBe(true);
  });

  it("学生不可删除他人帖", async () => {
    expect(await can(actor("student"), Abilities.discussionDelete, { type: "discussion", id: 1, authorId: 2, boardId: 1, isLocked: 0, deletedAt: null }, ctx())).toBe(false);
  });

  it("作者本人可删除自己的帖", async () => {
    expect(await can(actor("student", "active", 2), Abilities.discussionDelete, { type: "discussion", id: 1, authorId: 2, boardId: 1, isLocked: 0, deletedAt: null }, ctx())).toBe(true);
  });

  it("admin 可删除任意帖", async () => {
    expect(await can(actor("admin"), Abilities.discussionDelete, { type: "discussion", id: 1, authorId: 2, boardId: 1, isLocked: 0, deletedAt: null }, ctx())).toBe(true);
  });

  it("mod/admin 可查看治理，学生不可", async () => {
    expect(await can(actor("moderator"), Abilities.moderationView, null, ctx())).toBe(true);
    expect(await can(actor("admin"), Abilities.moderationView, null, ctx())).toBe(true);
    expect(await can(actor("student"), Abilities.moderationView, null, ctx())).toBe(false);
  });

  it("只有 admin 可解封", async () => {
    expect(await can(actor("moderator"), Abilities.moderationUnban, null, ctx())).toBe(false);
    expect(await can(actor("admin"), Abilities.moderationUnban, null, ctx())).toBe(true);
  });

  it("被封禁用户一切能力为 false", async () => {
    const banned = actor("student", "banned");
    expect(await can(banned, Abilities.discussionCreate, { type: "board", id: 1, visibility: "public", postingPolicy: "everyone" }, ctx())).toBe(false);
    expect(await can(banned, Abilities.reportCreate, null, ctx())).toBe(false);
  });

  it("guest 不可发帖", async () => {
    expect(await can(null, Abilities.discussionCreate, { type: "board", id: 1, visibility: "public", postingPolicy: "everyone" }, ctx())).toBe(false);
  });
});

describe("followed feed 空关注返回空", () => {
  it("未关注任何人时 followed feed 为空而非全量", async () => {
    const lonely = await registerUser("lonely");
    const svc = createDiscussionService(container.db, container.boardService, { db: container.db });
    const res = await svc.listDiscussions(
      { id: 9999, username: "lonely", displayName: "Lonely", email: "lonely@example.edu.cn", role: "student", status: "active" },
      { feed: "followed", limit: 10 },
    );
    expect(res.items.length).toBe(0);
    void lonely;
  });
});

describe("用户主页三 feed 端点", () => {
  it("posts/replies/saved 返回真实数据，saved 仅本人可见", async () => {
    const u1 = await registerUser("userone");
    const u2 = await registerUser("usertwo");
    const admin = await registerUser("admin3");
    await container.db.db.update(users).set({ role: "admin" }).where(eq(users.username, "admin3"));

    await app.inject({
      method: "POST",
      url: "/api/boards",
      headers: { cookie: admin },
      payload: { slug: "feed-board", name: "Feed Board", description: "b", visibility: "public", postingPolicy: "everyone" },
    });

    // u1 发帖
    const post = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie: u1 },
      payload: { boardSlug: "feed-board", title: "My feed thread", bodyMarkdown: "post body" },
    });
    expect(post.statusCode).toBe(201);
    const discussionId = JSON.parse(post.body).id;

    // u2 回复（replies feed 应出现在 u2 名下）
    const reply = await app.inject({
      method: "POST",
      url: `/api/discussions/${discussionId}/replies`,
      headers: { cookie: u2 },
      payload: { bodyMarkdown: "a reply by u2" },
    });
    expect(reply.statusCode).toBe(201);

    // u1 收藏自己的帖
    const save = await app.inject({
      method: "POST",
      url: `/api/discussions/${discussionId}/save`,
      headers: { cookie: u1 },
    });
    expect(save.statusCode).toBe(200);

    // posts
    const posts = await app.inject({ method: "GET", url: "/api/users/userone/posts" });
    expect(posts.statusCode).toBe(200);
    const postsBody = JSON.parse(posts.body);
    expect(postsBody.items.some((t: { title: string }) => t.title === "My feed thread")).toBe(true);

    // replies（带 discussionTitle）
    const repliesRes = await app.inject({ method: "GET", url: "/api/users/usertwo/replies" });
    expect(repliesRes.statusCode).toBe(200);
    const rBody = JSON.parse(repliesRes.body);
    expect(rBody.items[0].discussionTitle).toBe("My feed thread");
    expect(rBody.items[0].bodyMarkdown).toBe("a reply by u2");

    // saved：本人可看，他人 403
    const saved = await app.inject({ method: "GET", url: "/api/users/userone/saved", headers: { cookie: u1 } });
    expect(saved.statusCode).toBe(200);
    const savedBody = JSON.parse(saved.body);
    expect(savedBody.items.some((t: { id: number }) => t.id === discussionId)).toBe(true);

    const savedOther = await app.inject({ method: "GET", url: "/api/users/userone/saved", headers: { cookie: u2 } });
    expect(savedOther.statusCode).toBe(403);
    const guest = await app.inject({ method: "GET", url: "/api/users/userone/saved" });
    expect(guest.statusCode).toBe(403);

    // 不存在用户 → 404
    const missing = await app.inject({ method: "GET", url: "/api/users/nobody/posts" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("M7 管理后台", () => {
  async function adminCookie(username: string): Promise<string> {
    const cookie = await registerUser(username);
    await container.db.db.update(users).set({ role: "admin" }).where(eq(users.username, username));
    return cookie;
  }

  it("can() 新 admin Ability：仅 admin 为 true", async () => {
    const ctx = (): AuthzCtx => ({ db: container.db });
    for (const ability of [Abilities.adminView, Abilities.adminUserRoleUpdate, Abilities.adminUserStatusUpdate]) {
      expect(await can(actor("admin"), ability, null, ctx())).toBe(true);
      expect(await can(actor("moderator"), ability, null, ctx())).toBe(false);
      expect(await can(actor("student"), ability, null, ctx())).toBe(false);
      expect(await can(actor("student", "banned"), ability, null, ctx())).toBe(false);
      expect(await can(null, ability, null, ctx())).toBe(false);
    }
  });

  it("权限矩阵：stats/users 仅 admin；student/mod 403", async () => {
    const admin = await adminCookie("adminm7");
    const mod = await registerUser("modm7");
    await container.db.db.update(users).set({ role: "moderator" }).where(eq(users.username, "modm7"));
    const student = await registerUser("studm7");

    const statsStudent = await app.inject({ method: "GET", url: "/api/admin/stats", headers: { cookie: student } });
    expect(statsStudent.statusCode).toBe(403);
    const statsMod = await app.inject({ method: "GET", url: "/api/admin/stats", headers: { cookie: mod } });
    expect(statsMod.statusCode).toBe(403);

    const statsAdmin = await app.inject({ method: "GET", url: "/api/admin/stats", headers: { cookie: admin } });
    expect(statsAdmin.statusCode).toBe(200);
    const stats = JSON.parse(statsAdmin.body);
    expect(stats.users.total).toBeGreaterThan(0);
    expect(stats.content.boards).toBeGreaterThan(0);
    expect(typeof stats.activity.activeToday).toBe("number");

    const usersStudent = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: student } });
    expect(usersStudent.statusCode).toBe(403);
    const usersAdmin = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: admin } });
    expect(usersAdmin.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(usersAdmin.body).items)).toBe(true);
  });

  it("改角色：成功/自改 409/降级后失去 admin", async () => {
    const admin = await adminCookie("adminm7b");
    const target = await registerUser("rolm7");
    const targetRow = await container.db.db.select().from(users).where(eq(users.username, "rolm7")).get();
    const targetId = targetRow!.id;

    const up = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${targetId}/role`,
      headers: { cookie: admin },
      payload: { role: "moderator" },
    });
    expect(up.statusCode).toBe(200);
    expect(JSON.parse(up.body).role).toBe("moderator");

    // 审计留痕
    const action = await container.db.db
      .select()
      .from(moderationActions)
      .where(and(eq(moderationActions.action, "user.role.change"), eq(moderationActions.target_id, targetId)))
      .get();
    expect(action).toBeDefined();

    // 自改 409
    const selfRow = await container.db.db.select().from(users).where(eq(users.username, "adminm7b")).get();
    const self = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${selfRow!.id}/role`,
      headers: { cookie: admin },
      payload: { role: "student" },
    });
    expect(self.statusCode).toBe(409);

    // 降级 target 回 student，其 cookie 再访问 admin 端点 → 403
    await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${targetId}/role`,
      headers: { cookie: admin },
      payload: { role: "student" },
    });
    const after = await app.inject({ method: "GET", url: "/api/admin/stats", headers: { cookie: target } });
    expect(after.statusCode).toBe(403);
  });

  it("状态管理：deactivate 踢 session → 登录被拒；reactivate 恢复", async () => {
    const admin = await adminCookie("adminm7c");
    const target = await registerUser("statm7");
    const targetRow = await container.db.db.select().from(users).where(eq(users.username, "statm7")).get();
    const targetId = targetRow!.id;

    const deact = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${targetId}/status`,
      headers: { cookie: admin },
      payload: { status: "deactivated" },
    });
    expect(deact.statusCode).toBe(200);
    expect(JSON.parse(deact.body).status).toBe("deactivated");

    // 原 cookie 被踢（session 删除 → authRequired 401）
    const kicked = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: target } });
    expect(kicked.statusCode).toBe(401);

    // 重新登录被拒（login 对非 active 抛 403）
    const relogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "statm7", password: PASSWORD },
    });
    expect(relogin.statusCode).toBe(403);

    const react = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${targetId}/status`,
      headers: { cookie: admin },
      payload: { status: "active" },
    });
    expect(react.statusCode).toBe(200);
    expect(JSON.parse(react.body).status).toBe("active");
  });

  it("自 deactivate 409；banned 用户不可 changeStatus", async () => {
    const admin = await adminCookie("adminm7d");
    const adminRow = await container.db.db.select().from(users).where(eq(users.username, "adminm7d")).get();

    const self = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminRow!.id}/status`,
      headers: { cookie: admin },
      payload: { status: "deactivated" },
    });
    expect(self.statusCode).toBe(409);

    // 造一个被 ban 用户，对其 changeStatus → 409（封禁走 moderation 单一入口）
    const victim = await registerUser("bannedm7");
    const ban = await app.inject({
      method: "POST",
      url: "/api/moderation/bans",
      headers: { cookie: admin },
      payload: { username: "bannedm7", reason: "spam" },
    });
    expect(ban.statusCode).toBe(200);
    const victimRow = await container.db.db.select().from(users).where(eq(users.username, "bannedm7")).get();
    const onBanned = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${victimRow!.id}/status`,
      headers: { cookie: admin },
      payload: { status: "deactivated" },
    });
    expect(onBanned.statusCode).toBe(409);
  });

  it("verify：pending 用户手动验证；重复验证 409", async () => {
    const admin = await adminCookie("adminm7e");
    // 注册 → pending
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "pendm7", password: PASSWORD },
    });
    expect(reg.statusCode).toBe(201);
    const pendRow = await container.db.db.select().from(users).where(eq(users.username, "pendm7")).get();
    expect(pendRow!.status).toBe("pending");

    const verify = await app.inject({ method: "POST", url: `/api/admin/users/${pendRow!.id}/verify`, headers: { cookie: admin } });
    expect(verify.statusCode).toBe(200);
    const body = JSON.parse(verify.body);
    expect(body.status).toBe("active");
    expect(body.emailVerified).toBe(true);

    const again = await app.inject({ method: "POST", url: `/api/admin/users/${pendRow!.id}/verify`, headers: { cookie: admin } });
    expect(again.statusCode).toBe(409);
  });

  it("删除内容清单 + restore 链路", async () => {
    const admin = await adminCookie("adminm7f");
    await app.inject({
      method: "POST",
      url: "/api/boards",
      headers: { cookie: admin },
      payload: { slug: "del-board", name: "Del Board", description: "b", visibility: "public", postingPolicy: "everyone" },
    });
    const post = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie: admin },
      payload: { boardSlug: "del-board", title: "Doomed thread", bodyMarkdown: "to be deleted" },
    });
    const discussionId = JSON.parse(post.body).id;

    const del = await app.inject({ method: "DELETE", url: `/api/discussions/${discussionId}`, headers: { cookie: admin }, payload: {} });
    expect(del.statusCode).toBe(200);

    const deleted = await app.inject({ method: "GET", url: "/api/admin/moderation/deleted", headers: { cookie: admin } });
    expect(deleted.statusCode).toBe(200);
    const body = JSON.parse(deleted.body);
    expect(body.discussions.some((d: { id: number }) => d.id === discussionId)).toBe(true);
    expect(body.discussions[0].boardSlug).toBe("del-board");

    const restore = await app.inject({
      method: "POST",
      url: "/api/moderation/restore",
      headers: { cookie: admin },
      payload: { targetType: "discussion", targetId: discussionId },
    });
    expect(restore.statusCode).toBe(200);

    const deletedAfter = await app.inject({ method: "GET", url: "/api/admin/moderation/deleted", headers: { cookie: admin } });
    expect(JSON.parse(deletedAfter.body).discussions.some((d: { id: number }) => d.id === discussionId)).toBe(false);
    const getBack = await app.inject({ method: "GET", url: `/api/discussions/${discussionId}` });
    expect(getBack.statusCode).toBe(200);
  });

  it("用户列表分页/筛选/enrich", async () => {
    const admin = await adminCookie("adminm7g");
    for (let i = 0; i < 25; i++) {
      await container.db.db.insert(users).values({
        username: `pageuser${i}`,
        email: `pageuser${i}@example.edu.cn`,
        display_name: `Page User ${i}`,
        password_hash: "unused",
        role: "student",
        status: "active",
      });
    }
    // pageuser3：直写一条 active ban 行 + status=banned，验证 banActive enrich
    const target = await container.db.db.select().from(users).where(eq(users.username, "pageuser3")).get();
    await container.db.db.insert(bans).values({
      user_id: target!.id,
      banned_by_user_id: target!.id,
      reason: "test",
      is_active: 1,
    });
    await container.db.db.update(users).set({ status: "banned" }).where(eq(users.id, target!.id));

    // 分页 limit=2
    const page1 = await app.inject({ method: "GET", url: "/api/admin/users?limit=2", headers: { cookie: admin } });
    const p1 = JSON.parse(page1.body);
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeTruthy();
    const page2 = await app.inject({ method: "GET", url: `/api/admin/users?limit=2&cursor=${p1.nextCursor}`, headers: { cookie: admin } });
    const p2 = JSON.parse(page2.body);
    expect(p2.items.length).toBe(2);
    const ids1 = new Set(p1.items.map((u: { id: number }) => u.id));
    expect(p2.items.some((u: { id: number }) => ids1.has(u.id))).toBe(false);

    // q 子串筛选 + banActive
    const q = await app.inject({ method: "GET", url: "/api/admin/users?q=pageuser3", headers: { cookie: admin } });
    const qb = JSON.parse(q.body);
    expect(qb.items.length).toBe(1);
    expect(qb.items[0].username).toBe("pageuser3");
    expect(qb.items[0].banActive).toBe(true);

    // status 筛选
    const statusRes = await app.inject({ method: "GET", url: "/api/admin/users?status=pending", headers: { cookie: admin } });
    expect(JSON.parse(statusRes.body).items.every((u: { status: string }) => u.status === "pending")).toBe(true);
  });

  it("报告列表带 target enrich", async () => {
    const admin = await adminCookie("adminm7h");
    const reporter = await registerUser("repm7");
    const disc = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie: admin },
      payload: { boardSlug: "del-board", title: "Report target thread", bodyMarkdown: "body" },
    });
    const discussionId = JSON.parse(disc.body).id;
    const report = await app.inject({
      method: "POST",
      url: "/api/moderation/reports",
      headers: { cookie: reporter },
      payload: { reportableType: "discussion", reportableId: discussionId, reason: "spam" },
    });
    expect(report.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/moderation/reports?status=open", headers: { cookie: admin } });
    const items = JSON.parse(list.body).items;
    const found = items.find((r: { target?: { id: number } }) => r.target?.id === discussionId);
    expect(found).toBeTruthy();
    expect(found.target.title).toBe("Report target thread");
  });
});

describe("M8 反馈模块", () => {
  async function adminCookie(): Promise<string> {
    const c = await registerUser("fadmin");
    await container.db.db.update(users).set({ role: "admin" }).where(eq(users.username, "fadmin"));
    return c;
  }

  async function userIdOf(username: string): Promise<number> {
    const row = await container.db.db.select().from(users).where(eq(users.username, username)).get();
    return row!.id;
  }

  it("管理员建项目+派成员→成员提交→程序员标完成→普通成员被拒→非成员不可见", async () => {
    const admin = await adminCookie();
    const member = await registerUser("fmember");
    const programmer = await registerUser("fprog");
    const outsider = await registerUser("foutsider");

    const proj = await app.inject({
      method: "POST",
      url: "/api/feedback/projects",
      headers: { cookie: admin },
      payload: { name: "Test Project", description: "desc" },
    });
    expect(proj.statusCode).toBe(201);
    const projectId = JSON.parse(proj.body).id as number;

    const membersRes = await app.inject({
      method: "PUT",
      url: `/api/feedback/projects/${projectId}/members`,
      headers: { cookie: admin },
      payload: {
        members: [
          { userId: await userIdOf("fmember"), isProgrammer: false },
          { userId: await userIdOf("fprog"), isProgrammer: true },
        ],
      },
    });
    expect(membersRes.statusCode).toBe(200);

    // 非成员看不到项目
    const outsView = await app.inject({ method: "GET", url: `/api/feedback?projectId=${projectId}`, headers: { cookie: outsider } });
    expect(outsView.statusCode).toBe(403);

    // 普通成员提交，seq 从 1 开始
    const create = await app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { cookie: member },
      payload: { projectId, title: "bug report", detail: "detail", type: "bug", urgency: "urgent" },
    });
    expect(create.statusCode).toBe(201);
    const item = JSON.parse(create.body);
    expect(item.seq).toBe(1);

    // 普通成员能看到 canManage=false
    const view = await app.inject({ method: "GET", url: `/api/feedback?projectId=${projectId}`, headers: { cookie: member } });
    expect(view.statusCode).toBe(200);
    expect(JSON.parse(view.body).canManage).toBe(false);

    // 程序员标完成 → closedAt 落时间
    const done = await app.inject({
      method: "POST",
      url: `/api/feedback/${item.id}/status`,
      headers: { cookie: programmer },
      payload: { status: "done" },
    });
    expect(done.statusCode).toBe(200);
    const doneBody = JSON.parse(done.body);
    expect(doneBody.status).toBe("done");
    expect(doneBody.closedAt).not.toBeNull();

    // 普通成员标完成被拒
    const denied = await app.inject({
      method: "POST",
      url: `/api/feedback/${item.id}/status`,
      headers: { cookie: member },
      payload: { status: "done" },
    });
    expect(denied.statusCode).toBe(403);

    // 作者本人可删除
    const del = await app.inject({ method: "DELETE", url: `/api/feedback/${item.id}`, headers: { cookie: member } });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/feedback?projectId=${projectId}`, headers: { cookie: member } });
    expect(JSON.parse(after.body).items).toHaveLength(0);
  });

  it("Agent 密钥读写权限与备份设置", async () => {
    const admin = await adminCookie();

    const keyRes = await app.inject({
      method: "POST",
      url: "/api/admin/feedback/keys",
      headers: { cookie: admin },
      payload: { name: "agent", role: "write", projectIds: [] },
    });
    expect(keyRes.statusCode).toBe(201);
    const key = JSON.parse(keyRes.body).key as string;
    expect(key.startsWith("fb_")).toBe(true);

    // 免 key 索引
    const index = await app.inject({ method: "GET", url: "/api/agent/v1" });
    expect(index.statusCode).toBe(200);
    expect(JSON.parse(index.body).name).toContain("Feedback");

    // 带 key 查任务
    const tasks = await app.inject({ method: "GET", url: "/api/agent/v1/tasks", headers: { "x-api-key": key } });
    expect(tasks.statusCode).toBe(200);

    // 错误 key 被拒
    const bad = await app.inject({ method: "GET", url: "/api/agent/v1/tasks", headers: { "x-api-key": "fb_wrong" } });
    expect(bad.statusCode).toBe(401);

    // 备份：内存库不可用，create 应优雅拒绝；list/settings 可用
    const backup = await app.inject({ method: "POST", url: "/api/admin/feedback/backups/create", headers: { cookie: admin } });
    expect(backup.statusCode).toBe(400);
    const backups = await app.inject({ method: "GET", url: "/api/admin/feedback/backups", headers: { cookie: admin } });
    expect(backups.statusCode).toBe(200);
    const settings = await app.inject({
      method: "PUT",
      url: "/api/admin/feedback/backups/settings",
      headers: { cookie: admin },
      payload: { backupCron: "", backupKeep: 5 },
    });
    expect(settings.statusCode).toBe(200);
  });
});
