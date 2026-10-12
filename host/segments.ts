// 注入段的接口 + 一份假实现。
//
// 宿主方的真实现另写成 segments.home.mjs(不入仓),export default 一个 SegmentProvider,
// 在 config.json 里用 segmentsModule 指过去;这里只定合同和测试/试跑用的 FixedSegments。

export interface SystemSegment {
  text: string;
  cache: boolean;
}

export interface SegmentProvider {
  // 每楼生成前调一次。返回的段会原样垫在上游 system 段数组的最前面,顺序保留。
  segments(ctx: { model: string }): Promise<Array<{ text: string; cache: boolean }>>;
}

// 给定几段固定文字,每楼原样返回(复制一份,调用方改了也不串)。
export class FixedSegments implements SegmentProvider {
  readonly #segments: SystemSegment[];

  constructor(segments: Array<SystemSegment | string>) {
    this.#segments = segments.map((s) => (typeof s === 'string' ? { text: s, cache: true } : { text: String(s.text), cache: !!s.cache }));
  }

  async segments(_ctx: { model: string }): Promise<SystemSegment[]> {
    return this.#segments.map((s) => ({ ...s }));
  }
}

// 校验宿主方模块导出的东西长得像 SegmentProvider;不像就当场报错,不等到第一楼才炸。
export function assertSegmentProvider(value: unknown, from: string): SegmentProvider {
  if (!value || typeof (value as SegmentProvider).segments !== 'function') {
    throw new Error(`${from} 的 default export 不是 SegmentProvider(要有 segments(ctx) 方法)`);
  }
  return value as SegmentProvider;
}

// segments() 的返回值过一道形状闸:必须是 {text: string, cache: boolean} 数组,空文字的段丢掉
// (Anthropic 不收空 text 块)。
export function normalizeSegments(value: unknown): SystemSegment[] {
  if (!Array.isArray(value)) throw new Error('SegmentProvider.segments() 必须返回数组');
  return value.map((s, i) => {
    if (!s || typeof s !== 'object' || typeof (s as SystemSegment).text !== 'string') {
      throw new Error(`SegmentProvider.segments() 第 ${i + 1} 段不是 {text, cache}`);
    }
    return { text: (s as SystemSegment).text, cache: (s as SystemSegment).cache === true };
  }).filter((s) => s.text.trim());
}
