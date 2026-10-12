import test from 'node:test';
import assert from 'node:assert/strict';
import { deskBoardRefresh } from '../src/chat/deskBoardRefresh.ts';

// Minimal fake D1 covering only the two statements deskBoardRefresh issues:
// window lookup and "most recent assistant floor" lookup.
function fakeDb(windows: Record<string, any>, floors: any[]) {
  return {
    prepare(sql: string) {
      const stmt = {
        args: [] as any[],
        bind(...args: any[]) { stmt.args = args; return stmt; },
        async first<T>() {
          if (sql.includes('FROM desk_windows')) {
            const id = stmt.args[0];
            return (windows[id] ?? null) as T;
          }
          if (sql.includes('FROM desk_floors')) {
            const windowId = stmt.args[0];
            const assistantFloors = floors
              .filter((f) => f.windowId === windowId && f.role === 'assistant')
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
            return (assistantFloors[0] ?? null) as T;
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      return stmt;
    },
  };
}

test('a trailing user floor is skipped: refresh still targets the most recent assistant floor', async () => {
  const db = fakeDb(
    { w1: { id: 'w1', state_board: JSON.stringify({ 位置: '客厅' }) } },
    [
      { windowId: 'w1', role: 'assistant', content: '模型写的正文', createdAt: '2026-01-01T00:00:00.000Z', id: 'f1' },
      { windowId: 'w1', role: 'user', content: '她刚发的话', createdAt: '2026-01-01T00:00:01.000Z', id: 'f2' },
    ],
  );
  // No ANTHROPIC_API_KEY configured: deskBoardRefresh must still get past floor selection and the
  // empty-board check before failing at the model-call gate — proving it picked the assistant floor
  // ("f1"), not the trailing user floor ("f2"), and did not reject on "last floor isn't assistant".
  const result = await deskBoardRefresh({ OC_DB: db as any }, 'w1');
  assert.equal(result.success, false);
  assert.equal(result.error, 'ANTHROPIC_API_KEY 没配');
});

test('no assistant floor at all: refresh reports a clear error instead of picking a user floor', async () => {
  const db = fakeDb(
    { w1: { id: 'w1', state_board: JSON.stringify({ 位置: '客厅' }) } },
    [{ windowId: 'w1', role: 'user', content: '她刚发的话', createdAt: '2026-01-01T00:00:00.000Z', id: 'f1' }],
  );
  const result = await deskBoardRefresh({ OC_DB: db as any }, 'w1');
  assert.equal(result.success, false);
  assert.match(result.error, /还没有模型写的楼层/);
});
