import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDeskHost, type DeskHost } from '../server.ts';
import { loadConfig, readApiKey } from '../config.ts';
import type { ModelBackend, StreamChatArgs, StreamChatResult } from '../../upstream/src/core/modelBackend.ts';

const TOKEN = 'test-token-0123';
const CLEAN: StreamChatResult = { ok: true, terminal: 'clean', text: '一二', thinking: '', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: 'end_turn' };

interface Running { host: DeskHost; server: Server; base: string; dir: string; stop(): Promise<void> }

async function start(extra: Record<string, unknown> = {}): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'desk-host-'));
  writeFileSync(join(dir, 'fake.key'), '\n  sk-test-not-real  \n');
  const out = join(dir, 'out');
  mkdirSync(join(out, '_next/static/chunks'), { recursive: true });
  writeFileSync(join(out, 'index.html'), '<!doctype html><title>书房</title>');
  writeFileSync(join(out, 'study.html'), '<!doctype html><title>study</title>');
  writeFileSync(join(out, '_next/static/chunks/app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    port: 3889, dbPath: ':memory:', apiKeyFile: './fake.key', authToken: TOKEN, ownerToken: '',
    allowedOrigins: [], frontendDir: './out', fakeModel: true, ...extra,
  }));
  const host = await createDeskHost(loadConfig(join(dir, 'config.json')));
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    host, server, base, dir,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function api(base: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}/${TOKEN}/api/oc${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

// 导一个最小预设 → 配方 → 写作窗,返回窗 id。
async function makeWindow(base: string): Promise<string> {
  const preset = await api(base, '/desk/import/preset?name=mini', {
    prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: '你是一位小说家。' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
  });
  assert.equal(preset.success, true, JSON.stringify(preset));
  const recipe = await api(base, '/desk/recipes', { name: 'r', preset_id: preset.id });
  assert.equal(recipe.success, true, JSON.stringify(recipe));
  const win = await api(base, '/desk/windows', { project: '试跑', recipe_id: recipe.id });
  assert.equal(win.success, true, JSON.stringify(win));
  return win.id;
}

test('配置:key 文件只取第一行非空;authToken 不合规就起不来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-cfg-'));
  try {
    writeFileSync(join(dir, 'k'), '\n\n  sk-abc \nsecond\n');
    assert.equal(readApiKey(join(dir, 'k')), 'sk-abc');
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ dbPath: 'd.sqlite', apiKeyFile: 'k', authToken: '' }));
    assert.throws(() => loadConfig(join(dir, 'c.json')), /authToken 必填/);
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ dbPath: 'd.sqlite', apiKeyFile: 'k', authToken: 'has/slash-token' }));
    assert.throws(() => loadConfig(join(dir, 'c.json')), /authToken/);
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ dbPath: 'd.sqlite', apiKeyFile: 'k', authToken: 'good-token-1', allowedOrigins: 'https://a.example, https://b.example' }));
    const c = loadConfig(join(dir, 'c.json'));
    assert.equal(c.port, 3889);
    assert.equal(c.dbPath, join(dir, 'd.sqlite'));
    assert.deepEqual(c.allowedOrigins, ['https://a.example', 'https://b.example']);
    assert.throws(() => readApiKey(join(dir, 'missing')), (e: Error) => /ENOENT/.test(e.message) && !e.message.includes('sk-abc'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('宿主:静态前端托管在 /,API 照上游在 /{AUTH_TOKEN}/api/oc/...', async () => {
  const run = await start();
  try {
    const index = await fetch(`${run.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') || '', /text\/html/);
    assert.match(await index.text(), /书房/);
    const study = await fetch(`${run.base}/study`);
    assert.match(await study.text(), /study/);
    const chunk = await fetch(`${run.base}/_next/static/chunks/app.js`);
    assert.match(chunk.headers.get('cache-control') || '', /immutable/);
    assert.equal((await fetch(`${run.base}/..%2f..%2fconfig.json`)).status, 401); // 逃不出前端目录,落到上游
    assert.equal((await fetch(`${run.base}/health`)).status, 200);

    assert.equal((await fetch(`${run.base}/wrong-token/api/oc/stats`)).status, 401);
    const stats = await fetch(`${run.base}/${TOKEN}/api/oc/stats`);
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).success, true);
  } finally { await run.stop(); }
});

test('宿主:ALLOWED_ORIGINS 默认是自己的 origin(含反代转发的 https 域名)', async () => {
  const run = await start();
  try {
    const own = await fetch(`${run.base}/${TOKEN}/api/oc/stats`, { method: 'OPTIONS', headers: { origin: run.base } });
    assert.equal(own.status, 204);
    assert.equal(own.headers.get('access-control-allow-origin'), run.base);
    const other = await fetch(`${run.base}/${TOKEN}/api/oc/stats`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(other.status, 403);
    const proxied = await fetch(`${run.base}/${TOKEN}/api/oc/stats`, {
      method: 'OPTIONS', headers: { origin: 'https://desk.example.net', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'desk.example.net' },
    });
    assert.equal(proxied.headers.get('access-control-allow-origin'), 'https://desk.example.net');
  } finally { await run.stop(); }
});

test('宿主:试跑模式推一楼,SSE 有 text 和 done;垫的段在最前面', async () => {
  const run = await start();
  try {
    const windowId = await makeWindow(run.base);
    const res = await fetch(`${run.base}/${TOKEN}/api/oc/desk/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ window_id: windowId, message: '她推开门。' }) });
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const frames = (await res.text()).split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5)));
    const types = frames.map((f) => f.type);
    assert.ok(types.includes('text'));
    assert.equal(types.at(-1), 'done');
    const backend = run.host.env.DESK_BACKEND as any;
    assert.match(backend.inner.calls[0].system[0].text, /试跑模式垫的段/);
  } finally { await run.stop(); }
});

