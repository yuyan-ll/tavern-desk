import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeModelBackend } from '../src/adapters/fakeModelBackend.ts';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';
import { DeskGenerationService } from '../src/core/deskGenerationService.ts';

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
// Generated-board fixtures must satisfy the write-path protocol gate (core/stateBoard.ts
// stateBoardGateErrors); `place` is the distinguishing value the assertions key on.
const protoBoard = (place: string) => ({ 在场角色: ['Mira'], 衣装: { Mira: 'cloak' }, 位置: place, 关系: {}, 时间地点: `night·${place}` });
const protoFence = (place: string) => '```stateboard\n' + JSON.stringify(protoBoard(place)) + '\n```';
const windowSeed = { id: 'w', project: 'P', title: 'W', recipeId: 'r', note: '', noteDepth: 3, stateBoard: {}, timelineState: {}, vars: {}, createdAt: 't0', updatedAt: 't0' };
const userSeed = { id: 'u', windowId: 'w', role: 'user' as const, content: 'go', variants: ['go'], activeVariant: 0, thinking: null, report: null, createdAt: 't0' };
async function seededStorage() { const storage = createMemoryStorage({ deskWindows: [windowSeed] }); await storage.desk.createFloor(userSeed); return storage; }

test('commits only a clean model result and streams progress events', async () => {
  const storage = await seededStorage(); const seen: string[] = [];
  const backend = new FakeModelBackend({ ok: true, terminal: 'clean', text: `<content>\nstory\n</content>\n${protoFence('new')}`, thinking: ' thought ', usage }, [{ type: 'text', text: 'story' }]);
  const service = new DeskGenerationService(backend, storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: protoBoard('old'), boardBeforeTrusted: true, committedAt: 't1', onEvent: (event) => { seen.push(event.type); } });
  assert.equal(result.success, true); assert.equal((await storage.desk.getFloor('f'))?.content, 'story');
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, protoBoard('new')); assert.deepEqual((await storage.desk.getFloor('f'))?.report?.boardBefore, protoBoard('old')); assert.deepEqual(seen, ['text']);
});

test('discards a generated board that fails the protocol gate and keeps the input board', async () => {
  const storage = await seededStorage();
  // Flat-string board: parses fine, but misses the protocol keys and target shapes.
  const backend = new FakeModelBackend({ ok: true, terminal: 'clean', text: 'story\n```stateboard\n{"place":"new"}\n```', thinking: '', usage });
  const service = new DeskGenerationService(backend, storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: protoBoard('old'), boardBeforeTrusted: true, committedAt: 't1' });
  assert.equal(result.success, true);
  // The floor still commits; only the board is refused — input board carries over, floor is
  // flagged stale, and the reasons are recorded for the frontend.
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, protoBoard('old'));
  const report = (await storage.desk.getFloor('f'))?.report || {};
  assert.equal(report.stateBoardStale, true);
  assert.equal(Array.isArray(report.stateBoardGateErrors) && (report.stateBoardGateErrors as string[]).length > 0, true);
  assert.deepEqual(report.boardAfter, protoBoard('old'));
});

test('does not write partial text when the backend lacks a clean terminal result', async () => {
  const storage = await seededStorage();
  const service = new DeskGenerationService(new FakeModelBackend({ ok: false, kind: 'protocol', detail: 'EOF', usage }), storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: {}, boardBeforeTrusted: true, committedAt: 't1' });
  assert.equal(result.success, false); assert.equal(await storage.desk.getFloor('f'), null);
});

test('rejects empty final content and an aborted request before commit', async () => {
  const storage = await seededStorage();
  const empty = new DeskGenerationService(new FakeModelBackend({ ok: true, terminal: 'clean', text: '<content>\n</content>', thinking: '', usage }), storage.deskTurn);
  const common = { windowId: 'w', mode: 'normal' as const, floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: {}, boardBeforeTrusted: true, committedAt: 't1' };
  assert.equal((await empty.generate(common)).success, false);
  const controller = new AbortController(); controller.abort();
  assert.equal((await empty.generate({ ...common, signal: controller.signal })).error, 'aborted');
  assert.equal(await storage.desk.getFloor('f'), null);
});

test('autoRefreshBoard: a stale board (model wrote no fence) gets refreshed and flagged once all four checks match', async () => {
  const storage = await seededStorage();
  // No ```stateboard fence at all: parsed.board stays null, so the committed floor lands with
  // stateBoardStale: true — the same precondition chat/desk.ts checks before calling
  // computeBoardFromText and then this port method.
  const backend = new FakeModelBackend({ ok: true, terminal: 'clean', text: 'story with no fence', thinking: '', usage });
  const service = new DeskGenerationService(backend, storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: protoBoard('old'), boardBeforeTrusted: true, committedAt: 't1' });
  assert.equal(result.success, true);

  const floor = await storage.desk.getFloor('f');
  const window = await storage.desk.getWindow('w');
  assert.equal(floor?.report?.stateBoardStale, true);
  const commitToken = (floor?.report as any)?.commitToken;
  assert.equal(typeof commitToken, 'string');

  const nextBoard = protoBoard('auto'); // stands in for the board computeBoardFromText would return
  const refresh = await storage.deskTurn.autoRefreshBoard({
    windowId: 'w', floorId: 'f',
    expectedWindowStateBoard: window!.stateBoard,
    expectedWindowUpdatedAt: window!.updatedAt,
    expectedFloorCreatedAt: floor!.createdAt,
    expectedFloorContent: floor!.content,
    expectedFloorCommitToken: commitToken,
    nextBoard,
    nextFloorReport: { ...floor!.report, commitToken, boardAfter: nextBoard, stateBoardAutoRefreshed: true },
    refreshedAt: 't2',
  });
  assert.deepEqual(refresh, { ok: true });
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, nextBoard);
  const after = await storage.desk.getFloor('f');
  assert.equal(after?.report?.stateBoardAutoRefreshed, true);
  assert.deepEqual(after?.report?.boardAfter, nextBoard);
});

