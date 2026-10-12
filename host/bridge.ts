// node 的 IncomingMessage ⇄ web 的 Request/Response。
//
//   · 进:方法、头、body 流原样搬进全局 Request;客户端断开 → Request.signal abort
//     (上游 handleDeskChat 靠它判断"人走了",停掉模型流)。
//   · 出:状态、头照抄;body 用 Readable.fromWeb pipe 出去,不攒——SSE 一帧一帧到手机上。
//   · ctx.waitUntil(p):把 Promise 收进一个集合,进程退出前 await 完(记账、时光带折叠都挂在这上面)。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ExecutionContextShim {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: Record<string, unknown>;
}

// waitUntil 收进来的活儿。settle() 等它们全部落地(含排队期间新挂上来的)。
export class PendingWork {
  readonly #pending = new Set<Promise<unknown>>();

  get size(): number {
    return this.#pending.size;
  }

  add(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise).then(
      () => undefined,
      (error) => { console.error('[host] waitUntil 里的任务失败', error); },
    );
    this.#pending.add(tracked);
    tracked.finally(() => this.#pending.delete(tracked));
  }

  async settle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  context(): ExecutionContextShim {
    return {
      waitUntil: (promise) => this.add(promise),
      passThroughOnException: () => {},
      props: {},
    };
  }
}

// 从请求头推出页面看到的 origin。只监听 127.0.0.1,能连进来的只有本机反代,
// 所以 X-Forwarded-Proto / X-Forwarded-Host 可信;没有反代(本机直连)就是 http://host。
export function requestOrigin(req: IncomingMessage): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) || 'http';
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host) || '127.0.0.1';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export function toRequest(req: IncomingMessage, res: ServerResponse, origin = requestOrigin(req)): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith(':') || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  // 客户端提前断开:响应还没写完就关了 → abort。req 的 'close' 在 body 读完时也会触发,不可靠,看 res。
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });

  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal: controller.signal };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(new URL(req.url || '/', origin), init);
}

export async function writeResponse(response: Response, res: ServerResponse, method = 'GET'): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('text/event-stream')) {
    // 反代(nginx 等)别攒 SSE
    headers['x-accel-buffering'] = 'no';
  }
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (contentType.startsWith('text/event-stream')) res.flushHeaders();

  if (!response.body || method === 'HEAD') {
    if (response.body) await response.body.cancel().catch(() => {});
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as any), res);
  } catch (error: any) {
    // 客户端中途走了:pipeline 会把 web 流 cancel 掉,上游 SSE 写手随之看到"人走了"。不是故障。
    if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && error?.name !== 'AbortError') {
      console.error('[host] 写回响应失败', error?.message || error);
    }
    if (!res.destroyed) res.destroy();
  }
}
