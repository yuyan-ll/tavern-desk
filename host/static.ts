// 托管 Next.js 静态导出(upstream/frontend/out/)在 /。
// 只管 GET/HEAD,找得到文件才接手;找不到就返回 false 交给上游路由(API 照上游在 /{AUTH_TOKEN}/api/oc/...)。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync, type Stats } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

function fileAt(path: string): Stats | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

// /study → study.html,/ → index.html,/a/ → a/index.html;路径逃出根目录一律不认。
function locate(root: string, pathname: string): { path: string; stat: Stats } | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  const candidates = decoded.endsWith('/')
    ? [join(target, 'index.html')]
    : [target, `${target}.html`, join(target, 'index.html')];
  for (const path of candidates) {
    const stat = fileAt(path);
    if (stat) return { path, stat };
  }
  return null;
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, frontendDir: string): Promise<boolean> {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const root = resolve(frontendDir);
  const pathname = new URL(req.url || '/', 'http://local').pathname;
  const found = locate(root, pathname);
  if (!found) {
    if (pathname === '/' && !fileAt(join(root, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(method === 'HEAD' ? undefined : '前端还没编:cd upstream/frontend && npm ci && npm run build\n');
      return true;
    }
    return false;
  }
  const type = TYPES[extname(found.path).toLowerCase()] || 'application/octet-stream';
  // /_next/static/ 下的文件名带内容哈希,可以长缓存;HTML 每次都问一下,升级后立刻生效。
  const cache = pathname.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  const etag = `W/"${found.stat.size.toString(16)}-${Math.floor(found.stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cache });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(found.stat.size),
    'cache-control': cache,
    etag,
    'x-content-type-options': 'nosniff',
  });
  if (method === 'HEAD') { res.end(); return true; }
  try {
    await pipeline(createReadStream(found.path), res);
  } catch {
    if (!res.destroyed) res.destroy();
  }
  return true;
}
