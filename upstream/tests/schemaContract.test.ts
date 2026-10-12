import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const wrangler = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');

function runWrangler(args: string[], persistTo: string, configHome: string) {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--local', '--config', 'wrangler.test.toml', '--persist-to', persistTo], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

// Same spawn as runWrangler, but for a read-only `d1 execute --json --command` query whose parsed
// `results` array the caller wants back (schema introspection via PRAGMA, not applying migrations).
function runWranglerQuery(sql: string, persistTo: string, configHome: string): any[] {
  const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'OC_DB', '--json', '--command', sql, '--local', '--config', 'wrangler.test.toml', '--persist-to', persistTo], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  return parsed[0]?.results ?? [];
}

const byName = (a: any, b: any) => String(a.name).localeCompare(String(b.name));

test('schema init.sql, a from-scratch migration run, and an init.sql database that later runs migrations apply all agree on desk_windows shape', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-study-schema-'));
  try {
    const [init, migration] = await Promise.all([
      readFile('examples/cloudflare/schema/init.sql', 'utf8'),
      readFile('examples/cloudflare/schema/migrations/0001_initial.sql', 'utf8'),
    ]);
    // note_depth's column default is the one intentional divergence between the two files:
    // init.sql carries the corrected DEFAULT 1 (the current "latest schema"), while
    // 0001_initial.sql stays frozen at its originally-published DEFAULT 3 — wrangler only replays
    // migrations by filename against a database's bookkeeping table, it never rewrites or re-runs
    // an already-applied migration, so editing 0001 in place would silently diverge any database
    // that already ran it from any freshly-installed one. migrations/0002_desk_note_two_state.sql
    // fixes the default in place (table rebuild) for databases that already ran 0001. Every other
    // line must still match byte-for-byte (both files are otherwise idempotent: CREATE TABLE/INDEX/
    // TRIGGER IF NOT EXISTS + INSERT OR IGNORE, see the third path below for why that matters).
    // Second intentional divergence: init.sql is a snapshot of the post-0002 schema, so it also
    // records schema_versions(2); 0001 only records version 1 (0002 adds its own row when it runs).
    const normalize = (sql: string) => sql.replaceAll('\r\n', '\n')
      .replace('note_depth INTEGER NOT NULL DEFAULT 1', 'note_depth INTEGER NOT NULL DEFAULT __N__')
      .replace('note_depth INTEGER NOT NULL DEFAULT 3', 'note_depth INTEGER NOT NULL DEFAULT __N__')
      .replace('INSERT OR IGNORE INTO schema_versions(version) VALUES (2);\n', '');
    assert.equal(normalize(init), normalize(migration));

    const initDir = join(root, 'init'); const initConfig = join(root, 'config-init');
    const migDir = join(root, 'migration'); const migConfig = join(root, 'config-migration');
    const upgradeDir = join(root, 'init-then-migrate'); const upgradeConfig = join(root, 'config-init-then-migrate');

    // Path A: fresh install via init.sql, never touches the migrations ledger.
    runWrangler(['d1', 'execute', 'OC_DB', '--file', 'examples/cloudflare/schema/init.sql'], initDir, initConfig);

    // Path B: applying every pending migration against an empty database runs 0001 then 0002 in
    // order — the ledger-tracked equivalent of "a database that started on 0001's DEFAULT 3 and
    // later picks up 0002".
    runWrangler(['d1', 'migrations', 'apply', 'OC_DB'], migDir, migConfig);

    // Path C: the real-world upgrade path README/docs/wiring.md tell init.sql users to take.
    // A database built straight from init.sql has zero rows in wrangler's migrations ledger, so
    // `migrations apply` sees NO migration as applied yet and tries to replay 0001 from scratch
    // against a database that already has every table/index/trigger 0001 would create. Before 0001
    // became idempotent this failed outright (`table already exists`, non-zero exit — runWrangler
    // would have thrown here) and 0002 could never run, permanently stranding init.sql-built
    // databases on the old note_depth default. It must now succeed end to end.
    runWrangler(['d1', 'execute', 'OC_DB', '--file', 'examples/cloudflare/schema/init.sql'], upgradeDir, upgradeConfig);
    runWrangler(['d1', 'migrations', 'apply', 'OC_DB'], upgradeDir, upgradeConfig);

    const initColumns = runWranglerQuery('PRAGMA table_info(desk_windows)', initDir, initConfig);
    const migColumns = runWranglerQuery('PRAGMA table_info(desk_windows)', migDir, migConfig);
    const upgradeColumns = runWranglerQuery('PRAGMA table_info(desk_windows)', upgradeDir, upgradeConfig);
    const dfltOf = (columns: any[]) => columns.find((c: any) => c.name === 'note_depth')?.dflt_value;
    assert.equal(dfltOf(initColumns), '1', 'fresh-install desk_windows.note_depth default must be 1');
    assert.equal(dfltOf(migColumns), '1', 'migrated-from-scratch desk_windows.note_depth default must be 1 after 0002');
    assert.equal(dfltOf(upgradeColumns), '1', 'init.sql database that later runs migrations apply must show note_depth default 1 after 0002 actually ran');
    const sortedColumns = (columns: any[]) => [...columns].sort(byName);
    assert.deepEqual(sortedColumns(initColumns), sortedColumns(migColumns), 'desk_windows column set must match between path A and path B');
    assert.deepEqual(sortedColumns(initColumns), sortedColumns(upgradeColumns), 'desk_windows column set must match between path A and path C');

    const indexesOf = (dir: string, config: string) => runWranglerQuery('PRAGMA index_list(desk_windows)', dir, config)
      .map((row: any) => ({ name: row.name, unique: row.unique })).sort(byName);
    const initIndexes = indexesOf(initDir, initConfig);
    const migIndexes = indexesOf(migDir, migConfig);
    const upgradeIndexes = indexesOf(upgradeDir, upgradeConfig);
    assert.deepEqual(initIndexes, migIndexes, 'desk_windows index set must match between path A and path B');
    assert.deepEqual(initIndexes, upgradeIndexes, 'desk_windows index set must match between path A and path C');

    // schema_versions must have exactly one row per version — 0001's INSERT OR IGNORE means
    // replaying it against an init.sql database (which already inserted version 1 itself) does not
    // produce a duplicate, and 0002 must have actually run (not just been skipped) to add version 2.
    // A fresh init.sql install is a snapshot of the post-0002 schema and must advertise the same
    // history, otherwise operators reading schema_versions would think it still needs 0002.
    const versionsOf = (dir: string, config: string) => runWranglerQuery('SELECT version FROM schema_versions ORDER BY version', dir, config).map((row: any) => row.version);
    assert.deepEqual(versionsOf(initDir, initConfig), [1, 2]);
    assert.deepEqual(versionsOf(upgradeDir, upgradeConfig), [1, 2]);
    assert.deepEqual(versionsOf(migDir, migConfig), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
