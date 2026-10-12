// 桌边话:作者在写作桌边上跟模型说的场外话(讨论剧情、提意见、问问题),不是小说正文。
//
// 判据:用户那一楼的正文去掉首尾空白后以「桌边」两个字开头,且后面跟着冒号、逗号、空白或换行(或者整楼只有这两个字),
// 这一楼就是桌边话;直接接正文的(「桌边的烛火晃了一下」)是戏,不算;回应它的那一楼也算。chat/desk.ts 存楼时在 report 里记 aside: true(report 是
// 现成的自由 JSON 列,不加表字段),之后各处只认这个标记,不再按正文重判——楼层被手改也不翻案。
//
// 桌边楼照常进近景(模型得知道刚才说了什么,说话人前缀后面加「(桌边)」),但不进时光带、
// 不进状态板、导出正文时默认不收。

export const DESK_ASIDE_PREFIX = '桌边';
// 「桌边」之后:结尾 / 空白(含换行)/ 半角或全角的冒号、逗号。
const DESK_ASIDE_RE = /^桌边(?:$|[\s:：,，])/;

export function isDeskAsideMessage(text: unknown): boolean {
  return typeof text === 'string' && DESK_ASIDE_RE.test(text.trim());
}

// report 可能是适配器已经解析好的对象,也可能是直接查 D1 拿到的 JSON 文本;坏 JSON 当不是。
export function isDeskAsideReport(report: unknown): boolean {
  let value = report;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return false; }
  }
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).aside === true;
}

export function isDeskAsideFloor(floor: { report?: unknown } | null | undefined): boolean {
  return !!floor && isDeskAsideReport(floor.report);
}