test('autoRefreshBoard: any of the four checks failing leaves storage untouched and reports ok:false instead of throwing', async () => {
  const storage = await seededStorage();
  const backend = new FakeModelBackend({ ok: true, terminal: 'clean', text: 'story with no fence', thinking: '', usage });
  const service = new DeskGenerationService(backend, storage.deskTurn);
  await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: protoBoard('old'), boardBeforeTrusted: true, committedAt: 't1' });
  const floorBefore = await storage.desk.getFloor('f');
  const windowBefore = await storage.desk.getWindow('w');
  const commitToken = (floorBefore?.report as any)?.commitToken;

  // Simulate "补算期间又来了一楼": another floor lands in the window after the snapshot the
  // auto-refresh call is CAS-guarded against.
  await storage.desk.createFloor({ id: 'u2', windowId: 'w', role: 'user', content: 'more', variants: ['more'], activeVariant: 0, thinking: null, report: null, createdAt: 't1x' });

  const nextBoard = protoBoard('auto');
  const refresh = await storage.deskTurn.autoRefreshBoard({
    windowId: 'w', floorId: 'f',
    expectedWindowStateBoard: windowBefore!.stateBoard,
    expectedWindowUpdatedAt: windowBefore!.updatedAt,
    expectedFloorCreatedAt: floorBefore!.createdAt,
    expectedFloorContent: floorBefore!.content,
    expectedFloorCommitToken: commitToken,
    nextBoard,
    nextFloorReport: { ...floorBefore!.report, commitToken, boardAfter: nextBoard, stateBoardAutoRefreshed: true },
    refreshedAt: 't2',
  });
  assert.equal(refresh.ok, false); // no throw — a rejected CAS is a normal, quiet outcome
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, windowBefore!.stateBoard);
  assert.deepEqual(await storage.desk.getFloor('f'), floorBefore);
});

test('autoRefreshBoard never writes the window board without also tagging the floor report (no half-committed state)', async () => {
  // Regression guard for the class of bug the D1 adapter's db.batch fixes: a naive
  // window-write-then-floor-write split could leave the window board updated while the floor's
  // report never got its stateBoardAutoRefreshed tag, if the floor changed between the two writes.
  // Here the window's own CAS inputs (board bytes/updated_at) are still fresh, but the floor's
  // content no longer matches (as if it had been hand-edited between the snapshot and this call) —
  // the whole call must be all-or-nothing: window state_board must stay untouched, not just the floor.
  const storage = await seededStorage();
  const backend = new FakeModelBackend({ ok: true, terminal: 'clean', text: 'story with no fence', thinking: '', usage });
  const service = new DeskGenerationService(backend, storage.deskTurn);
  await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: protoBoard('old'), boardBeforeTrusted: true, committedAt: 't1' });
  const floorBefore = await storage.desk.getFloor('f');
  const windowBefore = await storage.desk.getWindow('w');
  const commitToken = (floorBefore?.report as any)?.commitToken;

  const nextBoard = protoBoard('auto');
  const refresh = await storage.deskTurn.autoRefreshBoard({
    windowId: 'w', floorId: 'f',
    expectedWindowStateBoard: windowBefore!.stateBoard, // still matches — window's own CAS would pass
    expectedWindowUpdatedAt: windowBefore!.updatedAt,   // still matches
    expectedFloorCreatedAt: floorBefore!.createdAt,
    expectedFloorContent: 'edited elsewhere',            // does not match floorBefore.content
    expectedFloorCommitToken: commitToken,
    nextBoard,
    nextFloorReport: { ...floorBefore!.report, commitToken, boardAfter: nextBoard, stateBoardAutoRefreshed: true },
    refreshedAt: 't2',
  });
  assert.equal(refresh.ok, false);
  // The window's board must not have been written even though its own CAS inputs matched —
  // both writes are gated on the same floor-identity check, atomically.
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, windowBefore!.stateBoard);
  assert.deepEqual(await storage.desk.getFloor('f'), floorBefore);
});

test('does not let an untrusted roll smuggle board snapshots through report fields', async () => {
  const oldFloor = { id: 'f', windowId: 'w', role: 'assistant' as const, content: 'v1', variants: ['v1'], activeVariant: 0, thinking: null, report: {}, createdAt: 't0' };
  const storage = createMemoryStorage({ deskWindows: [windowSeed], deskFloors: [oldFloor] });
  const service = new DeskGenerationService(new FakeModelBackend({ ok: true, terminal: 'clean', text: 'v2', thinking: '', usage }), storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'roll', floorId: 'f', expectedFloor: oldFloor,
    system: [], prompt: 'go', model: 'fake', report: { boardBefore: { forged: true }, boardAfter: { forged: true }, stateBoardStale: false, commitToken: 'forged' },
    stateBoard: { fallback: true }, boardBeforeTrusted: false, committedAt: 't1' });
  assert.equal(result.success, true);
  const report = (await storage.desk.getFloor('f'))?.report || {};
  assert.equal(Object.hasOwn(report, 'boardBefore'), false); assert.deepEqual(report.boardAfter, { fallback: true });
  assert.notEqual(report.commitToken, 'forged');
});
