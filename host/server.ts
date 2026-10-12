// 打字桌宿主入口:一个 node 进程顶替上游的 Cloudflare Worker。
//
//   node host/server.ts [配置路径]     (缺省 host/config.json)
//
// 做的事:
//   1. 读配置、开 SQLite(套 D1 壳,建库/迁移),拼上游要的 env。
//   2. 起 http(只听 127.0.0.1),每个请求桥成 web Request 交给上游 examples/cloudflare/index.ts
//      的 fetch(request, env, ctx)——路由表一条不改。
//   3. GET/HEAD 先看 upstream/frontend/out/ 里有没有对应的静态文件,有就直接给。
//   4. 收到 SIGINT/SIGTERM:不再接新连接,等 waitUntil 里的活儿(记账、时光带折叠)干完再关库退出。

import './resolve.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openD1, type D1DatabaseShim } from './d1shim.ts';
import { toRequest, writeResponse, requestOrigin, PendingWork } from './bridge.ts';
import { serveStatic } from './static.ts';
import { serveFonts } from './fonts.ts';
import { loadConfig, readApiKey, DEFAULT_CONFIG_PATH, type HostConfig } from './config.ts';
import { MistletoeBackend, anthropicDeskBackend, fakeDeskBackend } from './backend.ts';
import { FixedSegments, assertSegmentProvider, type SegmentProvider } from './segments.ts';
import type { ModelBackend } from '../upstream/src/core/modelBackend.ts';

type Worker = { fetch(request: Request, env: any, ctx: any): Promise<Response> };

const DESK_BODY_MAX = 10 * 1024 * 1024; // 同上游 index.ts 的 DESK_BODY_MAX

export interface DeskHost {
  config: HostConfig;
  db: D1DatabaseShim;
  env: Record<string, unknown>;
  pending: PendingWork;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

async function loadSegments(config: HostConfig): Promise<SegmentProvider | null> {
  if (config.segmentsModule) {
    const mod = await import(pathToFileURL(config.segmentsModule).href);
    return assertSegmentProvider(mod.default, config.segmentsModule);
  }
  if (config.fakeModel) {
    return new FixedSegments([{ text: '(试跑模式垫的段)这是宿主垫在最前面的一段固定文字。', cache: true }]);
  }
  return null;
}

// 聊天口没带 model 时补上 defaultModel(前端总会带,主要照顾 curl / 脚本)。
// 只改这一个口;读 body 也守上游同一个 10MB 上限,超了原样转交让上游报 413。
const CHAT_PATH = /^\/[^/]+\/api\/oc\/desk\/chat$/;
async function withDefaultModel(request: Request, defaultModel: string | undefined): Promise<Request> {
  if (!defaultModel || request.method !== 'POST' || !CHAT_PATH.test(new URL(request.url).pathname)) return request;
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > DESK_BODY_MAX) return request;
  const bytes = new Uint8Array(await request.arrayBuffer());
  let body: BodyInit = bytes;
  if (bytes.byteLength <= DESK_BODY_MAX) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (typeof parsed.model !== 'string' || !parsed.model)) {
        body = JSON.stringify({ ...parsed, model: defaultModel });
      }
    } catch { /* 不是 JSON:原样转交,上游自己报 400 */ }
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}

export async function createDeskHost(config: HostConfig): Promise<DeskHost> {
  const apiKey = readApiKey(config.apiKeyFile);
  if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openD1(config.dbPath, { schemaDir: config.schemaDir });

  const provider = await loadSegments(config);
  let deskBackend: ModelBackend | undefined;
  if (config.fakeModel) deskBackend = new MistletoeBackend(fakeDeskBackend(), provider!);
  else if (provider) deskBackend = new MistletoeBackend(anthropicDeskBackend({ apiKey, baseUrl: config.anthropicBaseUrl }), provider);

  // 上游要的 env。OC_VECTORIZE / AI 不给:语义检索这一期关闭,上游自己报 capability: disabled。
  const env: Record<string, unknown> = {
    OC_DB: db,
    ANTHROPIC_API_KEY: apiKey,
    ...(config.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: config.anthropicBaseUrl } : {}),
    AUTH_TOKEN: config.authToken,
    OWNER_TOKEN: config.ownerToken,
    ...(config.companionToken ? { COMPANION_TOKEN: config.companionToken } : {}),
    COMPANION_COMMENT_WRITE: config.companionCommentWrite ? 'true' : 'false',
    ALLOWED_ORIGINS: config.allowedOrigins.join(','),
    ...(deskBackend ? { DESK_BACKEND: deskBackend } : {}),
  };

  // 上游入口里有不带扩展名的 import,必须等 resolve.ts 的钩子挂上之后再动态加载。
  const worker = (await import('../upstream/examples/cloudflare/index.ts')).default as Worker;
  const pending = new PendingWork();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 本机字体(/fonts/)不经口令:只读、只认一层文件名,见 fonts.ts 头注释
      if (await serveFonts(req, res, config.fontsDir)) return;
      if (await serveStatic(req, res, config.frontendDir)) return;
      const origin = requestOrigin(req);
      // ALLOWED_ORIGINS 没配就是自己的 origin(同源请求本来也不需要 CORS,这里给预检兜个底)。
      const requestEnv = config.allowedOrigins.length ? env : { ...env, ALLOWED_ORIGINS: origin };
      const request = await withDefaultModel(toRequest(req, res, origin), config.defaultModel);
      const response = await worker.fetch(request, requestEnv, pending.context());
      await writeResponse(response, res, request.method);
    } catch (error: any) {
      // 不打请求路径:路径第一段就是口令。
      console.error('[host] 请求处理失败', error?.message || error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      } else if (!res.destroyed) res.destroy();
    }
  }

  async function close(): Promise<void> {
    await pending.settle();
    db.close();
  }

  return { config, db, env, pending, handle, close };
}

async function main(): Promise<void> {
  const configPath = process.argv[2] || DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  const host = await createDeskHost(config);
  if (!existsSync(config.frontendDir)) {
    console.warn(`[host] 没找到前端包 ${config.frontendDir}——先 cd upstream/frontend && npm ci && npm run build;API 照常可用`);
  }
  const server = createServer((req, res) => { void host.handle(req, res); });
  // SSE 一楼可能写好几分钟,别让 node 默认的请求超时把它掐了。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.listen(config.port, '127.0.0.1', () => {
    const mode = config.fakeModel ? '试跑模式(假模型)' : config.segmentsModule ? '注入段已挂' : '直连上游';
    console.log(`[host] 打字桌在 http://127.0.0.1:${config.port}/ 上了 · ${mode} · 库 ${config.dbPath}`);
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[host] 收到 ${signal},不再接新请求,等手头的活儿干完…`);
    server.close();
    server.closeIdleConnections();
    try { await host.close(); } catch (error: any) { console.error('[host] 收尾出错', error?.message || error); }
    console.log('[host] 收好了');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

// 直接 `node host/server.ts` 才起服务;测试 import 它时不起。
const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[host] 起不来:${error?.message || error}`);
    process.exit(1);
  });
}
