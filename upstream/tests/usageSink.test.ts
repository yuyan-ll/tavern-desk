import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1UsageSink } from '../src/storage/usageSink.ts';

// Minimal fake D1 covering only the single INSERT statement makeD1UsageSink issues.
function fakeDb() {
  const rows: any[] = [];
  return {
    rows,
    prepare(sql: string) {
      const stmt = {
        args: [] as any[],
        bind(...args: any[]) { stmt.args = args; return stmt; },
        async run() {
          if (!sql.includes('INSERT INTO usage_log')) throw new Error(`unexpected sql: ${sql}`);
          const [id, channel, model, input, output, cacheRead, cacheWrite, status] = stmt.args;
          rows.push({ id, channel, model, input, output, cacheRead, cacheWrite, status });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

test('logUsage records a real row for the desk-board-auto channel', async () => {
  // Regression guard: desk-board-auto (the state-board auto-refresh channel) must be in the
  // CHANNELS whitelist, otherwise logUsage silently returns before the INSERT and the auto-refresh
  // spend is never recorded — no error, just a quietly vanished usage row.
  const db = fakeDb();
  const sink = makeD1UsageSink({ OC_DB: db as any });
  await sink.logUsage('desk-board-auto', 'claude-sonnet-4-5', { input: 10, output: 20, cache_read: 1, cache_write: 2 }, 'ok');
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].channel, 'desk-board-auto');
  assert.equal(db.rows[0].model, 'claude-sonnet-4-5');
  assert.equal(db.rows[0].input, 10);
  assert.equal(db.rows[0].output, 20);
  assert.equal(db.rows[0].status, 'ok');
});

test('logUsage silently drops a channel that is not on the whitelist (no throw, no insert)', async () => {
  const db = fakeDb();
  const sink = makeD1UsageSink({ OC_DB: db as any });
  await sink.logUsage('not-a-real-channel', 'model', { input: 1, output: 1, cache_read: 0, cache_write: 0 }, 'ok');
  assert.equal(db.rows.length, 0);
});

test('logUsage on the desk/desk-timeline/desk-board-refresh channels already on the whitelist still records', async () => {
  const db = fakeDb();
  const sink = makeD1UsageSink({ OC_DB: db as any });
  await sink.logUsage('desk', 'm', { input: 1, output: 1, cache_read: 0, cache_write: 0 });
  await sink.logUsage('desk-timeline', 'm', { input: 1, output: 1, cache_read: 0, cache_write: 0 });
  await sink.logUsage('desk-board-refresh', 'm', { input: 1, output: 1, cache_read: 0, cache_write: 0 });
  assert.deepEqual(db.rows.map((r) => r.channel), ['desk', 'desk-timeline', 'desk-board-refresh']);
});
