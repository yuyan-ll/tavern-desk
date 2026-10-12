import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';

test('serves desk assembly assets without Cloudflare or a database', async () => {
  const storage = createMemoryStorage({
    deskPresetIds: ['preset'],
    deskRecipes: [{ id: 'recipe', presetId: 'preset', weight: 'heavy', overrides: {}, regexIds: ['r2'], lightSystem: '' }],
    deskRegex: [
      { id: 'r1', find: 'x', flags: 'g', replace: 'y', direction: 'up', meta: {} },
      { id: 'r2', find: 'a', flags: '', replace: 'b', direction: 'both', meta: { scope: 'prompt' } },
    ],
    deskBlocks: [{ presetId: 'preset', identifier: 'main', name: 'Main', role: 'system', content: 'Prompt', marker: true, queuePos: 0, enabledDefault: true }],
    deskLore: [
      { project: 'P', id: 'z', name: 'Z', content: 'z', keys: [], position: 'broken', isCharacter: true, constant: false, triggerMode: 'presence', fields: {} },
      { project: 'P', id: 'a', name: 'A', content: 'a', keys: [], position: 'before', isCharacter: false, constant: true, triggerMode: 'scan', fields: {} },
    ],
  });
  assert.equal(await storage.deskAssets.hasPreset('preset'), true);
  assert.equal((await storage.deskAssets.getRecipe('recipe'))?.regexIds[0], 'r2');
  assert.deepEqual((await storage.deskAssets.listRegex(['r2'])).map((row) => row.id), ['r2']);
  assert.deepEqual((await storage.deskAssets.listQueueBlocks('preset')).map((row) => row.identifier), ['main']);
  const lore = await storage.deskAssets.listLore('P');
  assert.deepEqual(lore.map((row) => row.id), ['a', 'z']);
  assert.equal(lore[1].position, 'broken');
});

test('getPresetParams: null for missing preset, seeded params for existing, {} default when unseeded', async () => {
  const storage = createMemoryStorage({
    deskPresetIds: ['preset', 'bare'],
    deskPresetParams: { preset: { thinkingTags: ['分镜'] } },
  });
  assert.deepEqual(await storage.deskAssets.getPresetParams('preset'), { thinkingTags: ['分镜'] });
  assert.deepEqual(await storage.deskAssets.getPresetParams('bare'), {});
  assert.equal(await storage.deskAssets.getPresetParams('nope'), null);
});

test('empty regex list falls back to preset+global, only up/both/enabled rules, preset before global', async () => {
  const storage = createMemoryStorage({
    deskPresetIds: ['preset', 'other'],
    deskRegex: [
      { id: 'g-down', find: 'x', flags: '', replace: 'y', direction: 'down', meta: {}, scope: 'global', sortOrder: 0 },
      { id: 'g-off', find: 'x', flags: '', replace: 'y', direction: 'both', meta: {}, scope: 'global', enabled: false, sortOrder: 1 },
      { id: 'g1', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'global', sortOrder: 2 },
      { id: 'p1', find: 'x', flags: '', replace: 'y', direction: 'both', meta: {}, scope: 'preset', presetId: 'preset', sortOrder: 1 },
      { id: 'p0', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'preset', sortOrder: 0 },
      { id: 'other-preset', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'other', sortOrder: 0 },
    ],
  });
  const ids = (await storage.deskAssets.listUpRegexForPreset('preset')).map((row) => row.id);
  assert.deepEqual(ids, ['p0', 'p1', 'g1']);
});

test('same sortOrder ties break by code point order, not locale collation — mixed case and non-ASCII ids stay in D1 binary order', async () => {
  const storage = createMemoryStorage({
    deskPresetIds: ['p'],
    deskRegex: [
      { id: 'a', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'p', sortOrder: 0 },
      { id: 'B', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'p', sortOrder: 0 },
      { id: 'é', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'p', sortOrder: 0 },
      { id: 'z', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'p', sortOrder: 0 },
    ],
  });
  const ids = (await storage.deskAssets.listUpRegexForPreset('p')).map((row) => row.id);
  // Code point order: 'B'(66) < 'a'(97) < 'z'(122) < 'é'(233) — this diverges from default-locale
  // collation (which sorts 'a' before 'B' and folds 'é' next to 'e'), matching SQLite's BINARY
  // default collating sequence that D1's ORDER BY id relies on. Code point order equals UTF-8 byte
  // order for every valid Unicode scalar sequence (see the next test for the case where UTF-16
  // code-unit order — plain JS `<`/`>` — would get this wrong instead).
  assert.deepEqual(ids, ['B', 'a', 'z', 'é']);
});

