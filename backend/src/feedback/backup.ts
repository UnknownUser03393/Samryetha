import { mkdir, readdir, copyFile, rm, stat, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { schedule, validate as validateCron } from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { DbProvider } from "../infrastructure/db/client.js";
import { appSettings } from "../infrastructure/db/schema.js";
import type { Env } from "../config/env.js";
import { badRequest, notFound } from "../app/error.js";
import type { Logger } from "../app/container.js";

const BACKUP_RE = /^backup-\d{8}-\d{6}\.sqlite$/;

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: number;
}

export interface BackupSettings {
  backupCron: string;
  backupKeep: number;
}

const SETTINGS_KEY = "feedback.backup";
const PENDING_RESTORE_FILE = ".restore_pending";

const sqliteEscape = (p: string) => p.replace(/'/g, "''");

export interface BackupService {
  list(): Promise<BackupInfo[]>;
  create(): Promise<BackupInfo>;
  restore(name: string): Promise<void>;
  getSettings(): Promise<BackupSettings>;
  setSettings(settings: BackupSettings): Promise<void>;
  start(): void;
  stop(): void;
}

export function createBackupService(db: DbProvider, env: Env, logger: Logger): BackupService {
  const dataDir = env.DATABASE_URL === ":memory:" ? null : path.dirname(path.resolve(env.DATABASE_URL));
  const backupDir = dataDir ? path.join(dataDir, "backups") : null;
  let task: ScheduledTask | null = null;

  function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  async function getSettings(): Promise<BackupSettings> {
    const row = await db.db.select().from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).get();
    const value = (row?.value ?? {}) as Partial<BackupSettings>;
    return { backupCron: value.backupCron ?? "", backupKeep: value.backupKeep ?? 5 };
  }

  async function setSettings(settings: BackupSettings): Promise<void> {
    const clean = { backupCron: settings.backupCron.trim(), backupKeep: Math.max(1, Math.min(500, settings.backupKeep)) };
    if (clean.backupCron && !validateCron(clean.backupCron)) throw badRequest("Invalid cron expression");
    await db.db
      .insert(appSettings)
      .values({ key: SETTINGS_KEY, value: clean })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: clean } });
  }

  async function prune(keep: number): Promise<void> {
    if (!backupDir) return;
    const files = (await readdir(backupDir)).filter((f) => BACKUP_RE.test(f)).sort().reverse();
    for (const f of files.slice(keep)) {
      await rm(path.join(backupDir, f), { force: true });
    }
  }

  async function create(): Promise<BackupInfo> {
    if (!backupDir || dataDir === null) throw badRequest("Backup not available for in-memory database");
    await mkdir(backupDir, { recursive: true });
    const name = `backup-${stamp()}.sqlite`;
    const target = path.join(backupDir, name);
    // VACUUM INTO 生成一份自包含的完整库文件（WAL 安全）
    db.raw.exec(`VACUUM INTO '${sqliteEscape(target)}'`);
    const settings = await getSettings();
    await prune(settings.backupKeep);
    const info = await stat(target);
    return { name, size: info.size, createdAt: info.mtimeMs };
  }

  async function list(): Promise<BackupInfo[]> {
    if (!backupDir) return [];
    await mkdir(backupDir, { recursive: true });
    const files = (await readdir(backupDir)).filter((f) => BACKUP_RE.test(f));
    const infos: BackupInfo[] = [];
    for (const f of files) {
      const s = await stat(path.join(backupDir, f)).catch(() => null);
      if (!s) continue;
      infos.push({ name: f, size: s.size, createdAt: s.mtimeMs });
    }
    return infos.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function restore(name: string): Promise<void> {
    if (dataDir === null) throw badRequest("Backup not available for in-memory database");
    if (!BACKUP_RE.test(name)) throw badRequest("Invalid backup name");
    const source = path.join(backupDir!, name);
    await stat(source).catch(() => {
      throw notFound("Backup not found");
    });
    // 写入待恢复标记，下次启动时在打开 db 前换文件（运行中无法替换 node:sqlite 连接）
    await writeFile(path.join(dataDir, PENDING_RESTORE_FILE), name, "utf8");
  }

  function scheduleFrom(cronExpr: string): void {
    if (task) {
      task.stop();
      task = null;
    }
    if (!cronExpr || !validateCron(cronExpr)) return;
    task = schedule(
      cronExpr,
      () => {
        create().then(
          (info) => logger.info({ name: info.name }, "auto backup created"),
          (err) => logger.error({ err }, "auto backup failed"),
        );
      },
      { noOverlap: true, unref: true },
    );
    task.start();
  }

  async function applySettingsAndSchedule(): Promise<void> {
    const settings = await getSettings();
    scheduleFrom(settings.backupCron);
  }

  return {
    list,
    create,
    restore,
    getSettings,
    setSettings,
    async start() {
      await applySettingsAndSchedule();
    },
    stop() {
      if (task) {
        task.stop();
        task = null;
      }
    },
  };
}

/** 启动前恢复：buildContainer 打开 db 之前调用。 */
export async function applyPendingRestore(env: Env, logger: Logger): Promise<void> {
  if (env.DATABASE_URL === ":memory:") return;
  const dataDir = path.dirname(path.resolve(env.DATABASE_URL));
  const marker = path.join(dataDir, PENDING_RESTORE_FILE);
  let pending: string;
  try {
    pending = (await readFile(marker, "utf8")).trim();
  } catch {
    return; // 无待恢复标记
  }
  if (!BACKUP_RE.test(pending)) {
    await unlink(marker).catch(() => undefined);
    return;
  }
  const source = path.join(dataDir, "backups", pending);
  const dbPath = path.resolve(env.DATABASE_URL);
  try {
    await copyFile(source, dbPath);
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await unlink(marker).catch(() => undefined);
    logger.info({ backup: pending }, "restored database from backup on startup");
  } catch (err) {
    logger.error({ err, backup: pending }, "failed to restore database from backup");
  }
}
