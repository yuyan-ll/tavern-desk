// 桌边话验收(ORDER 四):一段三轮正常、两轮桌边、再三轮正常的窗(这里一「楼」按一问一答算),
// 折叠批次只含六轮正常的,摘要素材里没有桌边字样,近景里有「(桌边)」前缀,板没被桌边楼改。
// 走上游真实的 handleDeskChat / maybeFoldDeskTimeline / deskBoardRefresh,库是内存 SQLite(D1 壳),
// 聊天模型是注入的假后端;时光带折叠和状态板重算走上游固定的 completeText,用假 fetch 接住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDeskChat } from '../../upstream/src/chat/desk.ts';
import { maybeFoldDeskTimeline, selectDeskTimelineFoldBatch } from '../../upstream/src/chat/deskTimeline.ts';
import { selectDeskTimelineFoldBatch as selectCore } from '../../upstream/src/core/deskTimelineFold.ts';
import { deskBoardRefresh } from '../../upstream/src/chat/deskBoardRefresh.ts';
import { isDeskAsideMessage, isDeskAsideFloor } from '../../upstream/src/core/deskAside.ts';
import { TavernStudyHost } from '../../upstream/src/core/tavernStudyHost.ts';
import { createMemoryStorage } from '../../upstream/src/adapters/memoryStorage.ts';
import { FakeModelBackend } from '../../upstream/src/adapters/fakeModelBackend.ts';
import type { ModelBackend, StreamChatArgs, StreamChatResult } from '../../upstream/src/core/modelBackend.ts';
import { deskFixture, readSse, type DeskFixture } from './helpers.ts';

const board = (place: string) => ({ 在场角色: ['米拉'], 衣装: { 米拉: '斗篷' }, 位置: place, 关系: {}, 时间地点: `夜·${place}` });
const fence = (b: unknown) => '\n\n```stateboard\n' + JSON.stringify(b) + '\n```';

// 按队列回话的假聊天模型:每次 streamChat 取下一条预备好的回复,并记下实际收到的 prompt。
class ScriptedBackend implements ModelBackend {
  readonly prompts: string[] = [];
  readonly replies: string[] = [];
  async streamChat(args: StreamChatArgs): Promise<StreamChatResult> {
    this.prompts.push(args.prompt);
    const text = this.replies.shift();
    if (text === undefined) throw new Error('没预备回复');
    await args.onEvent?.({ type: 'text', text });
    return { ok: true, terminal: 'clean', text, thinking: '', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: 'end_turn' };
  }
}

