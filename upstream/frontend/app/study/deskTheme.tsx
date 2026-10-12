'use client';
// 墙纸、玻璃、正文字体——本机偏好,存在这台设备的浏览器里(localStorage['tavern-desk.skin']),
// 跟口令同一个地方,刷新即用。四套墙纸的变量在 globals.css;layout.tsx 里有一段开机脚本先把
// 存的选择写到 <html> 上,首屏不闪白——那段脚本和这里的 applySkin 是同一套逻辑,改一处记得改另一处。
// 本机字体:宿主把字体文件放在 host/fonts/,/fonts/index.json 列出来,这里拉清单让人选;选中的那款
// 用 @font-face 挂成 "desk-reading",正文通过 --font-reading-user 用它(见 globals.css 注释)。
import { useEffect, useState } from 'react';

export const SKIN_KEY = 'tavern-desk.skin';
export type ThemeId = 'sage' | 'ink' | 'rice' | 'bronze';
export type SkinFont = { name: string; file: string };
export type Skin = { theme?: ThemeId | 'auto'; day?: ThemeId; night?: ThemeId; glass?: boolean; font?: SkinFont | null };

export const THEMES: { id: ThemeId; name: string; night: boolean }[] = [
  { id: 'sage', name: '纸绿', night: false },
  { id: 'rice', name: '米纸', night: false },
  { id: 'ink', name: '墨夜', night: true },
  { id: 'bronze', name: '乌金', night: true },
];
const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));

