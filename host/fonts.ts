// 本机字体目录:宿主把 .woff2 / .woff / .ttf / .otf 放进 host/fonts/(或 config.json 的 fontsDir),
// 这里挂在 /fonts/ 下给页面取;/fonts/index.json 列清单给墙纸面板选(name = 文件名去扩展名,
// file = 文件名)。目录不存在就 404,前端据此显示「宿主没开字体目录」。只认一层文件名,不走子目录,
// 路径里带 / 或 .. 的一律 404——这条路不经口令,所以更不能让它读到目录外。
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export interface FontEntry { name: string; file: string }

export function listFonts(dir: string): FontEntry[] {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => TYPES[extname(f).toLowerCase()] && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ name: basename(f, extname(f)), file: f }));
}

function notFound(res: ServerResponse, head: boolean): void {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(head ? undefined : JSON.stringify({ error: 'not_found' }));
}

// 返回 true 表示这个请求是 /fonts/ 下的、已经答复完了;false 表示不归这里管。
export async function serveFonts(req: IncomingMessage, res: ServerResponse, dir: string): Promise<boolean> {
  const method = (req.method || 'GET').toUpperCase();
  const pathname = new URL(req.url || '/', 'http://local').pathname;
  if (!pathname.startsWith('/fonts/')) return false;
  const head = method === 'HEAD';
  if (method !== 'GET' && !head) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return true; }

  if (pathname === '/fonts/index.json') {
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) { notFound(res, head); return true; }
    const body = JSON.stringify(listFonts(dir));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(body) });
    res.end(head ? undefined : body);
    return true;
  }

  let name: string;
  try { name = decodeURIComponent(pathname.slice('/fonts/'.length)); } catch { notFound(res, head); return true; }
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) { notFound(res, head); return true; }
  const type = TYPES[extname(name).toLowerCase()];
  if (!type || !dir) { notFound(res, head); return true; }
  const root = resolve(dir);
  const file = resolve(root, name);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { notFound(res, head); return true; }
  const size = statSync(file).size;
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'public, max-age=86400' });
  if (head) { res.end(); return true; }
  await new Promise<void>((done) => {
    const stream = createReadStream(file);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); done(); });
    stream.on('end', done);
    stream.pipe(res);
  });
  return true;
}