// completeText(时光带折叠 / 状态板重算)走全局 fetch;接住它,记下发过去的 user 消息。
function stubCompleteText(respond: (prompt: string) => string) {
  const original = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (body.stream) throw new Error('聊天不该走到 fetch(应走注入的后端)');
    const prompt = String(body.messages?.[0]?.content || '');
    prompts.push(prompt);
    const payload = { content: [{ type: 'text', text: respond(prompt) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { prompts, restore: () => { globalThis.fetch = original; } };
}

async function turn(fx: DeskFixture, env: any, backend: ScriptedBackend, message: string, reply: string, extra: Record<string, unknown> = {}) {
  backend.replies.push(reply);
  const frames = await readSse(await handleDeskChat(env, { window_id: fx.windowId, message, ...extra }, fx.storage, undefined, fx.waitUntil));
  await fx.settle();
  assert.equal(frames.at(-1)?.type, 'done', JSON.stringify(frames.at(-1)));
  return frames;
}

const NORMAL = ['第一幕:她推开门。', '第二幕:雨停了。', '第三幕:灯灭了。', '第四幕:有人敲窗。', '第五幕:她回头。', '第六幕:天亮了。'];
const ASIDE_IN = ['桌边:这段节奏是不是太快了?', '桌边\n先别写,米拉这时候知道信的事吗'];
const ASIDE_OUT = ['桌边回答一:是有点快,可以把雨写长一点。', '桌边回答二:她还不知道。'];
const prose = (i: number) => `正文${'一二三四五六'[i]}——灯下的影子挪了一寸。`;

test('判据:trim 后以「桌边」开头;标记只认 report.aside', () => {
  for (const m of ['桌边', '桌边:节奏', '桌边：节奏', '桌边 节奏', '桌边\n节奏', '桌边节奏', '  桌边\t节奏  ']) assert.equal(isDeskAsideMessage(m), true, m);
  for (const m of ['', '她在桌边坐下', '#桌边', ' 桌 边']) assert.equal(isDeskAsideMessage(m), false, m);
  assert.equal(isDeskAsideFloor({ report: { aside: true } }), true);
  assert.equal(isDeskAsideFloor({ report: '{"aside":true}' }), true);
  assert.equal(isDeskAsideFloor({ report: { aside: 'true' } }), false);
  assert.equal(isDeskAsideFloor({ report: '{' }), false);
  assert.equal(isDeskAsideFloor({ report: null }), false);
});

test('选折叠批次:两份同名纯函数都先滤桌边楼,终点钉在最后一条非桌边 assistant', () => {
  const floors = [
    { id: '1', role: 'user', report: null }, { id: '2', role: 'assistant', report: '{}' },
    { id: '3', role: 'user', report: '{"aside":true}' }, { id: '4', role: 'assistant', report: { aside: true } },
    { id: '5', role: 'user', report: {} }, { id: '6', role: 'assistant', report: {} },
    { id: '7', role: 'user', report: { aside: true } }, { id: '8', role: 'assistant', report: { aside: true } },
  ];
  for (const select of [selectDeskTimelineFoldBatch, selectCore]) {
    assert.deepEqual(select(floors).map((f) => f.id), ['1', '2', '5', '6']);
    // 正常 user 楼还没回、后面只跟着桌边楼:不能让游标越过那条没回的正常楼
    assert.deepEqual(select(floors.slice(0, 5).concat(floors.slice(6))).map((f) => f.id), ['1', '2']);
  }
});

test('桌边话:打标、近景前缀、板不动、折叠只收正常楼、手动重算跳过桌边楼、重 roll 保留标记', async () => {
  const fx = await deskFixture({ stateBoard: board('起点') });
  const backend = new ScriptedBackend();
  const env = { OC_DB: fx.db, ANTHROPIC_API_KEY: 'test-key', DESK_BACKEND: backend };
  const stub = stubCompleteText((prompt) => {
    if (prompt.includes('<楼层原文>')) return '摘要:她推门、雨停、灯灭,有人敲窗,她回头,天亮。';
    return '```stateboard\n' + JSON.stringify(board('重算')) + '\n```';
  });
  try {
    for (let i = 0; i < 3; i++) await turn(fx, env, backend, NORMAL[i], prose(i) + fence(board(`n${i + 1}`)));
    for (let i = 0; i < 2; i++) await turn(fx, env, backend, ASIDE_IN[i], ASIDE_OUT[i] + fence(board('桌边乱改')));

    // —— 状态板:桌边回楼带的板被剥掉、不采用,窗口板停在第三轮正常楼 ——
    assert.deepEqual((await fx.storage.deskStorage.getWindow(fx.windowId))?.stateBoard, board('n3'));
    let floors = await fx.storage.deskStorage.listFloors(fx.windowId);
    const asideReplies = floors.filter((f) => f.role === 'assistant' && f.report?.aside === true);
    assert.equal(asideReplies.length, 2);
    for (const f of asideReplies) {
      assert.ok(!f.content.includes('```stateboard'), '板围栏要从正文剥掉');
      assert.deepEqual(f.report?.boardAfter, board('n3'));
      assert.equal(f.report?.stateBoardStale, false);
      assert.equal(f.report?.stateBoardAutoRefreshed, undefined);
    }

    // —— 手动重算:最近一条模型楼是桌边楼,要跳过它,按第三轮正常正文算 ——
    const refreshed = await deskBoardRefresh(env as any, fx.windowId);
    assert.equal(refreshed.success, true, JSON.stringify(refreshed));
    const thirdNormal = floors.filter((f) => f.role === 'assistant' && !f.report?.aside).at(-1)!;
    assert.equal(refreshed.floor_id, thirdNormal.id);
    assert.ok(stub.prompts.at(-1)!.includes(prose(2)));
    assert.ok(!stub.prompts.at(-1)!.includes('桌边'));

    // —— 重 roll 最后一楼(桌边回楼):新版本照样记 aside,板照样不动 ——
    backend.replies.push('桌边回答二(重写):她还不知道,信在抽屉里。' + fence(board('桌边乱改')));
    const rollFrames = await readSse(await handleDeskChat(env as any, { window_id: fx.windowId, roll: true }, fx.storage, undefined, fx.waitUntil));
    await fx.settle();
    assert.equal(rollFrames.at(-1)?.type, 'done');
    const rolled = await fx.storage.deskStorage.getFloor(rollFrames.at(-1).id);
    assert.equal(rolled?.report?.aside, true);
    assert.deepEqual((await fx.storage.deskStorage.getWindow(fx.windowId))?.stateBoard, board('n3'));

    for (let i = 3; i < 6; i++) await turn(fx, env, backend, NORMAL[i], prose(i) + fence(board(`n${i + 1}`)));

    // —— 打标:用户楼和回楼都记 aside,正常楼不记 ——
    floors = await fx.storage.deskStorage.listFloors(fx.windowId);
    assert.equal(floors.length, 16);
    assert.deepEqual(floors.map((f) => f.report?.aside === true), [false, false, false, false, false, false, true, true, true, true, false, false, false, false, false, false]);
    assert.deepEqual((await fx.storage.deskStorage.getWindow(fx.windowId))?.stateBoard, board('n6'));

    // —— 近景:第四轮正常楼发出去的 tail 里,桌边楼带「(桌边)」前缀,正常楼不带 ——
    const fourth = backend.prompts.at(-3)!;
    assert.ok(fourth.includes(`你(桌边)：${ASIDE_IN[0]}`), fourth);
    assert.ok(fourth.includes(`角色(桌边)：${ASIDE_OUT[0]}`), fourth);
    assert.ok(fourth.includes(`你：${NORMAL[0]}`));
    assert.ok(!fourth.includes(`你(桌边)：${NORMAL[0]}`));

    // —— 时光带:强制折叠、一层不留;批次只含六轮正常楼(12 层),摘要素材里没有桌边字样 ——
    const fold = await maybeFoldDeskTimeline(env as any, fx.windowId, undefined, { force: true, keep: 0 });
    assert.equal(fold.success, true, JSON.stringify(fold));
    assert.equal(fold.folded, 12);
    const material = stub.prompts.at(-1)!;
    for (let i = 0; i < 6; i++) assert.ok(material.includes(prose(i)), `摘要素材缺第${i + 1}轮正文`);
    assert.ok(!material.includes('桌边'), material);
    // 游标照常越过夹在中间的桌边楼,停在最后一条正常模型楼
    const lastNormal = floors.filter((f) => f.role === 'assistant').at(-1)!;
    assert.equal(fold.newCutoff, `${lastNormal.createdAt}|${lastNormal.id}`);
    const timeline = (await fx.storage.deskStorage.getWindow(fx.windowId))?.timelineState as any;
    assert.equal(timeline.segs.length, 1);
    assert.ok(!timeline.segs[0].text.includes('桌边'));

    // 折叠后的下一轮:桌边楼已在游标之前,不再进近景
    await turn(fx, env, backend, '第七幕:她出门。', '正文七。' + fence(board('n7')));
    assert.ok(!backend.prompts.at(-1)!.includes('(桌边)'));
  } finally {
    stub.restore();
    await fx.close();
  }
});

test('桌边话:内存存储 + FakeModelBackend 的 TavernStudyHost 折叠同样不收桌边楼', async () => {
  const storage = createMemoryStorage();
  const model = new FakeModelBackend({ ok: true, terminal: 'clean', text: '摘要。', thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const host = new TavernStudyHost({ storage, model });
  const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
  await storage.desk.createWindow({ id: 'w', project: 'P', title: 'W', recipeId: 'r', note: '', noteDepth: 1, stateBoard: {}, timelineState: { segs: [], cutoff: null, rev: 0 }, vars: {}, createdAt: t(0), updatedAt: t(0) });
  const rows: Array<[string, string, boolean]> = [];
  for (let i = 0; i < 3; i++) rows.push(['user', NORMAL[i], false], ['assistant', prose(i), false]);
  for (let i = 0; i < 2; i++) rows.push(['user', ASIDE_IN[i], true], ['assistant', ASIDE_OUT[i], true]);
  for (let i = 3; i < 6; i++) rows.push(['user', NORMAL[i], false], ['assistant', prose(i), false]);
  let n = 1;
  for (const [role, content, aside] of rows) {
    await storage.desk.createFloor({ id: `f${String(n).padStart(2, '0')}`, windowId: 'w', role: role as any, content, variants: [content], activeVariant: 0, thinking: null, report: aside ? { aside: true } : {}, createdAt: t(n) });
    n++;
  }
  const r: any = await host.foldDeskTimeline({ windowId: 'w', force: true, keep: 0 });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.folded, 12);
  const prompt = model.calls[0].prompt;
  for (let i = 0; i < 6; i++) assert.ok(prompt.includes(prose(i)));
  assert.ok(!prompt.includes('桌边'), prompt);
});
