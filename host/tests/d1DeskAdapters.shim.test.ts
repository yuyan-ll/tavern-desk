// 复制自 upstream/tests/d1DeskAdapters.test.ts,只把数据库来源换成 host/d1shim.ts(其余断言一字不改)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { D1DeskStorage } from '../../upstream/examples/cloudflare/adapters/d1DeskStorage.ts';
import { D1DeskTurnStorage } from '../../upstream/examples/cloudflare/adapters/d1DeskTurnStorage.ts';
import { D1DeskAssetStorage } from '../../upstream/examples/cloudflare/adapters/d1DeskAssetStorage.ts';
import { D1ReadingStorage } from '../../upstream/examples/cloudflare/adapters/d1ReadingStorage.ts';
import { openD1 } from '../d1shim.ts';

test('D1 desk adapters preserve atomic commits, conflicts, malformed JSON, and composite truncation', { timeout: 30_000 }, async () => {
  // 只换数据库来源:wrangler/miniflare 的 D1 → node:sqlite 上的 D1 形状壳(内存库)。
  const shim = openD1(':memory:');
  try {
    const db = shim as unknown as D1Database;
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
      db.prepare(`CREATE TABLE oc_comments (id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, reply_to TEXT, author_id TEXT NOT NULL, author_type TEXT NOT NULL, display_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`),
    ]);
    const desk = new D1DeskStorage(db); const turns = new D1DeskTurnStorage(db);
    const t0 = '2026-01-01T00:00:00.000Z'; const t1 = '2026-01-01T00:00:01.000Z'; const t2 = '2026-01-01T00:00:02.000Z';
    const window = { id: 'w', project: 'P', title: 'W', recipeId: 'r', note: '', noteDepth: 3, stateBoard: {}, timelineState: {}, vars: {}, createdAt: t0, updatedAt: t0 };
    await desk.createWindow(window);
    const userFloor = { id: 'u', windowId: 'w', role: 'user' as const, content: 'go', variants: ['go'], activeVariant: 0, thinking: null, report: null, createdAt: t1 };
    await desk.createFloor(userFloor);
    const first = await turns.commitAssistantFloor('w', 'f', { content: 'v1', thinking: null, report: {}, stateBoard: { step: 1 }, committedAt: t2 });
    assert.equal(first?.content, 'v1'); assert.equal(first?.report?.commitToken === undefined, false);
    assert.equal(await turns.commitAssistantFloor('w', 'f', { content: 'duplicate', thinking: null, report: {}, stateBoard: { step: 99 }, committedAt: t2 }), null);
    assert.deepEqual((await desk.getWindow('w'))?.stateBoard, { step: 1 });

    await db.prepare(`UPDATE desk_floors SET thinking = 'concurrent' WHERE id = 'f'`).run();
    const conflict = await turns.rollAssistantFloor({ windowId: 'w', floorId: 'f', expected: first!, commit: { content: 'v2', thinking: null, report: {}, stateBoard: { step: 2 }, committedAt: 't2' } });
    assert.equal(conflict, null); assert.deepEqual((await desk.getWindow('w'))?.stateBoard, { step: 1 });

    await db.prepare(`UPDATE desk_floors SET variants = '{', report = '{' WHERE id = 'f'`).run();
    const repairedView = await desk.getFloor('f');
    const malformed = await turns.rollAssistantFloor({ windowId: 'w', floorId: 'f', expected: repairedView!, commit: { content: 'v3', thinking: null, report: {}, stateBoard: { step: 3 }, committedAt: 't3' } });
    assert.equal(malformed, null); assert.deepEqual((await desk.getWindow('w'))?.stateBoard, { step: 1 });

    await desk.createWindow({ ...window, id: 'w2' });
    await desk.createFloor({ id: 'a', windowId: 'w2', role: 'user', content: 'a', variants: ['a'], activeVariant: 0, thinking: null, report: null, createdAt: 'same' });
    await desk.createFloor({ id: 'b', windowId: 'w2', role: 'assistant', content: 'b', variants: ['b'], activeVariant: 0, thinking: null, report: null, createdAt: 'same' });
    assert.equal(await desk.truncateFloors('w2', 'a', false), 1);
    assert.deepEqual((await desk.listFloors('w2')).map((row) => row.id), ['a']);

    const timeline = await desk.updateTimelineState('w', t2, { segs: [{ text: 'summary', upto: 't0|u' }], cutoff: 't0|u', rev: 1 }, 't4');
    assert.equal((timeline?.timelineState as any).rev, 1);
    assert.equal(await desk.updateTimelineState('w', 't1', { rev: 2 }, 't5'), null);

    const assets = new D1DeskAssetStorage(db);
    await assets.importPack({ project: 'P', name: 'Light', recipe: { id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: ['rx'], lightSystem: 'Continue.' }, blocks: [{ identifier: 'main', name: 'Main', role: 'system', content: 'x', marker: false, queuePos: 0, enabledDefault: true }], regex: [{ id: 'rx', find: 'x', replace: 'y', flags: 'g', direction: 'up', meta: {} }] });
    assert.equal((await assets.getRecipe('r'))?.lightSystem, 'Continue.');
    assert.equal((await assets.listQueueBlocks('p')).length, 1);
    assert.deepEqual((await assets.listUpRegexForPreset('p')).map((row) => row.id), ['rx']);

    // getPresetParams: raw params column value for an existing preset, null when the id is missing.
    assert.equal(await assets.getPresetParams('p'), '{}');
    assert.equal(await assets.getPresetParams('nope'), null);
    await db.prepare(`UPDATE desk_presets SET params = ? WHERE id = 'p'`).bind(JSON.stringify({ thinkingTags: ['分镜'] })).run();
    assert.deepEqual(JSON.parse(String(await assets.getPresetParams('p'))), { thinkingTags: ['分镜'] });

    // Same-sortOrder tie-break must match SQLite's BINARY (UTF-8 byte) order: a supplementary-plane
    // id (U+10000) sorts AFTER a private-use-area id (U+E000) here — verifies the memory adapter's
    // ordinalCompare (see tests/deskAssetStorage.test.ts) actually agrees with real D1 on this pair,
    // not just internally with itself. Plain UTF-16 code-unit comparison would get this backwards
    // (U+10000's leading surrogate 0xD800 < 0xE000).
    const pua = '\u{E000}'; const supplementary = '\u{10000}';
    await db.batch([
      db.prepare(`INSERT INTO desk_regex (id, scope, preset_id, find, replace, flags, direction, enabled, meta, sort_order) VALUES (?, 'preset', 'p', 'x', 'y', '', 'up', 1, '{}', 0)`).bind(supplementary),
      db.prepare(`INSERT INTO desk_regex (id, scope, preset_id, find, replace, flags, direction, enabled, meta, sort_order) VALUES (?, 'preset', 'p', 'x', 'y', '', 'up', 1, '{}', 0)`).bind(pua),
    ]);
    assert.deepEqual((await assets.listUpRegexForPreset('p')).map((row) => row.id), ['rx', pua, supplementary]);

    // autoRefreshBoard: the two UPDATEs run inside one db.batch (single implicit D1 transaction) —
    // a matching call writes both window.state_board and the floor's report tag together; a call
    // whose floor-identity input no longer matches must leave BOTH untouched, even when the
    // window's own CAS inputs (board bytes/updated_at) still match on their own — proving the two
    // writes are gated on the same shared precondition rather than applied independently.
    await desk.createWindow({ ...window, id: 'w3' });
    const refreshCommit = await turns.commitAssistantFloor('w3', 'rf', { content: 'stale text', thinking: null, report: { stateBoardStale: true }, stateBoard: { step: 1 }, committedAt: t2 });
    const refreshToken = String(refreshCommit?.report?.commitToken);
    const okRefresh = await turns.autoRefreshBoard({
      windowId: 'w3', floorId: 'rf',
      expectedWindowStateBoard: { step: 1 }, expectedWindowUpdatedAt: t2,
      expectedFloorCreatedAt: t2, expectedFloorContent: 'stale text', expectedFloorCommitToken: refreshToken,
      nextBoard: { step: 2 }, nextFloorReport: { stateBoardStale: true, commitToken: refreshToken, boardAfter: { step: 2 }, stateBoardAutoRefreshed: true },
      refreshedAt: 't6',
    });
    assert.deepEqual(okRefresh, { ok: true });
    assert.deepEqual((await desk.getWindow('w3'))?.stateBoard, { step: 2 });
    assert.equal((await desk.getFloor('rf'))?.report?.stateBoardAutoRefreshed, true);

    const missedRefresh = await turns.autoRefreshBoard({
      windowId: 'w3', floorId: 'rf',
      expectedWindowStateBoard: { step: 2 }, expectedWindowUpdatedAt: 't6', // matches the state just written above
      expectedFloorCreatedAt: t2, expectedFloorContent: 'a different snapshot of the text', expectedFloorCommitToken: refreshToken,
      nextBoard: { step: 3 }, nextFloorReport: { stateBoardAutoRefreshed: true },
      refreshedAt: 't7',
    });
    assert.equal(missedRefresh.ok, false);
    assert.deepEqual((await desk.getWindow('w3'))?.stateBoard, { step: 2 }); // not bumped to step 3
    assert.deepEqual((await desk.getFloor('rf'))?.report?.boardAfter, { step: 2 }); // report untouched from the earlier successful refresh

    // Reverse half-state (codex round 2, #1): a D1 batch only rolls back on a thrown error, not on
    // a statement matching 0 rows — so the floor UPDATE (which only checks content/commitToken) can
    // independently succeed even when the window UPDATE's own CAS misses, unless the floor UPDATE
    // is also gated on the window having already landed the new values. Verified both ways the
    // window guard can fail while the floor's own identity (content/commitToken) still matches:
    const staleUpdatedAt = await turns.autoRefreshBoard({
      windowId: 'w3', floorId: 'rf',
      expectedWindowStateBoard: { step: 2 }, expectedWindowUpdatedAt: 'wrong-updated-at', // ① window's own updated_at is stale
      expectedFloorCreatedAt: t2, expectedFloorContent: 'stale text', expectedFloorCommitToken: refreshToken,
      nextBoard: { step: 4 }, nextFloorReport: { stateBoardAutoRefreshed: true, decoy: 'must not land' },
      refreshedAt: 't8',
    });
    assert.equal(staleUpdatedAt.ok, false);
    assert.deepEqual((await desk.getWindow('w3'))?.stateBoard, { step: 2 }); // not bumped to step 4
    assert.deepEqual((await desk.getFloor('rf'))?.report?.boardAfter, { step: 2 }); // report not overwritten with the decoy

    await desk.createFloor({ id: 'rf2', windowId: 'w3', role: 'user', content: 'a newer floor landed', variants: ['a newer floor landed'], activeVariant: 0, thinking: null, report: null, createdAt: 't6x' });
    const newerFloorLanded = await turns.autoRefreshBoard({
      windowId: 'w3', floorId: 'rf',
      // window's own board bytes/updated_at still match on their own — only the "still the
      // window's latest floor" NOT EXISTS clause fails, because rf2 landed after rf.
      expectedWindowStateBoard: { step: 2 }, expectedWindowUpdatedAt: 't6', // ② a newer floor has landed
      expectedFloorCreatedAt: t2, expectedFloorContent: 'stale text', expectedFloorCommitToken: refreshToken,
      nextBoard: { step: 5 }, nextFloorReport: { stateBoardAutoRefreshed: true, decoy: 'must not land' },
      refreshedAt: 't9',
    });
    assert.equal(newerFloorLanded.ok, false);
    assert.deepEqual((await desk.getWindow('w3'))?.stateBoard, { step: 2 }); // not bumped to step 5
    assert.deepEqual((await desk.getFloor('rf'))?.report?.boardAfter, { step: 2 }); // report not overwritten with the decoy

    // Reverse half-state (codex round 3, #1): the floor EXISTS(window = new values) guard alone can
    // be fooled when the "new" values coincide with values the window already holds — here nextBoard
    // is byte-identical to the board already stored, and refreshedAt is passed as the window's
    // current (and expected) updated_at, while rf2 (still present from the test above) makes the
    // window UPDATE fail on its NOT EXISTS clause alone. Without the (SELECT changes())=1 guard and
    // the internal refreshedAt-bump, the floor UPDATE would see its EXISTS(window=new values) satisfied
    // by sheer coincidence and wrongly tag the floor even though the window write did nothing.
    const coincidentalValues = await turns.autoRefreshBoard({
      windowId: 'w3', floorId: 'rf',
      expectedWindowStateBoard: { step: 2 }, expectedWindowUpdatedAt: 't6', // matches the window's real current state
      expectedFloorCreatedAt: t2, expectedFloorContent: 'stale text', expectedFloorCommitToken: refreshToken,
      nextBoard: { step: 2 }, // identical bytes to the board already stored
      nextFloorReport: { stateBoardAutoRefreshed: true, decoy: 'must not land' },
      refreshedAt: 't6', // identical to the window's current (and expected) updated_at
    });
    assert.equal(coincidentalValues.ok, false);
    assert.deepEqual((await desk.getWindow('w3'))?.stateBoard, { step: 2 });
    assert.deepEqual((await desk.getFloor('rf'))?.report?.boardAfter, { step: 2 });
    assert.equal((await desk.getFloor('rf'))?.report?.decoy, undefined);

    // codex round 3, #2: the floor predicates must be bound to window_id too, or a wrong windowId
    // paired with a floorId that actually belongs to a different window could still match. w4 is a
    // separate, real window; rf belongs to w3, not w4 — everything about w4's own CAS inputs is
    // otherwise correct, and rf's content/commitToken are otherwise correct too, but the pairing is
    // wrong and nothing may move.
    await desk.createWindow({ ...window, id: 'w4', stateBoard: { other: true }, updatedAt: t0 });
    const crossWindow = await turns.autoRefreshBoard({
      windowId: 'w4', floorId: 'rf', // rf actually belongs to w3
      expectedWindowStateBoard: { other: true }, expectedWindowUpdatedAt: t0, // w4's own real current state
      expectedFloorCreatedAt: t2, expectedFloorContent: 'stale text', expectedFloorCommitToken: refreshToken, // rf's real identity
      nextBoard: { hijacked: true }, nextFloorReport: { stateBoardAutoRefreshed: true, decoy: 'must not land' },
      refreshedAt: 't10',
    });
    assert.equal(crossWindow.ok, false);
    assert.deepEqual((await desk.getWindow('w4'))?.stateBoard, { other: true }); // w4 untouched
    assert.deepEqual((await desk.getWindow('w3'))?.stateBoard, { step: 2 }); // w3 untouched too
    assert.deepEqual((await desk.getFloor('rf'))?.report?.boardAfter, { step: 2 }); // rf's report untouched

    const reading = new D1ReadingStorage(db);
    await reading.createChapter({ id: 'ch', project: 'P', chapterNo: '1', title: 'One', content: 'Body', summary: '', status: 'draft', createdAt: 't0', updatedAt: 't0', publishedAt: null });
    assert.equal((await reading.publishChapter('ch', 't1'))?.status, 'published');
    assert.equal((await reading.getPublishedChapter('ch'))?.content, 'Body');
  } finally { shim.close(); }
});
