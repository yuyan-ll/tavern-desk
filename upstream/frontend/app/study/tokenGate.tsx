'use client';

// 自托管口令门(tavern-desk 用):NEXT_PUBLIC_WORKER_URL / NEXT_PUBLIC_AUTH_TOKEN 都没配时,
// 地址不编进包里——取页面自己的 origin(书房和 API 由同一个宿主进程托管);口令第一次打开时输入一次,
// 存在这台设备的浏览器里(localStorage['tavern-desk.token']),刷新即用。左廊「换口令」把它清掉。
//
// 静态导出的首屏是预渲染的,那时没有 window——origin 和口令都走 useSyncExternalStore,服务端快照是
// "还不知道",水合之后才取到真值;取到之前只显示等待。
// 口令先拿 GET /{口令}/api/oc/stats 验一下再存:401 就是不对,当场说;存着的口令后来失效(宿主换了口令)
// 也是同一道验,失效就清掉回到输入页。

import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';

export const DESK_TOKEN_KEY = 'tavern-desk.token';

type Check = 'ok' | 'bad' | 'offline';

async function checkToken(origin: string, token: string): Promise<Check> {
  try {
    const res = await fetch(`${origin}/${encodeURIComponent(token)}/api/oc/stats`, { cache: 'no-store' });
    if (res.status === 401) return 'bad';
    return res.ok ? 'ok' : 'offline';
  } catch {
    return 'offline';
  }
}

// ── 口令存储:localStorage + 本页内的变更通知(别的标签页改了走 storage 事件)──
const listeners = new Set<() => void>();
function subscribeToken(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => { listeners.delete(onChange); window.removeEventListener('storage', onChange); };
}
function readSaved(): string {
  try { return localStorage.getItem(DESK_TOKEN_KEY) || ''; } catch { return memoryToken; }
}
let memoryToken = ''; // localStorage 不可用(隐私模式等)时,只在这一次打开里有效
function writeSaved(token: string) {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(DESK_TOKEN_KEY, token);
    else localStorage.removeItem(DESK_TOKEN_KEY);
  } catch { /* 见 memoryToken */ }
  for (const l of listeners) l();
}
const noopSubscribe = () => () => {};

const shellStyle: React.CSSProperties = {
  minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24, boxSizing: 'border-box', background: 'var(--page-bg)', fontFamily: 'var(--font-sans)',
};

export function DeskTokenGate({ children }: { children: (origin: string, token: string, forget: () => void) => ReactNode }) {
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => null);
  const saved = useSyncExternalStore(subscribeToken, readSaved, () => null);
  const [draft, setDraft] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  // 存着的口令后台验一下;断网不算失效(手机进电梯也照样能先看到页面),只有 401 才清。
  useEffect(() => {
    if (!origin || !saved) return;
    let alive = true;
    checkToken(origin, saved).then((r) => {
      if (!alive || r !== 'bad') return;
      setError('口令变了,重新输入一次');
      writeSaved('');
    });
    return () => { alive = false; };
  }, [origin, saved]);

  const forget = useCallback(() => { setDraft(''); setError(''); writeSaved(''); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const token = draft.trim();
    if (!origin || !token || checking) return;
    setChecking(true);
    const r = await checkToken(origin, token);
    setChecking(false);
    if (r === 'ok') { setDraft(''); setError(''); writeSaved(token); }
    else setError(r === 'bad' ? '口令不对' : '连不上书房,检查一下网络或地址');
  }

  if (origin === null || saved === null) {
    return (
      <div style={shellStyle}>
        <div className="serc" style={{ color: 'var(--ink2)', fontSize: 14 }}>正在打开书房…</div>
      </div>
    );
  }

  if (saved) return <>{children(origin, encodeURIComponent(saved), forget)}</>;

  return (
    <div style={shellStyle}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label htmlFor="desk-token" className="serc" style={{ fontSize: 22, color: 'var(--ink-deep)', textAlign: 'center' }}>输入口令</label>
        <input
          id="desk-token"
          type="password"
          autoFocus
          autoComplete="current-password"
          enterKeyHint="go"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={checking}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 16,
            borderRadius: 12, border: '1px solid var(--line-soft)', background: 'var(--card-bg)', color: 'var(--ink-deep)',
          }}
        />
        <button
          type="submit"
          className="serc"
          disabled={checking || !draft.trim()}
          style={{
            padding: '11px 14px', fontSize: 15, borderRadius: 12, border: 0, cursor: 'pointer',
            background: 'var(--accent)', color: 'var(--card-bg)', opacity: checking || !draft.trim() ? 0.5 : 1,
          }}
        >
          {checking ? '核对中…' : '进书房'}
        </button>
        <div role="alert" style={{ minHeight: 20, fontSize: 13, color: 'var(--ink2)', textAlign: 'center' }}>{error}</div>
      </form>
    </div>
  );
}
