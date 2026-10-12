import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeModelBackend } from '../../upstream/src/adapters/fakeModelBackend.ts';
import { handleDeskChat } from '../../upstream/src/chat/desk.ts';
import { assembleDesk } from '../../upstream/src/chat/deskAssemble.ts';
import type { ModelBackend, StreamChatArgs, StreamChatResult } from '../../upstream/src/core/modelBackend.ts';
import { MistletoeBackend } from '../backend.ts';
import { FixedSegments, type SegmentProvider } from '../segments.ts';
import { deskFixture, readSse } from './helpers.ts';

const CLEAN: StreamChatResult = { ok: true, terminal: 'clean', text: '灯亮了。', thinking: '', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: 'end_turn' };

test('注入:handleDeskChat 经 env.DESK_BACKEND 发出的 system = 垫的段 + 上游拼的段,cache 标记原样', async () => {
  const fx = await deskFixture();
  try {
    const fake = new FakeModelBackend(CLEAN, [{ type: 'text', text: '灯亮了。' }]);
    const segments = [{ text: '宿主段一', cache: true }, { text: '宿主段二', cache: false }];
    const env = { OC_DB: fx.db, ANTHROPIC_API_KEY: 'unused', DESK_BACKEND: new MistletoeBackend(fake, new FixedSegments(segments)) };
    const frames = await readSse(await handleDeskChat(env as any, { window_id: fx.windowId, message: '她推开门。', model: 'claude-opus-4-8' }, fx.storage, undefined, fx.waitUntil));
    assert.deepEqual(frames.map((f) => f.type), ['user_saved', 'text', 'done']);

    // 上游本来要拼的 system:同一窗、同一输入、近景为空时 assembleDesk 的产出。
    const expected = await assembleDesk({ deskAssets: fx.storage.deskAssets, deskStory: fx.storage.deskStory }, {
      project: 'P', recipeId: 'recipe', input: '她推开门。', floors: [], note: '', noteDepth: 1, stateBoard: {}, vars: {}, timeline: '',
    });
    assert.equal(expected.success, true);
    assert.equal(fake.calls.length, 1);
    const sent = fake.calls[0];
    assert.deepEqual(sent.system.slice(0, 2), segments);
    assert.deepEqual(sent.system.slice(2), expected.system);
    assert.ok(expected.system.length >= 2, '上游段至少有 light_system 和状态板指令');
    assert.equal(sent.prompt, expected.tail);
    assert.equal(sent.model, 'claude-opus-4-8');

    // 楼层照常落库,注入不改账本
    const floors = await fx.storage.deskStorage.listFloors(fx.windowId);
    assert.deepEqual(floors.map((f) => [f.role, f.content]), [['user', '她推开门。'], ['assistant', '灯亮了。']]);
  } finally { await fx.close(); }
});

test('注入:不给 DESK_BACKEND 时上游照旧自己 new AnthropicStreamBackend(打到 fetch)', async () => {
  const fx = await deskFixture();
  const originalFetch = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = (async () => { hits++; return new Response('nope', { status: 500 }); }) as typeof fetch;
  try {
    const frames = await readSse(await handleDeskChat({ OC_DB: fx.db, ANTHROPIC_API_KEY: 'k' } as any, { window_id: fx.windowId, message: 'x' }, fx.storage, undefined, fx.waitUntil));
    assert.equal(hits, 1);
    assert.equal(frames.at(-1).type, 'error');
  } finally { await fx.close(); globalThis.fetch = originalFetch; }
});

test('MistletoeBackend:thinkingTags/signal/onEvent/prompt/model 原样透传,只动 system', async () => {
  const fake = new FakeModelBackend(CLEAN, [{ type: 'text', text: 'a' }, { type: 'thinking', text: 'b' }]);
  const backend = new MistletoeBackend(fake, new FixedSegments(['垫']));
  const seen: any[] = [];
  const signal = new AbortController().signal;
  const result = await backend.streamChat({
    system: [{ text: '上游', cache: true }], prompt: 'p', model: 'm', signal, thinkingTags: ['分镜'],
    onEvent: (e) => { seen.push(e); },
  });
  assert.deepEqual(result, CLEAN);
  assert.deepEqual(seen, [{ type: 'text', text: 'a' }, { type: 'thinking', text: 'b' }]);
  const call = fake.calls[0];
  assert.deepEqual(call.system, [{ text: '垫', cache: true }, { text: '上游', cache: true }]);
  assert.equal(call.prompt, 'p');
  assert.equal(call.model, 'm');
  assert.equal(call.signal, signal);
  assert.deepEqual(call.thinkingTags, ['分镜']);
});

test('MistletoeBackend:每楼按 model 取一次段;段取不到这一楼不发', async () => {
  const asked: string[] = [];
  const provider: SegmentProvider = { async segments({ model }) { asked.push(model); return [{ text: `给 ${model} 的段`, cache: false }]; } };
  const fake = new FakeModelBackend(CLEAN);
  const backend = new MistletoeBackend(fake, provider);
  await backend.streamChat({ system: [], prompt: '', model: 'claude-fable-5-1' });
  await backend.streamChat({ system: [], prompt: '', model: 'claude-opus-5-5' });
  assert.deepEqual(asked, ['claude-fable-5-1', 'claude-opus-5-5']);
  assert.deepEqual(fake.calls.map((c) => c.system[0].text), ['给 claude-fable-5-1 的段', '给 claude-opus-5-5 的段']);

  let innerCalled = false;
  const inner: ModelBackend = { async streamChat(_args: StreamChatArgs) { innerCalled = true; return CLEAN; } };
  const broken = new MistletoeBackend(inner, { async segments() { throw new Error('段文件读不了'); } });
  const r = await broken.streamChat({ system: [], prompt: '', model: 'm' });
  assert.equal(r.ok, false);
  assert.equal(innerCalled, false);
  const malformed = new MistletoeBackend(inner, { segments: async () => 'not an array' as any });
  assert.equal((await malformed.streamChat({ system: [], prompt: '', model: 'm' })).ok, false);
  assert.equal(innerCalled, false);
});

test('MistletoeBackend:上游 refusal 原样返回,不 fallback、不重试', async () => {
  let calls = 0;
  const inner: ModelBackend = { async streamChat() { calls++; return { ok: false, kind: 'refusal' }; } };
  const r = await new MistletoeBackend(inner, new FixedSegments(['垫'])).streamChat({ system: [], prompt: '', model: 'm' });
  assert.deepEqual(r, { ok: false, kind: 'refusal' });
  assert.equal(calls, 1);
});
