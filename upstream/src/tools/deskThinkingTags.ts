// src/tools/deskThinkingTags.ts
// 打字桌预设级思考栏标签名单：校验(保存写路径)+ 容错读取(生成读路径)两套函数各管各的严格度。

export const DEFAULT_THINKING_TAGS = ['thinking'];

export const THINKING_TAG_RE = /^[A-Za-z0-9_\-一-龥]{1,32}$/;

const RESERVED_TAGS = new Set(['content', 'stateboard', 'details', 'summary']);

const MAX_TAGS = 8;

export function validateThinkingTags(input: unknown): { ok: true; tags: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'thinking_tags 必须是数组' };
  const out: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (typeof item !== 'string') return { ok: false, error: `第${i + 1}项不是字符串` };
    const trimmed = item.trim();
    if (!trimmed) return { ok: false, error: `第${i + 1}项是空白` }; // 保存路不吞空白项,免得误输入把已有配置清空
    if (!THINKING_TAG_RE.test(trimmed)) return { ok: false, error: `第${i + 1}项「${trimmed}」不是合法标签名` };
    if (RESERVED_TAGS.has(trimmed.toLowerCase())) return { ok: false, error: `第${i + 1}项「${trimmed}」是保留名,不能用` };
    if (!out.includes(trimmed)) out.push(trimmed); // 精确字符串去重
  }
  if (out.length > MAX_TAGS) return { ok: false, error: `最多 ${MAX_TAGS} 个标签` };
  return { ok: true, tags: out };
}

// 生成读路径容错读取：非法项静默丢弃,不阻断生成——校验的严格性只在保存那一刀,读的时候只取干净部分。
export function readThinkingTags(paramsRaw: unknown): string[] {
  let params: any = paramsRaw;
  if (typeof params === 'string') {
    try { params = JSON.parse(params); } catch { return []; }
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  const raw = (params as any).thinkingTags;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!THINKING_TAG_RE.test(trimmed)) continue;
    if (RESERVED_TAGS.has(trimmed.toLowerCase())) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// 生成实际喂给分流器的标签名单：隐含 thinking 恒在第一位,用户名单去重后追加。
export function effectiveThinkingTags(paramsRaw: unknown): string[] {
  return ['thinking', ...readThinkingTags(paramsRaw).filter((t) => t !== 'thinking')];
}
