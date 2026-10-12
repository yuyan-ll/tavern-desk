import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openD1, migrate, countStatements, D1DatabaseShim } from '../d1shim.ts';

const SCHEMA_DIR = resolve(import.meta.dirname, '../../upstream/examples/cloudflare/schema');

test('壳:bind 返回新语句,原语句不变;all/first/run 的形状对齐 D1', async () => {
  const db = openD1(':memory:');
  try {
    await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, note TEXT)`);
    const base = db.prepare(`INSERT INTO t (name, flag, note) VALUES (?, ?, ?)`);
    const bound = base.bind('a', true, undefined);
    assert.notEqual(base, bound);
    assert.deepEqual(base.params, []);
    const run = await bound.run();
    assert.equal(run.success, true);
    assert.equal(run.meta.changes, 1);
    assert.equal(run.meta.last_row_id, 1);
    await base.bind('b', false, 'x').run();

    const all = await db.prepare(`SELECT id, name, flag, note FROM t ORDER BY id`).all();
    assert.equal(all.success, true);
    assert.deepEqual(all.results, [
      { id: 1, name: 'a', flag: 1, note: null },
      { id: 2, name: 'b', flag: 0, note: 'x' },
    ]);
    assert.equal(all.meta.changes, 0); // SELECT 不冒领上一条写的 changes
    assert.equal(Object.getPrototypeOf(all.results[0]), Object.prototype);

    assert.deepEqual(await db.prepare(`SELECT name FROM t WHERE id = ?`).bind(2).first(), { name: 'b' });
    assert.equal(await db.prepare(`SELECT name FROM t WHERE id = ?`).bind(2).first('name'), 'b');
    assert.equal(await db.prepare(`SELECT name FROM t WHERE id = ?`).bind(99).first(), null);
    assert.equal(await db.prepare(`SELECT name FROM t WHERE id = ?`).bind(99).first('name'), null);
    await assert.rejects(db.prepare(`SELECT name FROM t WHERE id = 1`).first('nope'), /D1_COLUMN_NOTFOUND/);

    // ?1 ?2 带号占位符原样透传
    assert.equal(await db.prepare(`SELECT ?2 || ?1 AS s`).bind('x', 'y').first('s'), 'yx');
    // 整数按 INTEGER 绑,存进 TEXT 列不会变成 "3.0";小数仍是 REAL
    await db.prepare(`UPDATE t SET note = ? WHERE id = 1`).bind(3).run();
    assert.equal(await db.prepare(`SELECT note FROM t WHERE id = 1`).first('note'), '3');
    assert.equal(await db.prepare(`SELECT typeof(?) AS ty`).bind(1.5).first('ty'), 'real');

    // UPDATE … RETURNING 走 first() 也算真写
    const returned = await db.prepare(`UPDATE t SET name = ? WHERE id = 2 RETURNING *`).bind('B').first<any>();
    assert.equal(returned.name, 'B');
    assert.equal(await db.prepare(`SELECT name FROM t WHERE id = 2`).first('name'), 'B');

    const upd = await db.prepare(`UPDATE t SET name = 'z' WHERE id = 99`).run();
    assert.equal(upd.meta.changes, 0);

    await assert.rejects(async () => db.prepare('SELECT ?').bind({}).run(), /D1_TYPE_ERROR/);
  } finally { db.close(); }
});

test('壳:batch 整批一个事务,任一失败整批回滚并抛错', async () => {
  const db = openD1(':memory:');
  try {
    await db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER)`);
    const ins = db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`);
    const ok = await db.batch([ins.bind('a', 1), ins.bind('b', 2), db.prepare(`SELECT count(*) AS n FROM t`)]);
    assert.equal(ok.length, 3);
    assert.equal(ok[0].meta.changes, 1);
    assert.deepEqual(ok[2].results, [{ n: 2 }]);

    await assert.rejects(db.batch([ins.bind('c', 3), ins.bind('a', 9)]), /UNIQUE/);
    assert.deepEqual((await db.prepare(`SELECT id FROM t ORDER BY id`).all()).results, [{ id: 'a' }, { id: 'b' }]);
    assert.equal(db.sqlite.isTransaction, false);

    // 0 行命中不算错,不回滚别的语句(跟 D1 一致)
    const mixed = await db.batch([db.prepare(`UPDATE t SET v = 5 WHERE id = 'nope'`), db.prepare(`UPDATE t SET v = 7 WHERE id = 'a'`)]);
    assert.deepEqual(mixed.map((r) => r.meta.changes), [0, 1]);

    // 同连接顺序执行:(SELECT changes()) 看得见紧邻上一条
    const chained = await db.batch([
      db.prepare(`UPDATE t SET v = 8 WHERE id = 'nope'`),
      db.prepare(`UPDATE t SET v = 9 WHERE id = 'b' AND (SELECT changes()) = 1`),
    ]);
    assert.deepEqual(chained.map((r) => r.meta.changes), [0, 0]);
  } finally { db.close(); }
});

test('壳:exec 多条语句返回条数,触发器体内的分号不算', async () => {
  assert.equal(countStatements(`CREATE TABLE a(x); CREATE TABLE b(y);`), 2);
  assert.equal(countStatements(`INSERT INTO a VALUES (';'); -- 注释;\n/* 块;注释 */ SELECT 1`), 2);
  assert.equal(countStatements(`CREATE TRIGGER g BEFORE INSERT ON a BEGIN SELECT CASE WHEN 1 THEN RAISE(ABORT, 'x;') END; SELECT 2; END; SELECT 3;`), 2);
  const db = openD1(':memory:');
  try {
    const r = await db.exec(`CREATE TABLE a(x); INSERT INTO a VALUES (1); INSERT INTO a VALUES (2);`);
    assert.equal(r.count, 3);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM a').first('n'), 2);
  } finally { db.close(); }
});

test('建库:新库原样跑 init.sql;重开不重跑;老库(版本1)补跑 0002 迁移', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-shim-'));
  try {
    const path = join(dir, 'desk.sqlite');
    const first = openD1(path);
    const r1 = migrate(first, SCHEMA_DIR);
    assert.equal(r1.initialized, true);
    assert.deepEqual(r1.applied, []); // init.sql 已记 1、2
    const versions = (await first.prepare('SELECT version FROM schema_versions ORDER BY version').all()).results.map((r: any) => r.version);
    assert.deepEqual(versions, [1, 2]);
    assert.equal(await first.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='desk_windows'`).first('name'), 'desk_windows');
    first.close();

    const again = openD1(path, { schemaDir: SCHEMA_DIR });
    assert.equal(await again.prepare('SELECT count(*) AS n FROM schema_versions').first('n'), 2);
    again.close();

    // 老库:只跑过 0001(版本1),note_depth 还是老默认值;开库应补跑 0002 并记版本2
    const oldPath = join(dir, 'old.sqlite');
    const raw = new DatabaseSync(oldPath);
    raw.exec(readFileSync(join(SCHEMA_DIR, 'migrations/0001_initial.sql'), 'utf8'));
    raw.exec(`INSERT INTO desk_windows (id, project, recipe_id, note_depth, created_at) VALUES ('w', 'P', 'r', 4, 't0')`);
    raw.close();
    const old = new D1DatabaseShim(new DatabaseSync(oldPath));
    const r2 = migrate(old, SCHEMA_DIR);
    assert.equal(r2.initialized, false);
    assert.deepEqual(r2.applied, [2]);
    assert.equal(await old.prepare(`SELECT note_depth FROM desk_windows WHERE id = 'w'`).first('note_depth'), 1);
    assert.deepEqual(migrate(old, SCHEMA_DIR).applied, []);
    old.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
