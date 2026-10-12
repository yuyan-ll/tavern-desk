// 正在写的楼:一扇窗一次只写一楼,手机掉线不算停,只有「停」请求才停。
//
// 为什么:手机切后台、锁屏、换网,连接会被半路掐断。原来 chat/desk.ts 一看到连接断就叫模型停、
// 这一楼不落库——输入的钱照付,字全丢。现在连接断了只是不再往手机上写,模型照写、照常落库;
// 手机回来问一声「这扇窗还在写吗」,写完了重新载入窗口就能看到。要停就走 POST /desk/stop。
//
// 表放进程内存:自托管宿主是单进程,够用。部署成多个 isolate 时这张表各管各的,「停」和「还在写吗」
// 只对落在同一个 isolate 上的请求灵,一扇窗一楼的闸也只在 isolate 内有效。
//
// 一楼最长也就模型超时(8 分钟)加状态板补算;登记超过 STALE_MS 还没放的当它卡死了,让新的一楼顶掉它
// (顺手 abort 旧的),免得一扇窗被锁到宿主重启。

export interface DeskTurn {
  readonly windowId: string;
  readonly controller: AbortController;
  readonly startedAt: number;
  release(): void;
}

const STALE_MS = 20 * 60_000;
const running = new Map<string, DeskTurn>();

// 拿到登记就返回它;这扇窗已经有一楼在写就返回 null。同步完成,两个并发请求不会都拿到。
export function claimDeskTurn(windowId: string, now = Date.now()): DeskTurn | null {
  const existing = running.get(windowId);
  if (existing) {
    if (now - existing.startedAt < STALE_MS) return null;
    existing.controller.abort();
    running.delete(windowId);
  }
  const turn: DeskTurn = {
    windowId,
    controller: new AbortController(),
    startedAt: now,
    // 只放自己那一份:被顶掉的旧登记收尾时不能把新登记删了
    release() { if (running.get(windowId) === turn) running.delete(windowId); },
  };
  running.set(windowId, turn);
  return turn;
}

export function isDeskTurnRunning(windowId: string): boolean {
  return running.has(windowId);
}

// 叫正在写的那一楼停下;那一楼不落库。登记要等它真的收尾才放,所以停完马上问「还在写吗」可能还是 true。
export function stopDeskTurn(windowId: string): boolean {
  const turn = running.get(windowId);
  if (!turn) return false;
  turn.controller.abort();
  return true;
}
