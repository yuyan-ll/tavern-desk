// node:sqlite 上的 D1 形状壳。
//
// 上游 12 个文件 + examples/cloudflare/adapters/ 六个适配器直接拿 env.OC_DB 当 D1 用,
// 这里不重写适配器,而是让 node:sqlite 长得像 D1,上游一个字不动。
//
// 上游用到的 D1 面(数过):
//   prepare(sql) / .bind(...values)(返回新语句,原语句不变)
//   .all()   → { results, success: true, meta }
//   .first() → 行或 null;带列名参数时返回那一列的值
//   .run()   → { success: true, meta, results: [] }
//   db.batch([...]) → 结果数组,整批一个事务,任一失败整批回滚并抛错
//   db.exec(sql)    → 多条语句,返回 { count, duration }
// 上游只读 meta.changes 和一处 success。
//
// node:sqlite 是同步的,一条语句/一整批在一个事件循环片里跑完,不会和别的请求交错,
// 所以 batch 用 BEGIN/COMMIT 包起来就是真原子。

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;
type BindValue = null | number | bigint | string | Uint8Array;

export interface D1Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  rows_read: number;
  rows_written: number;
}

export interface D1Result<T = Row> {
  success: true;
  results: T[];
  meta: D1Meta;
}

// 绑定值归一:undefined → null,布尔 → 0/1,整数按 INTEGER 绑(node:sqlite 默认把 number 当 REAL,
// 存进 TEXT 列会变成 "3.0"),ArrayBuffer → Uint8Array。其余类型 D1 本来也不收,照样抛错。
function normalizeBind(value: unknown, index: number): BindValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`D1_TYPE_ERROR: 第 ${index + 1} 个绑定值的类型 ${typeof value} 不支持`);
}

// node:sqlite 返回的行是 null 原型对象;转成普通对象,跟 D1 的 JSON 行一致(deepEqual、展开都正常)。
function plainRow(row: unknown): Row {
  return row && typeof row === 'object' ? { ...(row as Row) } : {};
}

export class D1PreparedStatementShim {
  readonly #db: D1DatabaseShim;
  readonly sql: string;
  readonly params: readonly BindValue[];

  constructor(db: D1DatabaseShim, sql: string, params: readonly BindValue[] = []) {
    this.#db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this.#db, this.sql, values.map(normalizeBind));
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.#db._execute(this) as D1Result<T>;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    const r = this.#db._execute(this);
    return { success: true, meta: r.meta, results: [] as T[] };
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.#db._first(this);
    if (row === null) return null;
    if (column === undefined) return row as T;
    if (!Object.prototype.hasOwnProperty.call(row, column)) {
      throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    }
    return row[column] as T;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const r = this.#db._execute(this);
    const rows = r.results.map((row) => Object.values(row));
    if (options?.columnNames) {
      const names = this.#db._statement(this.sql).columns().map((c) => c.name);
      return [names, ...rows] as T[];
    }
    return rows as T[];
  }
}

export class D1DatabaseShim {
  readonly sqlite: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();
  #counters: StatementSync | null = null;

  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
  }

  prepare(sql: string): D1PreparedStatementShim {
    return new D1PreparedStatementShim(this, sql);
  }

  // 整批一个事务:任一条抛错就整批回滚,错误原样上抛(上游按错误文本认 UNIQUE、comment_rate_limited)。
  async batch<T = Row>(statements: D1PreparedStatementShim[]): Promise<D1Result<T>[]> {
    if (!Array.isArray(statements)) throw new TypeError('batch 需要语句数组');
    const db = this.sqlite;
    db.exec('BEGIN');
    try {
      const results = statements.map((s) => this._execute(s) as D1Result<T>);
      db.exec('COMMIT');
      return results;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  // 多条语句原样执行;count 是语句条数(按分号切,认得引号、注释和触发器的 BEGIN…END)。
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.sqlite.exec(sql);
    return { count: countStatements(sql), duration: performance.now() - started };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('D1_DUMP_UNSUPPORTED: 本机 SQLite 请直接备份数据库文件');
  }

  close(): void {
    this.#cache.clear();
    this.#counters = null;
    if (this.sqlite.isOpen) this.sqlite.close();
  }

  // ===== 以下给语句对象用,不是 D1 面 =====

  _statement(sql: string): StatementSync {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = this.sqlite.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  #readCounters(): { total: number; changes: number; lastRowId: number } {
    this.#counters ??= this.sqlite.prepare('SELECT total_changes() AS t, changes() AS c, last_insert_rowid() AS r');
    const row = this.#counters.get() as { t: number; c: number; r: number };
    return { total: Number(row.t), changes: Number(row.c), lastRowId: Number(row.r) };
  }

  // 有结果列的语句(SELECT、带 RETURNING 的写)取行;其余 run。
  // changes 用 total_changes() 前后差判断"这一条到底写没写",写了才取 changes()——
  // 否则 SELECT 会把上一条写语句的 changes 冒领过来。
  _execute(s: D1PreparedStatementShim): D1Result {
    const started = performance.now();
    const stmt = this._statement(s.sql);
    const before = this.#readCounters().total;
    let results: Row[] = [];
    if (stmt.columns().length > 0) results = stmt.all(...s.params).map(plainRow);
    else stmt.run(...s.params);
    const after = this.#readCounters();
    const changes = after.total !== before ? after.changes : 0;
    return {
      success: true,
      results,
      meta: {
        duration: performance.now() - started,
        changes,
        last_row_id: after.lastRowId,
        changed_db: changes > 0,
        rows_read: results.length,
        rows_written: changes,
      },
    };
  }

  _first(s: D1PreparedStatementShim): Row | null {
    const stmt = this._statement(s.sql);
    if (stmt.columns().length === 0) {
      stmt.run(...s.params);
      return null;
    }
    const row = stmt.get(...s.params);
    return row === undefined ? null : plainRow(row);
  }
}

