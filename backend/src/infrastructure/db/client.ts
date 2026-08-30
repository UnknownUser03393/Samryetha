import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { outboxEvents, DbSchema } from "./schema.js";
import type { OutboxEvent } from "../queue/types.js";
import { migrateDb } from "./migrate.js";

export type Db = SqliteRemoteDatabase<typeof DbSchema>;

/** drizzle proxy 事务回调的 tx 类型。 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface TxContext {
  tx: Tx;
}

/**
 * 记录当前事务作用域，让 emitEvent 能把 outbox 事件写进"正在进行的那个事务"，
 * 从而与业务行同事务原子提交。
 */
export const txContext = new AsyncLocalStorage<TxContext>();

const CONTROL_RE = /^\s*(begin|commit|rollback|savepoint|release)\b/i;

type Row = Record<string, unknown>;

function createAdapter(raw: DatabaseSync) {
  const stmtCache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  const getStmt = (sqlText: string) => {
    if (CONTROL_RE.test(sqlText)) return null;
    let stmt = stmtCache.get(sqlText);
    if (!stmt) {
      stmt = raw.prepare(sqlText);
      stmtCache.set(sqlText, stmt);
    }
    return stmt;
  };

  /**
   * drizzle sqlite-proxy 回调契约：mapResultRow 用数字索引取列，
   * 所以行必须按 SELECT 列序返回数组；get 返回单行列值数组。
   */
  return async (
    sqlText: string,
    params: unknown[],
    method: "run" | "all" | "values" | "get",
  ): Promise<{ rows: any[] }> => {
    const stmt = getStmt(sqlText);
    if (!stmt) {
      raw.exec(sqlText);
      return { rows: [] };
    }
    const bindParams = params as unknown as (string | number | bigint | null)[];
    switch (method) {
      case "run":
        stmt.run(...bindParams);
        return { rows: [] };
      case "get": {
        const row = stmt.get(...bindParams) as Row | undefined;
        // 无行时返回 falsy，让 drizzle mapGetResult 返回 undefined
        return { rows: row ? Object.values(row) : (undefined as unknown as any[]) };
      }
      case "values":
        return { rows: (stmt.all(...bindParams) as Row[]).map((r) => Object.values(r)) };
      case "all":
        return { rows: (stmt.all(...bindParams) as Row[]).map((r) => Object.values(r)) };
    }
  };
}

export interface DbProvider {
  db: Db;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** 构造 SQLite（node:sqlite）连接 + drizzle sqlite-proxy 实例。 */
export async function createDbProvider(
  databaseUrl: string,
  opts: { runMigrations?: boolean; migrationsFolder?: string } = {},
): Promise<DbProvider> {
  const raw = new DatabaseSync(databaseUrl);
  raw.exec("PRAGMA journal_mode=WAL;");
  raw.exec("PRAGMA foreign_keys=ON;");
  raw.exec("PRAGMA busy_timeout=5000;");
  raw.exec("PRAGMA synchronous=NORMAL;");

  const db = drizzle(createAdapter(raw), { schema: DbSchema });

  if (opts.runMigrations !== false) {
    await migrateDb(db, raw, opts.migrationsFolder ?? "./drizzle");
  }

  return {
    db,
    async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const context: TxContext = { tx: tx as Tx };
        return txContext.run(context, () => fn(tx as Tx));
      });
    },
    async close() {
      raw.close();
    },
  };
}

/**
 * 在当前事务内写入 outbox 事件。必须在 db.tx() 作用域内调用。
 */
export async function emitEvent(event: OutboxEvent): Promise<void> {
  const context = txContext.getStore();
  if (!context) {
    throw new Error("emitEvent() must be called inside db.tx()");
  }
  await context.tx.insert(outboxEvents).values({
    event_type: event.type,
    aggregate_type: event.aggregate?.type,
    aggregate_id: event.aggregate?.id,
    payload: JSON.stringify(event.payload ?? {}),
  });
}
