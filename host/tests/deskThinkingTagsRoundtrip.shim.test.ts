// 复制自 upstream/tests/deskThinkingTagsRoundtrip.test.ts,只把数据库来源换成 host/d1shim.ts(其余断言一字不改)。
// 预设包"改道思考栏的标签"端到端往返:PATCH 保存 → 导出配方 → 重导入 → 新预设 params.thinkingTags
// 还在。走真实 D1(getPlatformProxy),不是假存根——deskRecipeExport/deskImportPreset 都直接拼 SQL,
// 假 D1 兜不住 JOIN/batch 这类真实查询形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openD1 } from '../d1shim.ts';

test('thinking tags survive PATCH → export → reimport; an invalid extension value is silently dropped, not rejected', { timeout: 30_000 }, async () => {
  // 只换数据库来源:wrangler/miniflare 的 D1 → node:sqlite 上的 D1 形状壳(内存库)。
  const shim = openD1(':memory:');
  try {
    const db = shim as unknown as D1Database;
    await db.batch([
      db.prepare(`CREATE TABLE desk_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', block_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`),
      db.prepare(`CREATE TABLE desk_blocks (id TEXT PRIMARY KEY, preset_id TEXT NOT NULL, identifier TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'system', content TEXT NOT NULL DEFAULT '', marker INTEGER NOT NULL DEFAULT 0, injection TEXT NOT NULL DEFAULT '{}', in_queue INTEGER NOT NULL DEFAULT 0, queue_pos INTEGER, enabled_default INTEGER NOT NULL DEFAULT 0, UNIQUE(preset_id, identifier))`),
      db.prepare(`CREATE TABLE desk_recipes (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, preset_id TEXT NOT NULL, weight TEXT NOT NULL CHECK(weight IN ('light','heavy')), overrides TEXT NOT NULL DEFAULT '{}', regex_ids TEXT NOT NULL DEFAULT '[]', params TEXT NOT NULL DEFAULT '{}', light_system TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT)`),
      db.prepare(`CREATE TABLE desk_regex (id TEXT PRIMARY KEY, scope TEXT NOT NULL, preset_id TEXT, name TEXT NOT NULL DEFAULT '', find TEXT NOT NULL, replace TEXT NOT NULL DEFAULT '', flags TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL CHECK(direction IN ('up','down','both')), enabled INTEGER NOT NULL DEFAULT 1, meta TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0)`),
    ]);

    const { deskImportPreset } = await import('../../upstream/src/tools/desk.ts');
    const { deskPresetUpdate } = await import('../../upstream/src/tools/desk.ts');
    const { deskRecipeCreate, deskRecipeExport } = await import('../../upstream/src/tools/deskRecipes.ts');

    const env: any = { OC_DB: db };
    const rawPreset = { prompts: [{ identifier: 'main', name: 'Main', role: 'system', content: 'Write.' }] };

    // 1) 导第一份预设,PATCH 存 thinking_tags=['分镜']
    const imported = await deskImportPreset(env, rawPreset, 'source-preset');
    assert.equal(imported.success, true);
    const presetId = imported.id;
    const patched = await deskPresetUpdate(env, presetId, { thinking_tags: ['分镜'] });
    assert.equal(patched.success, true);

    // 2) 缝个配方钉在这份预设上,导出
    const recipe = await deskRecipeCreate(env, { name: 'r1', preset_id: presetId, weight: 'light', light_system: 'Continue.' });
    assert.equal(recipe.success, true);
    const exported = await deskRecipeExport(env, recipe.id);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.data.tavern_study_recipe.thinkingTags, ['分镜']);

    // 3) 用导出 JSON 重新导入成一份新预设——新预设的 params.thinkingTags 必须等于 ['分镜']
    const reimported = await deskImportPreset(env, exported.data, 'reimported-preset');
    assert.equal(reimported.success, true);
    assert.notEqual(reimported.id, presetId);
    assert.deepEqual(reimported.params.thinkingTags, ['分镜']);
    const reimportedRow = await db.prepare(`SELECT params FROM desk_presets WHERE id = ?`).bind(reimported.id).first<any>();
    assert.deepEqual(JSON.parse(reimportedRow.params).thinkingTags, ['分镜']);

    // 4) 对照:扩展键里塞非法标签值,重导入既不报错也不写 thinkingTags——静默丢弃,不拒收整包。
    const poisoned = { ...exported.data, tavern_study_recipe: { ...exported.data.tavern_study_recipe, thinkingTags: ['<x>'] } };
    const poisonedImport = await deskImportPreset(env, poisoned, 'poisoned-preset');
    assert.equal(poisonedImport.success, true);
    assert.equal('thinkingTags' in poisonedImport.params, false);
    const poisonedRow = await db.prepare(`SELECT params FROM desk_presets WHERE id = ?`).bind(poisonedImport.id).first<any>();
    assert.equal('thinkingTags' in JSON.parse(poisonedRow.params), false);

    // 5) 另一份对照:预设从未 PATCH 过标签,导出的 tavern_study_recipe 里干脆没有 thinkingTags 键。
    const bareImported = await deskImportPreset(env, rawPreset, 'bare-preset');
    const bareRecipe = await deskRecipeCreate(env, { name: 'r2', preset_id: bareImported.id, weight: 'light', light_system: 'Continue.' });
    const bareExported = await deskRecipeExport(env, bareRecipe.id);
    assert.equal(bareExported.success, true);
    assert.equal('thinkingTags' in bareExported.data.tavern_study_recipe, false);
  } finally {
    shim.close();
  }
});