// 粗切语句条数,只为 exec 的 count。认单/双引号、反引号、方括号、-- 与 /* */ 注释,
// 以及 CREATE TRIGGER … BEGIN … END; 体内的分号。
export function countStatements(sql: string): number {
  let count = 0;
  let pending = false;
  let depth = 0;
  let word = '';
  let prevWords: string[] = [];
  const flushWord = () => {
    if (!word) return;
    const w = word.toUpperCase();
    if (w === 'BEGIN' && prevWords.includes('TRIGGER')) depth++;
    else if (w === 'CASE' && depth > 0) depth++;
    else if (w === 'END' && depth > 0) depth--;
    prevWords.push(w);
    word = '';
  };
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') { flushWord(); const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl; continue; }
    if (ch === '/' && next === '*') { flushWord(); const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      flushWord();
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) { if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      i = j; pending = true; continue;
    }
    if (ch === ';') {
      flushWord();
      if (depth === 0) { if (pending) count++; pending = false; prevWords = []; }
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) { word += ch; pending = true; continue; }
    flushWord();
    if (!/\s/.test(ch)) pending = true;
  }
  flushWord();
  if (pending) count++;
  return count;
}

export interface OpenD1Options {
  // 上游 examples/cloudflare/schema 目录;给了就建库 + 跑迁移。
  schemaDir?: string;
}

// 打开(或新建)一个 SQLite 文件并套上 D1 壳。':memory:' 给测试用。
export function openD1(path: string, options: OpenD1Options = {}): D1DatabaseShim {
  const sqlite = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  if (path !== ':memory:') {
    // 本机单进程独占:WAL 让读不挡写,busy_timeout 兜住外部备份脚本短暂加锁。
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA busy_timeout = 5000');
  }
  const db = new D1DatabaseShim(sqlite);
  if (options.schemaDir) migrate(db, options.schemaDir);
  return db;
}

// 建库与迁移:
//   · 新库(没有 schema_versions 表)→ init.sql 原样 exec(它自己记下快照对应的版本号)。
//   · 再按 migrations/ 文件名顺序跑 schema_versions 里没记的;跑完补记一行(迁移文件自己也会记,重复无害)。
// 老库不重跑 init.sql:它会 INSERT OR IGNORE 最新版本号,等于把没跑的迁移误记成已跑。
export function migrate(db: D1DatabaseShim, schemaDir: string): { initialized: boolean; applied: number[] } {
  const sqlite = db.sqlite;
  const hasVersions = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_versions'`).get() !== undefined;
  let initialized = false;
  if (!hasVersions) {
    sqlite.exec(readFileSync(join(schemaDir, 'init.sql'), 'utf8'));
    initialized = true;
  }
  const done = new Set(
    (sqlite.prepare('SELECT version FROM schema_versions').all() as Array<{ version: number }>).map((r) => Number(r.version)),
  );
  const migrationsDir = join(schemaDir, 'migrations');
  const applied: number[] = [];
  if (existsSync(migrationsDir)) {
    const files = readdirSync(migrationsDir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      if (done.has(version)) continue;
      // 迁移文件可能自带 BEGIN/COMMIT(0002 就是),这里不再套事务。
      sqlite.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      sqlite.prepare('INSERT OR IGNORE INTO schema_versions(version) VALUES (?)').run(BigInt(version));
      applied.push(version);
    }
  }
  return { initialized, applied };
}
