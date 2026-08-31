# Samryetha 后端架构

## 1. 概览

Samryetha 是学校内部论坛/社区产品的后端。采用 **modular monolith**（模块化单体）：一个进程、一个数据库，按领域模块清晰切分，模块间通过已声明的 service 接口调用，禁止跨模块直接 import 私有表。

技术栈（实际落地的版本见 `package.json`）：

| 层 | 选型 |
|----|------|
| 运行时 | Node.js 22（`node:sqlite` 内置驱动） |
| Web 框架 | Fastify 5 + `fastify-type-provider-zod`（Zod v4 编译校验/序列化） |
| 数据库 | SQLite（WAL 模式）+ Drizzle ORM（`drizzle-orm/sqlite-proxy` 适配 `node:sqlite`） |
| 密码 | Argon2id（`@node-rs/argon2` 预编译二进制） |
| 会话 | 服务端 session，DB 存 sha256 哈希 token，HttpOnly + SameSite=Lax cookie |
| 校验 | Zod v4（schema + 类型安全） |
| 任务 | transactional outbox + 进程内 worker（轮询 SQLite） |
| 实时 | 进程内 EventBus → SSE 通道（`@fastify/sse`） |
| 附件 | 本地磁盘 + HMAC 签名 URL（presigned-URL 语义） |
| 邮件 | Console 打日志（Mailer 接口预留 SMTP 实现） |
| 测试 | Vitest（`app.inject()` 集成测试 + 纯逻辑单测） |

> **环境适配**：目标蓝图是 PostgreSQL + Redis + BullMQ + S3 + SMTP。本机无 Docker/PG/Redis/S3/SMTP，所有基础设施都收敛为**接口 + 内存/本地实现**。换生产环境时只替换 `src/infrastructure/` 下的具体实现，业务模块零改动。

## 2. 模块划分

```
src/
  app/            # Fastify 装配、路由挂载、全局钩子、DI 容器、统一错误处理
  authz/          # can() 能力矩阵——全站授权唯一入口
  auth/           # 注册/验证/登录/会话/密码找回
  users/          # 个人资料、公开主页
  schools/        # 学校 + 邮箱域名 allowlist
  boards/         # 动态板块实体（visibility/postingPolicy/成员/软删）
  discussions/    # 帖子：列表/详情/发布/软删/回复/置顶/锁定/save/follow
  follows/        # 用户关注
  notifications/  # 通知：生成/列表/已读 + outbox 副作用
  search/         # 搜索（SQLite LIKE 子串回退）
  presence/       # 在线状态心跳
  realtime/       # SSE /api/events 通道
  attachments/    # presign→上传→绑定→下载
  moderation/     # 举报/封禁/审计/内容恢复
  feedback/       # 反馈：项目/成员(程序员)/条目 + Agent API + 备份恢复
  infrastructure/ # db / cache / presence / queue / storage / email / events
  config/         # 环境变量校验（Zod）
  scripts/        # seed 兜底脚本（确保内置账号；mock 已停用）
```

**依赖规则**：
- 模块通过 `container.ts` 注入的 service 接口互相调用。
- 业务模块不 import 其他模块的私有表；表只在 `infrastructure/db/schema.ts` 声明一次。
- **业务代码零 `user.role ===` 判断**，授权唯一入口 `can(user, ability, resource)`。
- **异步副作用绝不写在业务事务内**，一律经 outbox 事件。

## 3. 分层与数据流

```
HTTP 请求
  → Fastify 插件栈（CORS / cookie / rate-limit / swagger / CSRF Origin / request-id）
  → zod 校验（422）
  → preHandler 解析 session cookie → request.currentUser
  → 路由 handler → 模块 service
      → can() 授权（403）
      → 业务事务 db.tx()
          ├─ 业务行写入
          └─ outbox 行写入（同事务原子提交）
  → 响应序列化
```

**两条副作用通道**：

1. **outbox（持久、可靠）**——事务内写 `outbox_events` 行，worker 每 500ms 原子 claim，处理完成后写 `processed`。失败指数退避（上限 10 次转 `failed`）。用途：发验证码邮件、生成通知、重索引。
2. **进程内 EventBus（瞬时）**——outbox 处理完成后 `events.publish()`，SSE hub 订阅做实时推送。断线重连靠客户端重拉通知兜底。多实例时换成 Redis pub/sub，业务代码不变。

## 4. 核心横切关注点

- **request-id**：`genReqId` 生成 `req_<uuid>`，贯穿日志与错误响应。
- **日志**：pino，dev 用 `pino-pretty`。
- **限频**：`@fastify/rate-limit` 全局 300 req/min。
- **CSRF**：非安全方法若带 Origin 必须等于 `APP_ORIGIN`；cookie `SameSite=Lax` 兜底。
- **统一错误处理**：`AppError` / ZodError / Ajv 校验 / 429 全部归一为 `{ error: { code, message, requestId, details? } }`，见 `error-model.md`。

## 5. 目录结构与运行

```
backend/
  package.json  tsconfig.json  .env.example  drizzle.config.ts
  data/            # SQLite 文件（gitignore）
  uploads/         # 本地附件（gitignore）
  docs/            # 本目录 + openapi.json 归档
  tests/           # vitest
  src/
    app/           # server.ts / container.ts / error.ts / auth-hook.ts
    authz/  auth/  users/  schools/  boards/  discussions/  follows/
    notifications/  search/  presence/  realtime/  attachments/  moderation/
    infrastructure/
      db/          # schema.ts + client.ts（WAL pragma、tx 封装、node:sqlite adapter）
      cache/  presence/  queue/  storage/  email/  events/
```

**运行命令**：

```bash
pnpm install
pnpm db:migrate       # 建表
pnpm seed             # 确保内置 admin/dev 账号（启动时也会自动创建）
pnpm dev              # tsx watch，端口 3001，/docs 出 OpenAPI
pnpm test             # vitest（SQLite :memory:）
pnpm build            # tsc 编译到 dist/
```

端口用 **3001**（前端 Vite dev 占 3000）。

## 6. 部署与扩展方向

- 数据库换 PG：`infrastructure/db` 换 drizzle 的 pg 方言 + 迁移脚本；`node:sqlite` adapter 丢弃。
- 缓存/在线/限频：实现 `CacheProvider` / `PresenceStore` / `RateLimiter` 的 Redis 版。
- 实时：EventBus 换 Redis pub/sub。
- 附件：`StorageProvider` 实现 S3 版（presign 语义天然对齐）。
- 邮件：`Mailer` 实现 SMTP 版。
- 搜索：PG 用 `to_tsvector` + GIN；SQLite 用 FTS5 trigram（本机 `node:sqlite` 未编译 FTS5，回退 LIKE）。
