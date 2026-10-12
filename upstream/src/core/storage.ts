import type { Chapter, ChapterComment, CommentAuthor, DeskFloor, DeskLore, DeskPromptBlock, DeskRecipe, DeskRegex, DeskWindow, StudyEntry } from './types.ts';

export interface StudyListQuery {
  project?: string;
  category?: StudyEntry['category'];
  keyword?: string;
  tag?: string;
}

export interface StudyStats {
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  total: number;
}

export interface StudyStorage {
  listEntries(query: StudyListQuery): Promise<StudyEntry[]>;
  getEntry(id: string): Promise<StudyEntry | null>;
  createEntry(entry: StudyEntry): Promise<void>;
  updateEntry(id: string, patch: Partial<Omit<StudyEntry, 'id' | 'createdAt'>>): Promise<StudyEntry | null>;
  deleteEntry(id: string): Promise<boolean>;
  stats(): Promise<StudyStats>;
}

export interface ReadingStorage {
  createChapter(chapter: Chapter): Promise<void>;
  getChapter(id: string): Promise<Chapter | null>;
  publishChapter(id: string, publishedAt: string): Promise<Chapter | null>;
  listPublishedChapters(project?: string): Promise<Array<Chapter & { commentCount: number }>>;
  getPublishedChapter(id: string): Promise<Chapter | null>;
  listPublishedComments(chapterId: string, limit: number): Promise<ChapterComment[] | null>;
  createPublishedComment(input: {
    id: string;
    chapterId: string;
    replyTo: string | null;
    author: CommentAuthor;
    content: string;
    createdAt: string;
  }): Promise<ChapterComment | null>;
}

export interface DeskStorage {
  listWindows(project?: string): Promise<DeskWindow[]>;
  getWindow(id: string): Promise<DeskWindow | null>;
  createWindow(window: DeskWindow): Promise<void>;
  updateWindow(id: string, patch: Partial<Omit<DeskWindow, 'id' | 'createdAt'>>): Promise<DeskWindow | null>;
  updateTimelineState(id: string, expectedUpdatedAt: string, timelineState: Record<string, unknown>, updatedAt: string): Promise<DeskWindow | null>;
  deleteWindow(id: string): Promise<boolean>;
  listFloors(windowId: string): Promise<DeskFloor[]>;
  getFloor(id: string): Promise<DeskFloor | null>;
  createFloor(floor: DeskFloor): Promise<void>;
  updateFloor(id: string, patch: Partial<Omit<DeskFloor, 'id' | 'windowId' | 'createdAt'>>): Promise<DeskFloor | null>;
  truncateFloors(windowId: string, anchorId: string, inclusive: boolean): Promise<number | null>;
}

export interface DeskAssetStorage {
  getRecipe(id: string): Promise<DeskRecipe | null>;
  hasPreset(id: string): Promise<boolean>;
  // 预设包的 params 快照:null=预设包不存在,否则原样返回该列的值(JSON 字符串或已解析对象,
  // 由各实现自行决定;读取方——见 chat/deskAssemble.ts——两种形状都认)。装配要跟本轮用的是
  // 同一份快照,所以跟 getRecipe 分开单独查一次,不从 hasPreset 顺带返回。
  getPresetParams(id: string): Promise<unknown>;
  listRegex(ids: string[]): Promise<DeskRegex[]>;
  // 配方名单为空时的默认上行正则:本预设包 + 全局的、开着的 up/both 规则,预设优先于全局。
  listUpRegexForPreset(presetId: string): Promise<DeskRegex[]>;
  listQueueBlocks(presetId: string): Promise<DeskPromptBlock[]>;
  listLore(project: string): Promise<DeskLore[]>;
  importPack(pack: DeskAssetPack): Promise<void>;
}

export interface DeskAssetPack {
  project: string;
  name: string;
  recipe: DeskRecipe;
  blocks: DeskPromptBlock[];
  regex: DeskRegex[];
}

export interface DeskStoryStorage {
  getState(key: string): Promise<string | null>;
  listPublishedChapters(project: string): Promise<Chapter[]>;
  getPublishedChapters(ids: string[], project: string): Promise<Chapter[]>;
}

export interface DeskTurnCommit {
  content: string;
  thinking: string | null;
  report: Record<string, unknown>;
  stateBoard: Record<string, unknown>;
  committedAt: string;
}

// 状态板 stale 自动补算的落库四证:板字节未变 + 窗口 updated_at 未变 + 本楼仍是该窗最新一楼(用
// 楼层原始 createdAt 卡"更晚"的边界) + 楼层 content/commitToken 未变。任一不成立整体放弃,板沿旧。
export interface DeskAutoRefreshBoardInput {
  windowId: string;
  floorId: string;
  expectedWindowStateBoard: Record<string, unknown>;
  expectedWindowUpdatedAt: string;
  expectedFloorCreatedAt: string;
  expectedFloorContent: string;
  expectedFloorCommitToken: string;
  nextBoard: Record<string, unknown>;
  nextFloorReport: Record<string, unknown>;
  refreshedAt: string;
}

export type DeskAutoRefreshBoardResult = { ok: true } | { ok: false; reason: string };

export interface DeskTurnStorage {
  commitAssistantFloor(windowId: string, floorId: string, commit: DeskTurnCommit): Promise<DeskFloor | null>;
  rollAssistantFloor(input: {
    windowId: string;
    floorId: string;
    expected: Pick<DeskFloor, 'content' | 'variants' | 'activeVariant' | 'thinking' | 'report'>;
    commit: DeskTurnCommit;
  }): Promise<DeskFloor | null>;
  autoRefreshBoard(input: DeskAutoRefreshBoardInput): Promise<DeskAutoRefreshBoardResult>;
}

export interface StorageAdapter {
  reading: ReadingStorage;
  study: StudyStorage;
  desk: DeskStorage;
  deskAssets: DeskAssetStorage;
  deskStory: DeskStoryStorage;
  deskTurn: DeskTurnStorage;
}

export interface SemanticDocument {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

export interface SemanticHit {
  id: string;
  score: number;
}

export interface SemanticSearchAdapter {
  upsert(document: SemanticDocument): Promise<void>;
  delete(id: string): Promise<void>;
  search(query: string, options: { limit: number; filter?: Record<string, string> }): Promise<SemanticHit[]>;
}