test('same sortOrder ties: a supplementary-plane id (U+10000) sorts after a private-use-area id (U+E000), matching UTF-8 byte order — not UTF-16 code unit order, which would reverse them', async () => {
  const pua = '\u{E000}'; // BMP private-use character: UTF-16 code unit 0xE000, UTF-8 bytes EE 80 80
  const supplementary = '\u{10000}'; // supplementary-plane character: UTF-16 surrogate pair starting 0xD800, UTF-8 bytes F0 90 80 80
  // Under plain UTF-16 code-unit comparison (JS `<`), the supplementary character's leading
  // surrogate (0xD800) is numerically less than 0xE000, so it would sort BEFORE the PUA character —
  // backwards from both code point order (65536 > 57344) and UTF-8 byte order (F0 > EE).
  const storage = createMemoryStorage({
    deskPresetIds: ['p'],
    deskRegex: [
      { id: supplementary, find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'p', sortOrder: 0 },
      { id: pua, find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'p', sortOrder: 0 },
    ],
  });
  const ids = (await storage.deskAssets.listUpRegexForPreset('p')).map((row) => row.id);
  assert.deepEqual(ids, [pua, supplementary]);
});

test('importPack stamps scope=preset and presetId on its regex rules — a pack default list never leaks another pack\'s rules', async () => {
  const storage = createMemoryStorage({
    deskRegex: [{ id: 'g1', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'global', sortOrder: 0 }],
  });
  await storage.deskAssets.importPack({
    project: 'P', name: 'Pack A',
    recipe: { id: 'recipe-a', presetId: 'preset-a', weight: 'heavy', overrides: {}, regexIds: [], lightSystem: '' },
    blocks: [],
    regex: [{ id: 'a1', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {} }],
  });
  await storage.deskAssets.importPack({
    project: 'P', name: 'Pack B',
    recipe: { id: 'recipe-b', presetId: 'preset-b', weight: 'heavy', overrides: {}, regexIds: [], lightSystem: '' },
    blocks: [],
    regex: [{ id: 'b1', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {} }],
  });
  // regexIds is empty on both recipes, so each preset's default list must only pick up its own
  // pack's rule plus the explicit global one — never the sibling pack's rule.
  assert.deepEqual((await storage.deskAssets.listUpRegexForPreset('preset-a')).map((row) => row.id), ['a1', 'g1']);
  assert.deepEqual((await storage.deskAssets.listUpRegexForPreset('preset-b')).map((row) => row.id), ['b1', 'g1']);
});

test('returns cloned asset values rather than exposing adapter state', async () => {
  const storage = createMemoryStorage({ deskPresetIds: ['p'], deskRecipes: [
    { id: 'r', presetId: 'p', weight: 'heavy', overrides: {}, regexIds: ['x'], lightSystem: '' },
  ] });
  const first = await storage.deskAssets.getRecipe('r');
  first!.regexIds.push('mutated');
  assert.deepEqual((await storage.deskAssets.getRecipe('r'))?.regexIds, ['x']);
});

test('serves desk story state and published chapter hydration from memory', async () => {
  const chapter = (id: string, status: 'draft' | 'published', content = 'body') => ({ id, project: 'P', chapterNo: id,
    title: id, content, summary: '', status, createdAt: '2026-01-01', updatedAt: null, publishedAt: null });
  const storage = createMemoryStorage({ deskState: { 'desk_core:P': 'core' }, chapters: [
    chapter('1', 'published'), chapter('2', 'draft'), chapter('3', 'published', '   '),
  ] });
  assert.equal(await storage.deskStory.getState('desk_core:P'), 'core');
  assert.deepEqual((await storage.deskStory.listPublishedChapters('P')).map((row) => row.id), ['1', '3']);
  assert.deepEqual((await storage.deskStory.getPublishedChapters(['1', '2', '3'], 'P')).map((row) => row.id), ['1']);
});
