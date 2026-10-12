// 打字桌导演小纸条两档位置:纯函数单测 + 一条装配层集成断言。
import test from 'node:test';
import assert from 'node:assert/strict';

import { assembleDesk, resolveNotePos, tailWithNote } from '../src/chat/deskAssemble.ts';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';

test('resolveNotePos: only 0 means "after input"; everything else (old windows 2-10/missing/garbage) falls back to 1', () => {
  assert.equal(resolveNotePos(0), 0);
  assert.equal(resolveNotePos(1), 1);
  // Only a numeric 0 counts — values that would coerce to 0 via Number() (like '0'/''/null) must
  // not silently fall into "after input".
  for (const v of [2, 3, 10, -1, undefined, null, NaN, 'x', '', '0']) {
    assert.equal(resolveNotePos(v as any), 1, String(v));
  }
});

test('tailWithNote: 1 puts the note before the current input, 0 puts it after; an empty note leaves just the input', () => {
  assert.deepEqual(tailWithNote('this turn', 'follow the plot', 1), ['[导演小纸条] follow the plot', 'this turn']);
  assert.deepEqual(tailWithNote('this turn', 'follow the plot', 0), ['this turn', '[导演小纸条] follow the plot']);
  assert.deepEqual(tailWithNote('this turn', '', 1), ['', 'this turn']);
  assert.deepEqual(tailWithNote('', 'follow the plot', 0), ['', '[导演小纸条] follow the plot']);
});

test('assembleDesk: the note lands only immediately before/after the current input, never spliced between floor lines', async () => {
  const storage = createMemoryStorage({
    deskPresetIds: ['preset'],
    deskRecipes: [{ id: 'recipe', presetId: 'preset', weight: 'light', overrides: {}, regexIds: [], lightSystem: '' }],
  });
  const env = { deskAssets: storage.deskAssets, deskStory: storage.deskStory };
  const floors = [
    { role: 'user' as const, content: 'floor A' },
    { role: 'assistant' as const, content: 'floor B' },
  ];

  // Old splice behavior would have put a 2-floor list's depth=1 note *between* floor A and floor
  // B (idx = floorLines.length - depth = 1). The new two-position scheme must never do that.
  const before = await assembleDesk(env, { project: 'P', recipeId: 'recipe', input: 'current input', floors, note: 'director note', noteDepth: 1 });
  assert.equal(before.success, true);
  assert.ok(before.tail.includes('你：floor A\n\n角色：floor B\n\n[导演小纸条] director note\n\ncurrent input'));
  assert.ok(!before.tail.includes('floor A\n\n[导演小纸条]')); // never spliced between the two floor lines

  const after = await assembleDesk(env, { project: 'P', recipeId: 'recipe', input: 'current input', floors, note: 'director note', noteDepth: 0 });
  assert.equal(after.success, true);
  assert.ok(after.tail.includes('你：floor A\n\n角色：floor B\n\ncurrent input\n\n[导演小纸条] director note'));
  assert.ok(!after.tail.includes('floor A\n\n[导演小纸条]'));

  // An old window's stale deep value (e.g. 5) must resolve to "before input", not splice anywhere.
  const oldDeepValue = await assembleDesk(env, { project: 'P', recipeId: 'recipe', input: 'current input', floors, note: 'director note', noteDepth: 5 });
  assert.equal(oldDeepValue.success, true);
  assert.ok(oldDeepValue.tail.includes('你：floor A\n\n角色：floor B\n\n[导演小纸条] director note\n\ncurrent input'));
  assert.ok(!oldDeepValue.tail.includes('floor A\n\n[导演小纸条]'));
});
