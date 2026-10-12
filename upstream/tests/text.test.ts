// createLiteralThinkingSplitter(多标签名单)单测,不连网不连 D1。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiteralThinkingSplitter } from '../src/shared/text.ts';

function collector() {
  let text = '';
  let think = '';
  const emitText = async (t: string) => { text += t; };
  const emitThink = async (t: string) => { think += t; };
  return { get text() { return text; }, get think() { return think; }, emitText, emitThink };
}

// 逐字符喂,逼出"标签被流式切成半截"的路径
async function feedChars(feed: (c: string) => Promise<void>, s: string) {
  for (const c of s) await feed(c);
}

test('默认参数(不传tags)、force=true 时 <分镜> 不在名单里,原样进文本通道', async () => {
  const c = collector();
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true);
  await sp.feed('前<分镜>清单</分镜>后');
  await sp.flush();
  assert.equal(c.text, '前<分镜>清单</分镜>后');
  assert.equal(c.think, '');
});

test('force + tags=[thinking,分镜]:<分镜>标签分流,标签本身丢弃', async () => {
  const c = collector();
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true, ['thinking', '分镜']);
  await sp.feed('前<分镜>清单</分镜>后');
  await sp.flush();
  assert.equal(c.text, '前后');
  assert.equal(c.think, '清单');
});

test('开标签被流式切成三段仍正确分流', async () => {
  const c = collector();
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true, ['thinking', '分镜']);
  await feedChars(sp.feed, '前<分');
  await feedChars(sp.feed, '镜>清单</分');
  await feedChars(sp.feed, '镜>后');
  await sp.flush();
  assert.equal(c.text, '前后');
  assert.equal(c.think, '清单');
});

test('同名嵌套配平深度,回0才出段', async () => {
  const c = collector();
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true, ['thinking', '分镜']);
  await sp.feed('<分镜>a<分镜>b</分镜>c</分镜>d');
  await sp.flush();
  assert.equal(c.think, 'abc');
  assert.equal(c.text, 'd');
});

test('<Thinking>大写与<分镜 >带空格不分流', async () => {
  const c = collector();
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true, ['thinking', '分镜']);
  await sp.feed('<Thinking>x</Thinking><分镜 >y</分镜 >');
  await sp.flush();
  assert.equal(c.text, '<Thinking>x</Thinking><分镜 >y</分镜 >');
  assert.equal(c.think, '');
});

test('一条流里先thinking再分镜都改道,onBlockOpen调用2次', async () => {
  const c = collector();
  let opens = 0;
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true, ['thinking', '分镜'], async () => { opens++; });
  await sp.feed('<thinking>t</thinking>中<分镜>s</分镜>');
  await sp.flush();
  assert.equal(c.think, 'ts');
  assert.equal(c.text, '中');
  assert.equal(opens, 2);
});

test('块内出现名单里另一标签,当普通思考文字不触发新块', async () => {
  const c = collector();
  let opens = 0;
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true, ['thinking', '分镜'], async () => { opens++; });
  await sp.feed('<分镜>a<thinking>b</thinking>c</分镜>');
  await sp.flush();
  assert.equal(c.think, 'a<thinking>b</thinking>c');
  assert.equal(c.text, '');
  assert.equal(opens, 1);
});

test('流结束未闭合<分镜>残余,flush后归思考区,不漏回正文', async () => {
  const c = collector();
  const sp = createLiteralThinkingSplitter('x', c.emitText, c.emitThink, true, ['thinking', '分镜']);
  await sp.feed('<分镜>残余');
  await sp.flush();
  assert.equal(c.think, '残余');
  assert.equal(c.text, '');
});
