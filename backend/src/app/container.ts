import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Env } from "../config/env.js";
import { createDbProvider, emitEvent, type DbProvider } from "../infrastructure/db/client.js";
import { MemoryCache, MemoryRateLimiter } from "../infrastructure/cache/memory.js";
import type { CacheProvider, RateLimiter } from "../infrastructure/cache/types.js";
import { MemoryPresenceStore } from "../infrastructure/presence/memory.js";
import type { PresenceStore } from "../infrastructure/presence/types.js";
import { MemoryEventBus } from "../infrastructure/events/memory.js";
import type { EventBus } from "../infrastructure/events/types.js";
import { LocalDiskStorage } from "../infrastructure/storage/local.js";
import type { StorageProvider } from "../infrastructure/storage/types.js";
import { ConsoleMailer } from "../infrastructure/email/console.js";
import type { Mailer } from "../infrastructure/email/types.js";
import { createOutboxWorker, OutboxDispatcherImpl } from "../infrastructure/queue/worker.js";
import type { OutboxDispatcher, OutboxEmitter, OutboxWorker } from "../infrastructure/queue/types.js";
import { createSchoolService, type SchoolService } from "../schools/service.js";
import { createUserService, type UserService } from "../users/service.js";
import { createAuthService, type AuthService } from "../auth/service.js";
import { createBoardService, type BoardService } from "../boards/service.js";
import { createDiscussionService, type DiscussionService } from "../discussions/service.js";
import { createAttachmentService, type AttachmentService } from "../attachments/service.js";
import { createFollowService, type FollowService } from "../follows/service.js";
import { createNotificationService, type NotificationService } from "../notifications/service.js";
import { createSearchService, type SearchService } from "../search/service.js";
import { createModerationService, type ModerationService } from "../moderation/service.js";
import { createAdminService, type AdminService } from "../admin/service.js";

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export function consoleLogger(): Logger {
  return {
    info: (obj, msg) => console.log(`[info] ${msg ?? ""}`, obj === undefined ? "" : obj),
    warn: (obj, msg) => console.warn(`[warn] ${msg ?? ""}`, obj === undefined ? "" : obj),
    error: (obj, msg) => console.error(`[error] ${msg ?? ""}`, obj === undefined ? "" : obj),
    debug: (obj, msg) => {
      if (process.env.NODE_ENV !== "production") console.debug(`[debug] ${msg ?? ""}`, obj ?? "");
    },
  };
}

/** 依赖注入容器：装配基础设施单例 + 各模块 service（模块在 buildContainer 后注册）。 */
export interface Container {
  env: Env;
  logger: Logger;
  db: DbProvider;
  cache: CacheProvider;
  rateLimiter: RateLimiter;
  presence: PresenceStore;
  events: EventBus;
  storage: StorageProvider;
  mailer: Mailer;
  /** 业务代码在 db.tx() 内调用，写入 outbox 事件。 */
  emitter: OutboxEmitter;
  dispatcher: OutboxDispatcher;
  outboxWorker: OutboxWorker;
  schoolService: SchoolService;
  userService: UserService;
  auth: AuthService;
  boardService: BoardService;
  discussionService: DiscussionService;
  attachments: AttachmentService;
  followService: FollowService;
  notificationService: NotificationService;
  searchService: SearchService;
  moderationService: ModerationService;
  adminService: AdminService;
  close(): Promise<void>;
}

export interface BuildContainerOptions {
  logger?: Logger;
  runMigrations?: boolean;
  migrationsFolder?: string;
}

export async function buildContainer(
  env: Env,
  options: BuildContainerOptions = {},
): Promise<Container> {
  const logger = options.logger ?? consoleLogger();

  // SQLite 文件库的父目录必须存在；:memory: 跳过
  if (env.DATABASE_URL !== ":memory:") {
    await mkdir(path.dirname(env.DATABASE_URL), { recursive: true });
  }

  const db = await createDbProvider(env.DATABASE_URL, {
    runMigrations: options.runMigrations,
    migrationsFolder: options.migrationsFolder ?? "./drizzle",
  });

  const cache = new MemoryCache();
  const rateLimiter = new MemoryRateLimiter(cache);
  const presence = new MemoryPresenceStore();
  const events = new MemoryEventBus();

  await mkdir(env.UPLOAD_DIR, { recursive: true });
  const storage = new LocalDiskStorage(env.UPLOAD_DIR, env.STORAGE_SECRET);

  const mailer = new ConsoleMailer((line) => logger.info({}, line));

  const dispatcher = new OutboxDispatcherImpl();
  const emitter: OutboxEmitter = { emit: emitEvent };
  const outboxWorker = createOutboxWorker(db, dispatcher);

  const schoolService = createSchoolService(db);
  const userService = createUserService(db);
  const auth = createAuthService(db, userService, env);
  const boardService = createBoardService(db);
  const discussionService = createDiscussionService(db, boardService, { db });
  const followService = createFollowService(db);
  const notificationService = createNotificationService(db);
  const searchService = createSearchService(db);
  const moderationService = createModerationService(db, { db });
  const adminService = createAdminService(db, { db }, { presence });

  const container: Container = {
    env,
    logger,
    db,
    cache,
    rateLimiter,
    presence,
    events,
    storage,
    mailer,
    emitter,
    dispatcher,
    outboxWorker,
    schoolService,
    userService,
    auth,
    boardService,
    discussionService,
    followService,
    notificationService,
    searchService,
    moderationService,
    adminService,
    attachments: undefined as never,
    async close() {
      await outboxWorker.stop();
      cache.close();
      db.close();
    },
  };
  container.attachments = createAttachmentService(container);
  return container;
}
