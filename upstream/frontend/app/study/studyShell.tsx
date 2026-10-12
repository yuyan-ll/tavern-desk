'use client';

// 书房唯一壳(page.tsx)的槽位引用:top 头槽 / scroll 内滚区(应用滚动唯一归宿)/ bottom 底槽 / overlay 覆盖槽。
// 槽 DOM 由 page.tsx 常驻挂载;消费方只从这里读,不得反向 import page.tsx(成环)。

import { createContext, useContext } from 'react';

export type StudyShellSlots = {
  topEl: HTMLElement | null;
  bottomEl: HTMLElement | null;
  scrollEl: HTMLElement | null;
  // 覆盖槽:absolute inset:0 铺满 .sty-main,给要盖整个 stage 但不盖侧廊的浮层当 portal 目标;
  // 容器 pointer-events:none,内容各自开 auto。
  overlayEl: HTMLElement | null;
};

const StudyShellContext = createContext<StudyShellSlots>({ topEl: null, bottomEl: null, scrollEl: null, overlayEl: null });

export const StudyShellProvider = StudyShellContext.Provider;

export function useStudyShell(): StudyShellSlots {
  return useContext(StudyShellContext);
}
