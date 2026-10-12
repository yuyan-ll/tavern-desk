// 包一层上游的 ModelBackend:先垫宿主的 system 段,再调原来的后端。
//
// 只管打字桌聊天这一条(上游 desk.ts 的 env.DESK_BACKEND)。时光带折叠和状态板重算走上游固定的
// completeText(src/chat/modelBackend.ts),不经过这里,不垫段。
// 不做 fallback:上游被安全闸停了(refusal)就是停了,那一楼报错、不入账,用户自己重 roll。

import type { ModelBackend, StreamChatArgs, StreamChatResult } from '../upstream/src/core/modelBackend.ts';
import { AnthropicStreamBackend } from '../upstream/src/adapters/streamModelBackends.ts';
import { FakeModelBackend } from '../upstream/src/adapters/fakeModelBackend.ts';
import { normalizeSegments, type SegmentProvider } from './segments.ts';

// 跟上游 src/chat/desk.ts 的 USER_ID 同值(那边没导出),注入后记账口径不变。
const DESK_USER_ID = 'tavern-study-desk';

export class MistletoeBackend implements ModelBackend {
  readonly inner: ModelBackend;
  readonly provider: SegmentProvider;

  constructor(inner: ModelBackend, provider: SegmentProvider) {
    this.inner = inner;
    this.provider = provider;
  }

  async streamChat(args: StreamChatArgs): Promise<StreamChatResult> {
    let segments;
    try {
      segments = normalizeSegments(await this.provider.segments({ model: args.model }));
    } catch (error: any) {
      // 段取不到就不发这一楼:宁可报错让她重试,也不悄悄少垫段发出去。
      console.error('[host] 取注入段失败,这一楼不发', error?.message || error);
      return { ok: false, kind: 'config', detail: 'segments' };
    }
    // thinkingTags、signal、onEvent、prompt、model 原样透传,只动 system。
    return this.inner.streamChat({ ...args, system: [...segments, ...args.system] });
  }
}

export function anthropicDeskBackend(options: { apiKey: string; baseUrl?: string }): ModelBackend {
  return new AnthropicStreamBackend({ apiKey: options.apiKey, baseUrl: options.baseUrl, userId: DESK_USER_ID });
}

// 试跑模式(config.fakeModel = true)用:不连网,每楼回同一段话,SSE 照常有 text/usage/done。
export function fakeDeskBackend(): FakeModelBackend {
  const chunks = ['(试跑模式)', '桌上那盏灯亮了一下,', '纸页翻过去一页。'];
  const text = chunks.join('');
  return new FakeModelBackend(
    { ok: true, terminal: 'clean', text, thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'end_turn' },
    [...chunks.map((c) => ({ type: 'text' as const, text: c })), { type: 'usage' as const, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }],
  );
}
