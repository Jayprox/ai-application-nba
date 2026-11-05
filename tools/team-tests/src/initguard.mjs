// Init-event guard (plan 5.5). Pure: takes the raw `system`/`init` object and the expectations and
// returns the list of problems. Fails closed: a missing field, an unknown field, an unknown value
// or a wrong type is a problem. Any problem makes the launcher kill the child. Field names are
// UNCONFIRMED for the installed CLI (plan 5.6 item 7); session 1 verifies them.

// Keys the guard knows. Anything else is a problem, so a CLI that adds a field stops the pilot
// until the Lead reviews it (a reviewed PR), instead of silently widening what a session may do.
export const REQUIRED_INIT_KEYS = Object.freeze(['type', 'subtype', 'cwd', 'tools', 'mcp_servers', 'permissionMode', 'apiKeySource', 'model', 'agents', 'session_id']);
export const OPTIONAL_INIT_KEYS = Object.freeze(['uuid', 'slash_commands', 'output_style', 'claude_code_version', 'skills', 'plugins']);

const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

/**
 * @param {object} init  raw init event
 * @param {{cwd:string, allowedTools:string[], allowedModes:string[], apiKeySource:string, model:string, agents:string[]}} expect
 * @returns {string[]} problem codes (empty = ok); never includes field values
 */
export function checkInit(init, expect) {
  const p = [];
  if (!init || typeof init !== 'object' || Array.isArray(init)) return ['init-not-object'];
  for (const k of REQUIRED_INIT_KEYS) if (!(k in init) || init[k] === null || init[k] === undefined) p.push(`missing-${k}`);
  for (const k of Object.keys(init)) if (!REQUIRED_INIT_KEYS.includes(k) && !OPTIONAL_INIT_KEYS.includes(k)) p.push('unknown-field');
  if ('cwd' in init && (typeof init.cwd !== 'string' || init.cwd !== expect.cwd)) p.push('cwd-not-fixture');
  if ('mcp_servers' in init && init.mcp_servers !== null) {
    if (!Array.isArray(init.mcp_servers)) p.push('mcp-servers-type');
    else if (init.mcp_servers.length > 0) p.push('mcp-servers-not-empty');
  }
  if ('plugins' in init && !(Array.isArray(init.plugins) && init.plugins.length === 0)) p.push('plugins-not-empty');
  if ('tools' in init && init.tools !== null) {
    if (!isStrArray(init.tools)) p.push('tools-type');
    else if (init.tools.some((t) => !expect.allowedTools.includes(t))) p.push('tools-not-subset');
  }
  if ('permissionMode' in init && init.permissionMode !== null) {
    if (typeof init.permissionMode !== 'string' || /bypass/i.test(init.permissionMode)) p.push('permission-mode-bypass');
    else if (!expect.allowedModes.includes(init.permissionMode)) p.push('permission-mode-unknown');
  }
  if ('apiKeySource' in init && init.apiKeySource !== null && init.apiKeySource !== expect.apiKeySource) p.push('api-key-source');
  if ('model' in init && init.model !== null && init.model !== expect.model) p.push('model-not-approved');
  if ('agents' in init && init.agents !== null) {
    if (!isStrArray(init.agents)) p.push('agents-type');
    else if (!sameSet(init.agents, expect.agents)) p.push('agents-mismatch');
  }
  return [...new Set(p)];
}
