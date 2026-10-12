-- 导演小纸条位置收窄成两档(1=本楼输入之前,0=之后,见 src/chat/deskAssemble.ts resolveNotePos)。
-- SQLite 不支持 ALTER COLUMN 改默认值,按标准姿势整表重建:新表(note_depth 默认值改 1)→
-- 搬数据(顺手把 note_depth 归一成 0/1 两档)→删旧表→改名→重建原表上的全部索引。
BEGIN TRANSACTION;

CREATE TABLE desk_windows_new (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', recipe_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', note_depth INTEGER NOT NULL DEFAULT 1, state_board TEXT NOT NULL DEFAULT '{}', timeline_state TEXT NOT NULL DEFAULT '{}', vars TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT);

INSERT INTO desk_windows_new (id, project, title, recipe_id, note, note_depth, state_board, timeline_state, vars, created_at, updated_at)
  SELECT id, project, title, recipe_id, note, CASE WHEN note_depth = 0 THEN 0 ELSE 1 END, state_board, timeline_state, vars, created_at, updated_at
  FROM desk_windows;

DROP TABLE desk_windows;

ALTER TABLE desk_windows_new RENAME TO desk_windows;

CREATE INDEX desk_windows_project ON desk_windows(project);

INSERT OR IGNORE INTO schema_versions(version) VALUES (2);

COMMIT;
