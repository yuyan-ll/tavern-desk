import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { D1DeskStorage } from '../examples/cloudflare/adapters/d1DeskStorage.ts';
import { D1DeskTurnStorage } from '../examples/cloudflare/adapters/d1DeskTurnStorage.ts';
import { D1DeskAssetStorage } from '../examples/cloudflare/adapters/d1DeskAssetStorage.ts';
import { D1DeskStoryStorage } from '../examples/cloudflare/adapters/d1DeskStoryStorage.ts';
import { handleDeskChat, type DeskChatStorage } from '../src/chat/desk.ts';

// Protocol-gate-friendly board fixture (same shape convention as tests/deskGenerationService.test.ts).
const protoBoard = (place: string) => ({ 在场角色: ['Mira'], 衣装: { Mira: 'cloak' }, 位置: place, 关系: {}, 时间地点: `night-${place}` });

test('roll turn: the timeline fence bumps window.updated_at before auto-refresh runs, and auto-refresh must still land', { timeout: 30_000 }, async () => {
  const wranglerConfigHome = resolve('.tmp-wrangler-desk-roll-test');
  await mkdir(wranglerConfigHome, { recursive: true });
  process.env.XDG_CONFIG_HOME = wranglerConfigHome;
  const { getPlatformProxy } = await import('wrangler');
  const platform = await getPlatformProxy<{ OC_DB: D1Database }>({ configPath: 'wrangler.test.toml', persist: false });
  const originalFetch = globalThis.fetch;
  try {
    const db = platform.env.OC_DB;
    await db.batch([
      db.prepare(`CREATE TABLE desk_windows (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', recipe_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', note_depth INTEGER NOT NULL DEFAULT 1, state_board TEXT NOT NULL DEFAULT '{}', timeline_state TEXT NOT NULL DEFAULT '{}', vars TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT)`),
      db.prepare(`CREATE TABLE desk_floors (id TEXT PRIMARY KEY, window_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '', variants TEXT NOT NULL DEFAULT '[]', active_variant INTEGER NOT NULL DEFAULT 0, thinking TEXT, report TEXT, created_at TEXT NOT NULL)`),
      db.prepare(`CREATE INDEX desk_windows_project ON desk_windows(project)`),
      db.prepare(`CREATE INDEX desk_floors_window_created ON desk_floors(window_id, created_at)`),
      db.prepare(`CREATE TABLE desk_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', block_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`),
      db.prepare(`CREATE TABLE desk_blocks (id TEXT PRIMARY KEY, preset_id TEXT NOT NULL, identifier TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'system', content TEXT NOT NULL DEFAULT '', marker INTEGER NOT NULL DEFAULT 0, injection TEXT NOT NULL DEFAULT '{}', in_queue INTEGER NOT NULL DEFAULT 0, queue_pos INTEGER, enabled_default INTEGER NOT NULL DEFAULT 0, UNIQUE(preset_id, identifier))`),
      db.prepare(`CREATE TABLE desk_recipes (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, preset_id TEXT NOT NULL, weight TEXT NOT NULL CHECK(weight IN ('light','heavy')), overrides TEXT NOT NULL DEFAULT '{}', regex_ids TEXT NOT NULL DEFAULT '[]', params TEXT NOT NULL DEFAULT '{}', light_system TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT)`),
      db.prepare(`CREATE TABLE desk_regex (id TEXT PRIMARY KEY, scope TEXT NOT NULL, preset_id TEXT, name TEXT NOT NULL DEFAULT '', find TEXT NOT NULL, replace TEXT NOT NULL DEFAULT '', flags TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL CHECK(direction IN ('up','down','both')), enabled INTEGER NOT NULL DEFAULT 1, meta TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0)`),
      db.prepare(`CREATE TABLE memories (id TEXT PRIMARY KEY, project TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, lore_keys TEXT NOT NULL DEFAULT '[]', lore_position TEXT NOT NULL DEFAULT 'before', is_char INTEGER NOT NULL DEFAULT 0, lore_constant INTEGER NOT NULL DEFAULT 0, trigger_mode TEXT NOT NULL DEFAULT 'scan', lore_enabled INTEGER NOT NULL DEFAULT 1, lore_fields TEXT NOT NULL DEFAULT '{}')`),
      db.prepare(`CREATE TABLE oc_chapters (id TEXT PRIMARY KEY, project TEXT NOT NULL, chapter_no TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
      db.prepare(`CREATE TABLE oc_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
      db.prepare(`CREATE TABLE usage_log (id TEXT PRIMARY KEY, channel TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    ]);

    const deskStorage = new D1DeskStorage(db);
    const turnStorage = new D1DeskTurnStorage(db);
    const deskAssets = new D1DeskAssetStorage(db);
    const deskStory = new D1DeskStoryStorage(db);
    const storage: DeskChatStorage = { deskStorage, turnStorage, deskAssets, deskStory };

    // Light recipe: skips queue-block assembly entirely, keeps the fixture minimal.
    await deskAssets.importPack({
      project: 'P', name: 'Light',
      recipe: { id: 'recipe', presetId: 'preset', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue the story.' },
      blocks: [], regex: [],
    });

    const t0 = '2026-01-01T00:00:00.000Z';
    const oldBoard = protoBoard('old');
    // timelineState must be seeded explicitly (SEED_TIMELINE_STATE shape) — deskTimeline.ts never
    // seeds an unborn window, and its rev-based CAS needs a real starting rev to key off of.
    await deskStorage.createWindow({ id: 'w', project: 'P', title: 'W', recipeId: 'recipe', note: '', noteDepth: 3, stateBoard: oldBoard, timelineState: { segs: [], cutoff: null, rev: 0 }, vars: {}, createdAt: t0, updatedAt: t0 });
    await deskStorage.createFloor({ id: 'u', windowId: 'w', role: 'user', content: 'go on', variants: ['go on'], activeVariant: 0, thinking: null, report: null, createdAt: '2026-01-01T00:00:01.000Z' });
    const original = await turnStorage.commitAssistantFloor('w', 'f', { content: 'original reply', thinking: null, report: {}, stateBoard: oldBoard, committedAt: '2026-01-01T00:00:02.000Z' });
    assert.ok(original);

    // The model's primary roll reply carries NO ```stateboard fence at all (parsed board stays
    // null), so the committed floor lands stateBoardStale — this is what triggers the auto-refresh
    // path this test is about. The second (non-streaming) response, used by computeBoardFromText's
    // completeText call, returns a legitimate board so auto-refresh can actually succeed.
    const autoBoard = protoBoard('auto');
    const cleanSse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"rolled reply, no fence at all"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}', '',
      'data: {"type":"message_stop"}', '',
    ].join('\n');
    // Both AnthropicStreamBackend and completeText hit the same default endpoint with plain global
    // fetch (neither takes an injectable fetch from chat/desk.ts) — distinguish them by the
    // `stream` flag completeText strips off buildModelParams's request body.
    globalThis.fetch = (async (_input: any, init: any) => {
      const parsed = init?.body ? JSON.parse(String(init.body)) : {};
      if (parsed.stream) {
        return new Response(cleanSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const payload = { content: [{ type: 'text', text: '```stateboard\n' + JSON.stringify(autoBoard) + '\n```' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const response = await handleDeskChat(
      { OC_DB: db, ANTHROPIC_API_KEY: 'test-key' } as any,
      { window_id: 'w', roll: true },
      storage,
    );
    await response.text(); // drain the SSE stream: resolves only after writer.close(), i.e. after
    // finalizeDeskTurn (roll commit + timeline fence + auto-refresh) has fully run.

    const floor = await deskStorage.getFloor('f');
    assert.equal(floor?.content, 'rolled reply, no fence at all');
    assert.equal(floor?.report?.stateBoardStale, true); // primary reply carried no fence at all
    // This is the regression this test guards: fenceDeskTimelineAfterWrite (which runs before the
    // auto-refresh block) always bumps desk_windows.updated_at again by writing a fresh timestamp.
    // If auto-refresh still compares against the pre-fence `now`, its window CAS can never match
    // and this flag would stay unset forever (silently — the turn still "succeeds" and reports
    // done, just without ever landing the board fix-up).
    assert.equal(floor?.report?.stateBoardAutoRefreshed, true);
    assert.deepEqual(floor?.report?.boardAfter, autoBoard);

    const window = await deskStorage.getWindow('w');
    assert.deepEqual(window?.stateBoard, autoBoard);
  } finally {
    globalThis.fetch = originalFetch;
    await platform.dispose();
  }
});
