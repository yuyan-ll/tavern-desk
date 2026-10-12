export interface ModelUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'usage'; usage: Partial<ModelUsage> }
  | { type: 'ping' };

export interface StreamChatArgs {
  system: Array<{ text: string; cache: boolean }>;
  prompt: string;
  model: string;
  signal?: AbortSignal;
  onEvent?: (event: ModelStreamEvent) => void | Promise<void>;
  // 认领的字面思考标签名单(见 shared/text.ts createLiteralThinkingSplitter);缺省时各后端自行
  // 落回只认字面 <thinking> 的老行为,不是每个 ModelBackend 实现都要支持这个字段。
  thinkingTags?: string[];
}

export type StreamChatResult =
  // Backends may return this variant only after their protocol-specific clean terminal was observed.
  | { ok: true; terminal: 'clean'; text: string; thinking: string; usage: ModelUsage; stopReason?: string }
  | { ok: false; kind: 'config' | 'http' | 'timeout' | 'aborted' | 'protocol' | 'refusal' | 'limit' | 'empty' | 'fetch'; detail?: string; usage?: ModelUsage };

export interface ModelBackend {
  // An aborted request must never resolve to the successful clean-terminal variant.
  streamChat(args: StreamChatArgs): Promise<StreamChatResult>;
}
