// Strict flag parsing for allow rules. A flag that is not in the spec makes the whole command not-allowed.
// spec: { short: 'abc' (no value), shortVal: 'AB' (value attached or next word), long: { '--x': true|'value'|'optval' }, numeric: bool }
export function parseFlags(words, spec) {
  const flags = []; const pos = [];
  let done = false;
  const fail = { ok: false, flags, pos };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]; const t = w.text;
    if (w.dynamic || w.glob) return fail;
    if (done || !t.startsWith('-') || t === '-') { pos.push(w); continue; }
    if (t === '--') { done = true; flags.push({ name: '--', value: null }); continue; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq > 0 ? t.slice(0, eq) : t;
      const def = spec.long?.[name];
      if (def === undefined) return fail;
      let value = null;
      if (def === 'value') { value = eq > 0 ? t.slice(eq + 1) : words[++i]?.text; if (value === undefined) return fail; }
      else if (def === 'optval') value = eq > 0 ? t.slice(eq + 1) : null;
      else if (eq > 0) return fail;
      flags.push({ name, value });
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(t)) { flags.push({ name: '-N', value: t.slice(1) }); continue; }
    for (let k = 1; k < t.length; k++) {
      const ch = t[k];
      if (spec.short?.includes(ch)) flags.push({ name: '-' + ch, value: null });
      else if (spec.shortVal?.includes(ch)) {
        let v = t.slice(k + 1);
        if (v === '') { v = words[++i]?.text; if (v === undefined) return fail; }
        flags.push({ name: '-' + ch, value: v });
        break;
      } else return fail;
    }
  }
  return { ok: true, flags, pos };
}

export const hasFlag = (flags, name) => flags.some((f) => f.name === name);
export const flagValue = (flags, name) => flags.find((f) => f.name === name)?.value;
