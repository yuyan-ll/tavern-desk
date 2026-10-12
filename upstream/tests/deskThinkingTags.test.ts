// deskThinkingTags(校验+容错读取)+ deskPresetUpdate(假 D1)单测,不连网不连真实 D1。
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateThinkingTags, readThinkingTags, effectiveThinkingTags } from '../src/tools/deskThinkingTags.ts';

test('①非数组→error', () => {
  const r = validateThinkingTags('分镜');
  assert.equal(r.ok, false);
});

test('②含非字符串→error 点名下标', () => {
  const r = validateThinkingTags(['分镜', 5]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /第2项/);
});

test('③[\' 分镜 \']→ok [\'分镜\'](trim)', () => {
  const r = validateThinkingTags([' 分镜 ']);
  assert.deepEqual(r, { ok: true, tags: ['分镜'] });
});

test('④[\'<分镜>\'](带尖括号)→error', () => {
  const r = validateThinkingTags(['<分镜>']);
  assert.equal(r.ok, false);
});

test('⑤[\'Content\']→error(保留名不分大小写)', () => {
  const r = validateThinkingTags(['Content']);
  assert.equal(r.ok, false);
});

test('⑥[\'a\',\'a\',\'thinking\']→ok [\'a\',\'thinking\'](精确去重,thinking允许出现)', () => {
  const r = validateThinkingTags(['a', 'a', 'thinking']);
  assert.deepEqual(r, { ok: true, tags: ['a', 'thinking'] });
});

test('⑦9个→error(超过8个上限)', () => {
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const r = validateThinkingTags(nine);
  assert.equal(r.ok, false);
});

test('⑧readThinkingTags(JSON字符串):非法项静默丢弃', () => {
  const out = readThinkingTags('{"thinkingTags":["分镜","<bad>","content",5]}');
  assert.deepEqual(out, ['分镜']);
});

test('⑨readThinkingTags(null)/(坏JSON)→[]', () => {
  assert.deepEqual(readThinkingTags(null), []);
  assert.deepEqual(readThinkingTags('not json'), []);
});

test('⑩effectiveThinkingTags:隐含thinking在前+用户名单去重', () => {
  const out = effectiveThinkingTags('{"thinkingTags":["thinking","分镜"]}');
  assert.deepEqual(out, ['thinking', '分镜']);
});

// ===== deskPresetUpdate 写路径(假 D1:只记录 SQL 与 bind,不真落库)=====
import { deskPresetUpdate } from '../src/tools/desk.ts';

function fakeEnv(row: any) {
  const calls: { sql: string; args: any[] }[] = [];
  const env: any = {
    OC_DB: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            calls.push({ sql, args });
            return {
              async first() { return sql.startsWith('SELECT') ? row : null; },
              async run() { return { success: true }; },
            };
          },
        };
      },
    },
  };
  return { env, calls };
}
const updates = (calls: { sql: string }[]) => calls.filter((c) => c.sql.startsWith('UPDATE'));

test('⑪PATCH 纯空白项→400 且不碰库', async () => {
  const { env, calls } = fakeEnv({ id: 'p1', params: '{"thinkingTags":["分镜"]}' });
  const r = await deskPresetUpdate(env, 'p1', { thinking_tags: [' '] });
  assert.equal(r.success, false);
  assert.match(r.error, /第1项/);
  assert.equal(calls.length, 0);
});

test('⑫非法标签→400 不查库', async () => {
  const { env, calls } = fakeEnv({ id: 'p1', params: '{}' });
  const r = await deskPresetUpdate(env, 'p1', { thinking_tags: ['<分镜>'] });
  assert.equal(r.success, false);
  assert.equal(calls.length, 0);
});

test('⑬params 坏 JSON→server 错且不 UPDATE', async () => {
  const { env, calls } = fakeEnv({ id: 'p1', params: '{not json' });
  const r = await deskPresetUpdate(env, 'p1', { thinking_tags: ['分镜'] });
  assert.equal(r.success, false);
  assert.equal(r.server, true);
  assert.equal(updates(calls).length, 0);
});

test('⑭params 是数组→server 错且不 UPDATE', async () => {
  const { env, calls } = fakeEnv({ id: 'p1', params: '[]' });
  const r = await deskPresetUpdate(env, 'p1', { thinking_tags: ['分镜'] });
  assert.equal(r.success, false);
  assert.equal(r.server, true);
  assert.equal(updates(calls).length, 0);
});

test('⑮正常保存:采样参数原样保留+thinkingTags 写入', async () => {
  const { env, calls } = fakeEnv({ id: 'p1', params: '{"temperature":0.8}' });
  const r = await deskPresetUpdate(env, 'p1', { thinking_tags: ['分镜', '准备稿'] });
  assert.equal(r.success, true);
  assert.deepEqual(r.preset.params, { temperature: 0.8, thinkingTags: ['分镜', '准备稿'] });
  const u = updates(calls);
  assert.equal(u.length, 1);
  assert.deepEqual(JSON.parse(u[0].args[0]), { temperature: 0.8, thinkingTags: ['分镜', '准备稿'] });
  assert.equal(u[0].args[1], 'p1');
});

test('⑯空数组=只删 thinkingTags 键,其余保留', async () => {
  const { env, calls } = fakeEnv({ id: 'p1', params: '{"temperature":0.8,"thinkingTags":["分镜"]}' });
  const r = await deskPresetUpdate(env, 'p1', { thinking_tags: [] });
  assert.equal(r.success, true);
  assert.deepEqual(r.preset.params, { temperature: 0.8 });
  assert.deepEqual(JSON.parse(updates(calls)[0].args[0]), { temperature: 0.8 });
});

test('⑰params 为 null(从未写过)→当空对象写入', async () => {
  const { env, calls } = fakeEnv({ id: 'p1', params: null });
  const r = await deskPresetUpdate(env, 'p1', { thinking_tags: ['分镜'] });
  assert.equal(r.success, true);
  assert.deepEqual(JSON.parse(updates(calls)[0].args[0]), { thinkingTags: ['分镜'] });
});

test('⑱预设不存在→预设包不存在', async () => {
  const { env } = fakeEnv(null);
  const r = await deskPresetUpdate(env, 'nope', { thinking_tags: ['分镜'] });
  assert.equal(r.success, false);
  assert.equal(r.error, '预设包不存在');
});