test('宿主:SSE 不攒——模型还在写,前面的帧已经到了;客户端断开 → 模型那头收到 abort', async () => {
  const run = await start();
  try {
    const windowId = await makeWindow(run.base);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let aborted!: () => void;
    const sawAbort = new Promise<void>((r) => { aborted = r; });
    const slow: ModelBackend = {
      async streamChat(args: StreamChatArgs) {
        await args.onEvent?.({ type: 'text', text: '先到的字' });
        args.signal?.addEventListener('abort', () => aborted(), { once: true });
        await gate;
        return args.signal?.aborted ? { ok: false, kind: 'aborted' } : CLEAN;
      },
    };
    run.host.env.DESK_BACKEND = slow;
    const controller = new AbortController();
    const res = await fetch(`${run.base}/${TOKEN}/api/oc/desk/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ window_id: windowId, message: 'x' }), signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('先到的字')) {
      const { value, done } = await reader.read();
      assert.equal(done, false, '模型没写完之前流不该结束');
      seen += decoder.decode(value, { stream: true });
    }
    controller.abort();
    await Promise.race([sawAbort, new Promise((_, rej) => setTimeout(() => rej(new Error('断开后 5 秒还没传到模型那头')), 5000))]);
    release();
    await run.host.pending.settle();
    // 被中止的这一楼不入账:只有用户楼,没有模型楼
    const win = await api(run.base, `/desk/windows/${windowId}`);
    assert.deepEqual(win.floors.map((f: any) => f.role), ['user']);
  } finally { await run.stop(); }
});

test('宿主:defaultModel 只在聊天口没带 model 时补上', async () => {
  const run = await start({ defaultModel: 'claude-opus-4-8' });
  try {
    const windowId = await makeWindow(run.base);
    const post = (body: unknown) => fetch(`${run.base}/${TOKEN}/api/oc/desk/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.text());
    await post({ window_id: windowId, message: '一' });
    await post({ window_id: windowId, message: '二', model: 'claude-sonnet-4-6' });
    const calls = (run.host.env.DESK_BACKEND as any).inner.calls;
    assert.deepEqual(calls.map((c: any) => c.model), ['claude-opus-4-8', 'claude-sonnet-4-6']);
  } finally { await run.stop(); }
});

test('宿主:close() 等 waitUntil 里的活儿干完再关库', async () => {
  const run = await start();
  let finished = false;
  run.host.pending.add(new Promise<void>((r) => setTimeout(() => { finished = true; r(); }, 50)));
  await run.stop();
  assert.equal(finished, true);
});
