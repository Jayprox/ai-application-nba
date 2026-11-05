// Parses stream-json output and session JSONL into a normalised event list.
// Tolerant of missing fields (field names are UNCONFIRMED for the installed CLI, plan 5.6);
// never throws on odd input. Unparseable non-blank lines are counted in `badLines` so a
// checker can fail closed. Pure: no I/O.

const asText = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
  return '';
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Names of tools that start a subagent (config/forbidden.json agentToolNames mirrors this). */
export const AGENT_TOOL_NAMES = Object.freeze(['Task', 'Agent']);

function agentName(input) {
  const n = input?.subagent_type ?? input?.agent ?? input?.name;
  return typeof n === 'string' ? n : '';
}

function usageOf(u) {
  if (!isObj(u)) return undefined;
  return {
    input_tokens: num(u.input_tokens) ?? 0,
    cache_creation_input_tokens: num(u.cache_creation_input_tokens) ?? 0,
    cache_read_input_tokens: num(u.cache_read_input_tokens) ?? 0,
    output_tokens: num(u.output_tokens) ?? 0,
  };
}

function normaliseMessage(obj, out, state) {
  const msg = isObj(obj.message) ? obj.message : {};
  const role = obj.type === 'assistant' || msg.role === 'assistant' ? 'assistant' : 'user';
  const sub = Boolean(obj.parent_tool_use_id) || obj.isSidechain === true;
  const base = sub ? { sub: true, parentToolUseId: obj.parent_tool_use_id ?? null } : {};
  const content = msg.content ?? obj.content;
  if (typeof content === 'string') {
    out.push({ type: role === 'assistant' ? 'assistant_text' : 'user_text', text: content, ...base });
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({ type: role === 'assistant' ? 'assistant_text' : 'user_text', text: b.text, ...base });
      } else if (b.type === 'tool_use' && role === 'assistant') {
        const id = typeof b.id === 'string' ? b.id : '';
        const input = isObj(b.input) ? b.input : {};
        if (AGENT_TOOL_NAMES.includes(b.name)) {
          state.agents.set(id, agentName(input));
          out.push({ type: 'agent', toolUseId: id, name: agentName(input), tool: b.name, ...base });
        } else {
          out.push({ type: 'tool_use', toolUseId: id, name: String(b.name ?? ''), input, ...base });
        }
      } else if (b.type === 'tool_result') {
        const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
        const text = asText(b.content);
        if (state.agents.has(id)) out.push({ type: 'agent_result', toolUseId: id, name: state.agents.get(id), text, isError: b.is_error === true, ...base });
        else out.push({ type: 'tool_result', toolUseId: id, text, isError: b.is_error === true, ...base });
      }
    }
  }
  if (role === 'assistant') {
    const u = usageOf(msg.usage);
    if (u) out.push({ type: 'usage', messageId: typeof msg.id === 'string' ? msg.id : null, model: typeof msg.model === 'string' ? msg.model : null, usage: u, ...base });
  }
}

function normaliseLine(obj, out, state) {
  if (!isObj(obj)) return false;
  if (obj.type === 'system') {
    if (obj.subtype === 'init') {
      out.push({
        type: 'init',
        cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
        tools: Array.isArray(obj.tools) ? obj.tools.map(String) : null,
        mcpServers: Array.isArray(obj.mcp_servers) ? obj.mcp_servers : null,
        permissionMode: typeof obj.permissionMode === 'string' ? obj.permissionMode : null,
        apiKeySource: typeof obj.apiKeySource === 'string' ? obj.apiKeySource : null,
        model: typeof obj.model === 'string' ? obj.model : null,
        agents: Array.isArray(obj.agents) ? obj.agents.map(String) : null,
        sessionId: typeof obj.session_id === 'string' ? obj.session_id : null,
      });
    }
    return true;
  }
  if (obj.type === 'assistant' || obj.type === 'user') {
    normaliseMessage(obj, out, state);
    return true;
  }
  if (obj.type === 'result') {
    out.push({
      type: 'result',
      subtype: typeof obj.subtype === 'string' ? obj.subtype : null,
      isError: obj.is_error === true,
      text: typeof obj.result === 'string' ? obj.result : '',
      totalCostUsd: num(obj.total_cost_usd),
      numTurns: num(obj.num_turns),
      durationMs: num(obj.duration_ms),
      durationApiMs: num(obj.duration_api_ms),
      usage: usageOf(obj.usage),
      modelUsage: isObj(obj.modelUsage) ? obj.modelUsage : undefined,
      sessionId: typeof obj.session_id === 'string' ? obj.session_id : null,
    });
    return true;
  }
  return true; // well-formed JSON object of another kind (summary, queue ops, ...): ignored
}

/**
 * parseTranscript(text) -> { events, badLines, lines }
 * `text` is NDJSON (stream-json or session JSONL). Each event gets a stable index `i`.
 */
export function parseTranscript(text) {
  const events = [];
  const state = { agents: new Map() };
  let badLines = 0;
  let lines = 0;
  if (typeof text !== 'string') return { events, badLines: 1, lines: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    let obj;
    try { obj = JSON.parse(line); } catch { badLines++; continue; }
    if (!isObj(obj)) { badLines++; continue; }
    normaliseLine(obj, events, state);
  }
  events.forEach((e, i) => { e.i = i; });
  return { events, badLines, lines };
}

/** Join several transcripts (main plus subagent files) into one result. */
export function parseTranscripts(texts) {
  const all = { events: [], badLines: 0, lines: 0 };
  for (const t of texts) {
    const r = parseTranscript(t);
    all.events.push(...r.events);
    all.badLines += r.badLines;
    all.lines += r.lines;
  }
  all.events.forEach((e, i) => { e.i = i; });
  return all;
}

/** The final `result` event's usage fields (plan 4.2), or null when absent. */
export function resultUsage(events) {
  const r = [...events].reverse().find((e) => e.type === 'result');
  return r ? { totalCostUsd: r.totalCostUsd, numTurns: r.numTurns, durationMs: r.durationMs, durationApiMs: r.durationApiMs, isError: r.isError, subtype: r.subtype, usage: r.usage, modelUsage: r.modelUsage } : null;
}

/** Independent per-model sum of message usage, de-duplicated by message id (plan 4.2). */
export function sumMessageUsage(events) {
  const seen = new Set();
  const byModel = {};
  for (const e of events) {
    if (e.type !== 'usage') continue;
    if (e.messageId) {
      if (seen.has(e.messageId)) continue;
      seen.add(e.messageId);
    }
    const m = (byModel[e.model ?? 'unknown'] ??= { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
    for (const k of Object.keys(m)) m[k] += e.usage[k];
  }
  return byModel;
}

/** Subagent invocations in order: [{i, name}]. */
export function agentInvocations(events) {
  return events.filter((e) => e.type === 'agent').map((e) => ({ i: e.i, name: e.name }));
}
