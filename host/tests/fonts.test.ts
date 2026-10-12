// /fonts/ 路由:清单、取文件、目录不存在、越界路径。起法照 server.test.ts。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createDeskHost, type DeskHost } from '../server.ts';
import { loadConfig } from '../config.ts';

const TOKEN = 'test-token-0123';

async function start(withFonts: boolean): Promise<{ host: DeskHost; server: Server; base: string; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'desk-fonts-'));
  writeFileSync(join(dir, 'fake.key'), 'sk-test-not-real\n');
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'out', 'index.html'), '<!doctype html><title>书房</title>');
  if (withFonts) {
    mkdirSync(join(dir, 'fonts'));
    writeFileSync(join(dir, 'fonts', '霞鹜文楷.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
    writeFileSync(join(dir, 'fonts', 'b.ttf'), Buffer.from([0, 1, 0, 0]));
    writeFileSync(join(dir, 'fonts', 'readme.txt'), '不是字体');
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    port: 3889, dbPath: ':memory:', apiKeyFile: './fake.key', authToken: TOKEN, ownerToken: '',
    allowedOrigins: [], frontendDir: './out', fakeModel: true, fontsDir: './fonts',
  }));
  const host = await createDeskHost(loadConfig(join(dir, 'config.json')));
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    host, server, base,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('/fonts/index.json 列字体文件(只认字体扩展名,文件名去扩展名当名字)', async () => {
  const run = await start(true);
  try {
    const res = await fetch(`${run.base}/fonts/index.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ name: 'b', file: 'b.ttf' }, { name: '霞鹜文楷', file: '霞鹜文楷.woff2' }]);
  } finally { await run.stop(); }
});

test('/fonts/<文件> 原样给,带字体 content-type;越界和非字体一律 404', async () => {
  const run = await start(true);
  try {
    const ok = await fetch(`${run.base}/fonts/${encodeURIComponent('霞鹜文楷.woff2')}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'font/woff2');
    assert.equal((await ok.arrayBuffer()).byteLength, 4);
    for (const bad of ['/fonts/readme.txt', '/fonts/..%2Fconfig.json', '/fonts/nope.woff2', '/fonts/', '/fonts/a%2Fb.ttf']) {
      const res = await fetch(run.base + bad);
      assert.equal(res.status, 404, bad);
    }
  } finally { await run.stop(); }
});

test('字体目录不存在:清单 404,别的路由照常', async () => {
  const run = await start(false);
  try {
    assert.equal((await fetch(`${run.base}/fonts/index.json`)).status, 404);
    assert.equal((await fetch(`${run.base}/health`)).status, 200);
  } finally { await run.stop(); }
});