export function readSkin(): Skin {
  try {
    const raw = JSON.parse(localStorage.getItem(SKIN_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
export function writeSkin(s: Skin): void {
  try { localStorage.setItem(SKIN_KEY, JSON.stringify(s)); } catch { /* 隐私模式等:只在这一次打开里有效 */ }
}

function pick(id: unknown, fallback: ThemeId): ThemeId {
  return typeof id === 'string' && THEME_IDS.has(id) ? (id as ThemeId) : fallback;
}
export function resolveTheme(s: Skin): ThemeId {
  if (s.theme === 'auto') {
    const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? pick(s.night, 'ink') : pick(s.day, 'sage');
  }
  return pick(s.theme, 'sage');
}

const FONT_STYLE_ID = 'desk-reading-font';
export function applySkin(s: Skin): void {
  if (typeof document === 'undefined') return;
  const d = document.documentElement;
  d.dataset.theme = resolveTheme(s);
  if (s.glass) d.dataset.glass = '1'; else delete d.dataset.glass;
  let st = document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null;
  if (s.font && s.font.file) {
    if (!st) { st = document.createElement('style'); st.id = FONT_STYLE_ID; document.head.appendChild(st); }
    st.textContent = `@font-face{font-family:"desk-reading";src:url("/fonts/${encodeURIComponent(s.font.file)}");font-display:swap}`;
    d.style.setProperty('--font-reading-user', '"desk-reading"');
  } else {
    st?.remove();
    d.style.removeProperty('--font-reading-user');
  }
  // 浏览器/壳的状态栏颜色跟着底色走
  const bg = getComputedStyle(d).getPropertyValue('--page-bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}

// 挂在书房根组件上:挂载时按存的选择刷一遍(开机脚本没跑到的情况兜底),跟随系统时系统切明暗就跟着换。
export function useSkinBoot(): void {
  useEffect(() => {
    applySkin(readSkin());
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { const s = readSkin(); if (s.theme === 'auto') applySkin(s); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
}

// ── 面板 ──
const pill = (active: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--line-soft)'}`,
  background: active ? 'var(--accent)' : 'var(--card-bg)',
  color: active ? 'var(--on-accent)' : 'var(--ink-body)',
});
const label: React.CSSProperties = { fontSize: 12, color: 'var(--ink2)', marginBottom: 8, letterSpacing: 1 };
const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 };

export function SkinPanel({ open, onClose, onForgetToken }: { open: boolean; onClose: () => void; onForgetToken?: () => void }) {
  const [skin, setSkin] = useState<Skin>({});
  const [fonts, setFonts] = useState<SkinFont[] | null>(null); // null=还没拉到/宿主没有字体目录
  const [fontsNote, setFontsNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setSkin(readSkin());
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/fonts/index.json', { cache: 'no-cache' });
        if (!res.ok) { if (!cancelled) { setFonts(null); setFontsNote(res.status === 404 ? '宿主没开字体目录' : `字体清单拉不到(${res.status})`); } return; }
        const data = await res.json();
        const list: SkinFont[] = Array.isArray(data) ? data.filter((x: any) => x && typeof x.name === 'string' && typeof x.file === 'string') : [];
        if (!cancelled) { setFonts(list); setFontsNote(list.length ? '' : '字体目录是空的:把 .woff2/.ttf 放进宿主的 host/fonts/ 就有了'); }
      } catch {
        if (!cancelled) { setFonts(null); setFontsNote('字体清单拉不到'); }
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;
  const update = (patch: Partial<Skin>) => {
    const next = { ...skin, ...patch };
    setSkin(next); writeSkin(next); applySkin(next);
  };
  const auto = skin.theme === 'auto';
  const current = resolveTheme(skin);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} role="dialog" aria-label="墙纸">
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: `rgba(var(--scrim-rgb), 0.55)` }} />
      <div className="card" style={{ position: 'relative', width: '100%', maxWidth: 440, margin: '0 10px calc(10px + var(--safe-bottom, env(safe-area-inset-bottom, 0px)))', background: 'var(--card-bg)', border: '1px solid var(--line-soft)', borderRadius: 22, padding: '18px 18px 16px', boxShadow: '0 16px 48px var(--card-shadow2)', maxHeight: '82vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="serc" style={{ fontSize: 18, color: 'var(--ink-deep)' }}>墙纸</div>
          <button type="button" onClick={onClose} className="serc" style={{ ...pill(false), padding: '5px 12px' }}>关</button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={label}>墙纸</div>
          <div style={row}>
            {THEMES.map((t) => (
              <button key={t.id} type="button" className="serc" style={pill(!auto && current === t.id)} onClick={() => update({ theme: t.id })}>{t.name}</button>
            ))}
            <button type="button" className="serc" style={pill(auto)} onClick={() => update({ theme: 'auto', day: pick(skin.day, 'sage'), night: pick(skin.night, 'ink') })}>跟随系统</button>
          </div>
          {auto && (
            <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--ink2)', width: 36 }}>白天</span>
                {THEMES.filter((t) => !t.night).map((t) => (
                  <button key={t.id} type="button" className="serc" style={pill(pick(skin.day, 'sage') === t.id)} onClick={() => update({ day: t.id })}>{t.name}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--ink2)', width: 36 }}>夜里</span>
                {THEMES.filter((t) => t.night).map((t) => (
                  <button key={t.id} type="button" className="serc" style={pill(pick(skin.night, 'ink') === t.id)} onClick={() => update({ night: t.id })}>{t.name}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={label}>玻璃</div>
          <div style={row}>
            <button type="button" className="serc" style={pill(!skin.glass)} onClick={() => update({ glass: false })}>关</button>
            <button type="button" className="serc" style={pill(!!skin.glass)} onClick={() => update({ glass: true })}>开</button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginTop: 6, lineHeight: 1.5 }}>顶栏、输入区、底栏做成浮着的磨砂玻璃。滑起来发涩就关掉。</div>
        </div>

        <div style={{ marginBottom: onForgetToken ? 16 : 0 }}>
          <div style={label}>正文字体</div>
          <div style={row}>
            <button type="button" className="serc" style={pill(!skin.font)} onClick={() => update({ font: null })}>跟随主题</button>
            {(fonts || []).map((f) => (
              <button key={f.file} type="button" className="serc" style={pill(skin.font?.file === f.file)} onClick={() => update({ font: f })}>{f.name}</button>
            ))}
          </div>
          {fontsNote && <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginTop: 6, lineHeight: 1.5 }}>{fontsNote}</div>}
        </div>

        {onForgetToken && (
          <div>
            <div style={label}>口令</div>
            <button type="button" className="serc" style={pill(false)} onClick={onForgetToken} title="清掉存在这台设备上的口令,重新输入">换口令</button>
          </div>
        )}
      </div>
    </div>
  );
}
