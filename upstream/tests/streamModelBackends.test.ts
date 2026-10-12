import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicStreamBackend } from '../src/adapters/streamModelBackends.ts';

const args = { system: [{ text: 'system', cache: true }], prompt: 'prompt', model: 'claude-sonnet-4-6' };

const fakeFetch = (body: string, status = 200, inspect?: (input: RequestInfo | URL, init?: RequestInit) => void) =>
  (async (input, init) => { inspect?.(input, init); return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch;

test('anthropic accepts known terminal reasons and rejects stream errors', async () => {
  const clean = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}', '',
    'data: {"type":"message_stop"}', '',
  ].join('\n');
  {
    const result = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(clean) }).streamChat(args);
    assert.equal(result.ok, true); if (result.ok) { assert.equal(result.stopReason, 'end_turn'); assert.equal(result.usage.output, 6); }
  }
  const truncated = clean.replace('data: {"type":"message_stop"}\n', '');
  const truncatedResult = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(truncated) }).streamChat(args);
  assert.equal(truncatedResult.ok, false);
  const afterStop = `${clean}data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n`;
  const afterStopResult = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(afterStop) }).streamChat(args);
  assert.equal(afterStopResult.ok, false);
  const broken = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\ndata: {"type":"error"}\n';
  {
    const result = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(broken) }).streamChat(args);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.kind, 'protocol');
  }
  const refused = clean.replace('"stop_reason":"end_turn"', '"stop_reason":"refusal"');
  {
    const result = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(refused) }).streamChat(args);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.kind, 'refusal');
  }
});

test('thinkingTags: custom literal tag divert to thinking, separator inserted between two blocks, onEvent gets the separator too', async () => {
  const withCustomTag = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"前<分镜>清单一</分镜>中<分镜>清单二</分镜>后"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}', '',
    'data: {"type":"message_stop"}', '',
  ].join('\n');
  const events: any[] = [];
  const result = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(withCustomTag) })
    .streamChat({ ...args, thinkingTags: ['分镜'], onEvent: (e) => { events.push(e); } });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, '前中后');
    // 两个 <分镜> 块之间必须补一道 \n\n 分隔,不能粘成"清单一清单二"。
    assert.equal(result.thinking, '清单一\n\n清单二');
  }
  const thinkingEvents = events.filter((e) => e.type === 'thinking').map((e) => e.text);
  assert.deepEqual(thinkingEvents, ['清单一', '\n\n', '清单二']);
});

test('thinkingTags omitted: falls back to literal <thinking> only, custom tags pass through untouched', async () => {
  const plain = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<分镜>不分流</分镜>"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}', '',
    'data: {"type":"message_stop"}', '',
  ].join('\n');
  const result = await new AnthropicStreamBackend({ apiKey: 'key', fetch: fakeFetch(plain) }).streamChat(args);
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.text, '<分镜>不分流</分镜>'); assert.equal(result.thinking, ''); }
});
