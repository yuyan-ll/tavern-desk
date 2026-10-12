// 测试共用:内存 SQLite(套 D1 壳,跑上游 init.sql)+ 上游 D1 适配器 + 一扇建好的写作窗。

import { resolve } from 'node:path';
import { openD1, type D1DatabaseShim } from '../d1shim.ts';
import { PendingWork } from '../bridge.ts';
import { D1DeskStorage } from '../../upstream/examples/cloudflare/adapters/d1DeskStorage.ts';
import { D1DeskTurnStorage } from '../../upstream/examples/cloudflare/adapters/d1DeskTurnStorage.ts';
import { D1DeskAssetStorage } from '../../upstream/examples/cloudflare/adapters/d1DeskAssetStorage.ts';
import { D1DeskStoryStorage } from '../../upstream/examples/cloudflare/adapters/d1DeskStoryStorage.ts';
import type { DeskChatStorage } from '../../upstream/src/chat/desk.ts';

export const SCHEMA_DIR = resolve(import.meta.dirname, '../../upstream/examples/cloudflare/schema');
export const LIGHT_SYSTEM = '接着写下去。';

export interface DeskFixture {
  db: D1DatabaseShim;
  storage: DeskChatStorage & { deskStorage: D1DeskStorage; turnStorage: D1DeskTurnStorage; deskAssets: D1DeskAssetStorage };
  windowId: string;
  // 传给 handleDeskChat 的 waitUntil:记账、时光带折叠都挂在这上面,close() 前等它们落地。
  waitUntil(promise: Promise<unknown>): void;
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function deskFixture(options: { stateBoard?: Record<string, unknown>; vars?: Record<string, string> } = {}): Promise<DeskFixture> {
  const db = openD1(':memory:', { schemaDir: SCHEMA_DIR });
  const d1 = db as unknown as D1Database;
  const deskStorage = new D1DeskStorage(d1);
  const turnStorage = new D1DeskTurnStorage(d1);
  const deskAssets = new D1DeskAssetStorage(d1);
  const deskStory = new D1DeskStoryStorage(d1);
  // 轻配方:不走积木队列,system 只有 light_system + 上游的状态板指令,夹具最小。
  await deskAssets.importPack({
    project: 'P', name: 'Light',
    recipe: { id: 'recipe', presetId: 'preset', weight: 'light', overrides: {}, regexIds: [], lightSystem: LIGHT_SYSTEM },
    blocks: [], regex: [],
  });
  const t0 = '2026-01-01T00:00:00.000Z';
  await deskStorage.createWindow({
    id: 'w', project: 'P', title: 'W', recipeId: 'recipe', note: '', noteDepth: 1,
    stateBoard: options.stateBoard ?? {}, timelineState: { segs: [], cutoff: null, rev: 0 }, vars: options.vars ?? {},
    createdAt: t0, updatedAt: t0,
  });
  const pending = new PendingWork();
  return {
    db,
    storage: { deskStorage, turnStorage, deskAssets, deskStory },
    windowId: 'w',
    waitUntil: (promise) => pending.add(promise),
    settle: () => pending.settle(),
    close: async () => { await pending.settle(); db.close(); },
  };
}

// 把 SSE 响应读完,拆成帧对象数组。
export async function readSse(response: Response): Promise<any[]> {
  const text = await response.text();
  return text.split('\n\n').map((f) => f.trim()).filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5).trim()));
}
