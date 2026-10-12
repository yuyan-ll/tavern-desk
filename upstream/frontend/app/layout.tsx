import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "书房 · tavern-study",
  description: "一个可嵌入的故事创作书房：私人设定笔记、公开连载与留言、打字桌。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f6ee",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-theme="sage" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        {/* 开机先把存的墙纸/玻璃/字体写到 <html> 上,免得首屏闪一下默认色。逻辑跟 study/deskTheme.tsx
            的 applySkin 同一套(这里必须是内联脚本,等不了 React 水合),改一处记得改另一处。 */}
        <script
          dangerouslySetInnerHTML={{ __html: `(function(){try{var s=JSON.parse(localStorage.getItem('tavern-desk.skin')||'{}')||{};var ok={sage:1,ink:1,rice:1,bronze:1};var d=document.documentElement;var t=s.theme;if(t==='auto'){var dark=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;t=dark?(ok[s.night]?s.night:'ink'):(ok[s.day]?s.day:'sage');}d.dataset.theme=ok[t]?t:'sage';if(s.glass)d.dataset.glass='1';if(s.font&&s.font.file){var st=document.createElement('style');st.id='desk-reading-font';st.textContent='@font-face{font-family:"desk-reading";src:url("/fonts/'+encodeURIComponent(s.font.file)+'");font-display:swap}';document.head.appendChild(st);d.style.setProperty('--font-reading-user','"desk-reading"');}}catch(e){}})();` }}
        />
        {/* React 会把这些 <link> 提升进 <head> */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Noto+Serif+SC:wght@500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        {children}
      </body>
    </html>
  );
}
