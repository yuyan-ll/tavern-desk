// 「一扇窗一次只写一楼」的登记表(upstream/src/chat/deskTurns.ts):同步占位、只放自己那份、卡死的能被顶掉。

import test from 'node:test';
import assert from 'node:assert/strict';
import { claimDeskTurn, isDeskTurnRunning, stopDeskTurn } from '../../upstream/src/chat/deskTurns.ts';

test('登记:占了就不能再占,放了才能再占;停只 abort 不放', () => {
  const a = claimDeskTurn('t-1')!;
  assert.ok(a);
  assert.equal(claimDeskTurn('t-1'), null);
  assert.equal(isDeskTurnRunning('t-1'), true);
  assert.equal(stopDeskTurn('t-1'), true);
  assert.equal(a.controller.signal.aborted, true);
  assert.equal(isDeskTurnRunning('t-1'), true, '停了以后要等那一楼自己收尾才放');
  a.release();
  assert.equal(isDeskTurnRunning('t-1'), false);
  assert.equal(stopDeskTurn('t-1'), false);
  const b = claimDeskTurn('t-1')!;
  assert.ok(b);
  a.release(); // 旧的再放一次不能把新的删了
  assert.equal(isDeskTurnRunning('t-1'), true);
  b.release();
});

test('登记:占了二十分钟还没放的当卡死,新的一楼顶掉它并 abort 旧的', () => {
  const t0 = 1_000_000;
  const old = claimDeskTurn('t-2', t0)!;
  assert.equal(claimDeskTurn('t-2', t0 + 19 * 60_000), null);
  const fresh = claimDeskTurn('t-2', t0 + 21 * 60_000)!;
  assert.ok(fresh);
  assert.equal(old.controller.signal.aborted, true);
  old.release();
  assert.equal(isDeskTurnRunning('t-2'), true);
  fresh.release();
  assert.equal(isDeskTurnRunning('t-2'), false);
});
