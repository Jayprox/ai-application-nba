import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, parseTranscripts, resultUsage, sumMessageUsage, agentInvocations } from '../src/transcript.mjs';
import { L, ndjson } from './helpers.mjs';

test('stream-json: init, text, tool_use, tool_result, agent and result events are normalised', () => {
  const t = parseTranscript(ndjson([
    L.init({ mcp_servers: [{ name: 'x' }], agents: ['developer'] }),
    L.say('hello'),
    L.bash('b1', 'ls'),
    L.res('b1', [{ type: 'text', text: 'a.txt' }]),
    L.agent('a1', 'product-analyst'),
    L.res('a1', 'Handoff block'),
    L.result('final', { modelUsage: { m: { inputTokens: 1 } } }),
  ]));
  assert.equal(t.badLines, 0);
  assert.deepEqual(t.events.map((e) => e.type), ['init', 'assistant_text', 'usage', 'tool_use', 'tool_result', 'agent', 'agent_result', 'result']);
  assert.deepEqual(t.events.map((e) => e.i), [0, 1, 2, 3, 4, 5, 6, 7]);
  const init = t.events[0];
  assert.equal(init.cwd, '/fx');
  assert.deepEqual(init.mcpServers, [{ name: 'x' }]);
  assert.equal(init.apiKeySource, 'apiKeyHelper');
  assert.equal(t.events[3].name, 'Bash');
  assert.equal(t.events[3].input.command, 'ls');
  assert.equal(t.events[4].text, 'a.txt');
  assert.deepEqual(agentInvocations(t.events), [{ i: 5, name: 'product-analyst' }]);
  assert.equal(t.events[6].name, 'product-analyst');
  assert.equal(t.events[7].text, 'final');
});

test('result event usage fields (plan 4.2) are read; missing fields are tolerated', () => {
  const t = parseTranscript(ndjson([L.result('ok', { modelUsage: { m: { costUSD: 0.5 } } })]));
  const u = resultUsage(t.events);
  assert.equal(u.totalCostUsd, 0.01);
  assert.equal(u.numTurns, 2);
  assert.equal(u.durationMs, 10);
  assert.equal(u.durationApiMs, 5);
  assert.equal(u.isError, false);
  assert.equal(u.subtype, 'success');
  assert.deepEqual(u.usage, { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 });
  assert.deepEqual(u.modelUsage, { m: { costUSD: 0.5 } });
  const bare = parseTranscript(ndjson([{ type: 'result' }]));
  const b = resultUsage(bare.events);
  assert.equal(b.totalCostUsd, undefined);
  assert.equal(b.usage, undefined);
  assert.equal(resultUsage([]), null);
});

test('per-message usage is summed per model and de-duplicated by message id', () => {
  const m = (id, model, i, o) => ({ type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: 5 } } });
  const t = parseTranscript(ndjson([m('m1', 'big', 10, 2), m('m1', 'big', 10, 2), m('m2', 'big', 1, 1), m('m3', 'small', 7, 7)]));
  const s = sumMessageUsage(t.events);
  assert.deepEqual(s.big, { input_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 3 });
  assert.equal(s.small.input_tokens, 7);
});

test('session JSONL and sidechain (subagent) messages are marked, not dropped', () => {
  const t = parseTranscript(ndjson([
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', parent_tool_use_id: 'a9', message: { role: 'user', content: 'plain string content' } },
    { type: 'summary', summary: 'ignored' },
  ]));
  assert.equal(t.badLines, 0);
  assert.equal(t.events[0].sub, true);
  assert.equal(t.events[1].type, 'user_text');
  assert.equal(t.events[1].sub, true);
  assert.equal(t.events.length, 2);
});

test('Agent-named tool is also an agent invocation; unnamed agent has an empty name', () => {
  const t = parseTranscript(ndjson([L.use('x1', 'Agent', { agent: 'developer' }), L.use('x2', 'Task', {})]));
  assert.deepEqual(agentInvocations(t.events).map((a) => a.name), ['developer', '']);
});

test('unparseable lines are counted, blank lines ignored, odd input never throws', () => {
  const t = parseTranscript('{"type":"result"}\n\nnot json\n[1,2]\n"str"\n{"type":"result","result":"a"}\n');
  assert.equal(t.badLines, 3);
  assert.equal(t.events.length, 2);
  for (const bad of [undefined, null, 5, {}]) {
    const r = parseTranscript(bad);
    assert.equal(r.events.length, 0);
    assert.equal(r.badLines, 1);
  }
  assert.deepEqual(parseTranscript(''), { events: [], badLines: 0, lines: 0 });
  assert.doesNotThrow(() => parseTranscript(ndjson([{ type: 'assistant' }, { type: 'user', message: null }, { type: 'assistant', message: { content: [null, 5, { type: 'tool_use' }] } }])));
});

test('parseTranscripts joins main and subagent files with continuous indexes', () => {
  const r = parseTranscripts([ndjson([L.say('a')]), 'garbage\n', ndjson([L.say('b')])]);
  assert.equal(r.badLines, 1);
  assert.deepEqual(r.events.filter((e) => e.type === 'assistant_text').map((e) => e.text), ['a', 'b']);
  assert.deepEqual(r.events.map((e) => e.i), r.events.map((_, i) => i));
});
