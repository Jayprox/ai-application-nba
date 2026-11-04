// Bash pre-filter: deny / ask / allow per simple command, strictest part wins (story 3).
// Never executes anything. Reads the file system only to resolve paths; the one process it may start
// is the injected git diff of the npm-test guard (A8).
import path from 'node:path';
import { parseShell } from '../shell/parse.mjs';
import { baseLower, looseWords } from '../shell/normalize.mjs';
import { realResolve, isInside, buildPathCtx, classifyPath, textSecret, expandHome } from '../paths.mjs';
import { allowRule, cdTarget, findInfo, sedInfo, gitParts } from './allow.mjs';

const BASH_KEYS = new Set(['command', 'description', 'timeout', 'run_in_background', 'dangerouslyDisableSandbox']);
const MAX_PARSE = 32 * 1024;
const MAX_WORDS_ANALYSED = 400;

const shape = (why) => ({ decision: 'ask', rule_id: 'K-SHAPE', undecided: false, reason: why });

// ---- small helpers ----
const arg = (c) => (c.opaque ? c.words : c.words.slice(1));
const isFlag = (t) => t.length > 1 && t.startsWith('-');
const clusterHas = (t, ch) => /^-[A-Za-z]+$/.test(t) && t.includes(ch);

function recordsFor(S) {
  return { deny: [], ask: [], notAllow: [] };
}

function add(list, id) { if (!list.includes(id)) list.push(id); }

// Tracks `cd`/`pushd` through the whole command so relative targets of later commands resolve against the directory the
// shell would be in. A `cd X &&` at the top level narrows the set; any other joiner (or a cd in a subshell) widens it, which
// over-approximates. Targets are tracked even when they are protected or outside the repo (the allow rule for cd is separate).
// A target we cannot resolve makes every later command's directory unknown.
function setupCwds(parsed, S) {
  let cur = [S.cwdReal]; let unknown = false;
  for (const c of parsed.commands) {
    c.cwds = cur; c.cwdUnknown = unknown;
    const nm = c.name ? baseLower(c.name) : null;
    if (c.nested === 'wrapper' || (nm !== 'cd' && nm !== 'pushd' && nm !== 'popd')) continue;
    if (nm === 'popd') { unknown = true; continue; }
    const target = c.words.slice(1).find((w) => !(isFlag(w.text) && !w.dynamic));
    const home = /^(~|\$HOME|\$\{HOME\})(\/|$)/;
    let t;
    if (!target) t = S.pc.home;
    else if (target.text === '-' || (target.dynamic && !home.test(target.text))) { unknown = true; continue; }
    else t = expandHome(target.text, S.pc.home);
    if (!t || /[$`]/.test(t)) { unknown = true; continue; }
    const succ = [];
    for (const d of cur) { const r = realResolve(t, d); if (r.ok) succ.push(r.real); else if (r.error === 'dotdot_after_missing') succ.push(path.resolve(d, t)); }
    if (!succ.length) { unknown = true; continue; }
    cur = c.depth === 0 && c.nextOp === '&&' ? [...new Set(succ)] : [...new Set([...succ, ...cur])];
  }
}

// ---- word-level checks: secrets, variable expansion, protected paths ----
function pathCandidate(text) {
  if (text.length > 4096 || text.includes('\0')) return false;
  return !/\s/.test(text) || text.startsWith('/') || text.startsWith('~') || text.startsWith('$HOME') || text.startsWith('${HOME}');
}

function resolveWord(w, c, S) {
  // returns array of classified real paths for a word, [] when it is not a usable path
  let t = w.text;
  if (isFlag(t)) {
    const m = /^--?([A-Za-z][\w-]*)=(.*)$/.exec(t);
    // --output=x, --file=x ... name a path even when relative
    if (!m || !(/^[\/~$]/.test(m[2]) || /output|file|dir|path|out/i.test(m[1]))) return [];
    t = m[2];
  }
  if (!pathCandidate(t)) return [];
  const homePrefixed = /^(~|\$HOME|\$\{HOME\})(\/|$)/.test(t);
  if (w.dynamic && !homePrefixed) return [];
  t = expandHome(t, S.pc.home);
  if (t === null || (w.dynamic && /[$`]/.test(t))) return [];
  const out = [];
  const forms = [t];
  // dd-style key=value arguments (of=/path)
  const kv = /^[A-Za-z_][\w-]*=(.+)$/.exec(t);
  if (kv) forms.push(kv[1]);
  // git-style rev:path (HEAD:.claude/settings.json)
  const rp = /^[^\/\s:][^\s:]*:([^\s:].*)$/.exec(t);
  if (rp && !t.includes('://')) forms.push(rp[1]);
  for (const f of forms) {
    for (const cwd of c.cwds) {
      const r = realResolve(f, cwd);
      if (r.ok) out.push({ real: r.real, k: classifyPath(r.real, S.pc) });
      else if (r.error === 'dotdot_after_missing') { const lex = path.resolve(cwd, f); out.push({ real: lex, k: classifyPath(lex, S.pc) }); } // a/../.claude through a missing a
    }
  }
  return out;
}

function checkWords(c, S, F) {
  const B = S.B;
  const secretVar = S.secretVarRes;
  const prodRe = S.prodRe;
  const words = arg(c);
  const touches = [];
  const treeWriter = B.tree_writers.includes(c.nm);
  const inline = B.inline_code.includes(c.nm);
  let n = 0;
  const each = [...words, ...c.assigns.map((a) => a.value)];
  for (const w of each) {
    if (++n > MAX_WORDS_ANALYSED) { add(F.notAllow, 'too_many_words'); break; }
    for (const v of w.vars) if (secretVar.some((re) => re.test(v))) add(F.deny, 'D-SECRET-ENVDUMP');
    const expanded = expandHome(w.text, S.pc.home) ?? w.text;
    if (pathCandidate(w.text)) {
      const ts = textSecret(expanded);
      if (ts.envfile) add(F.deny, 'D-SECRET-ENVFILE');
      if (ts.secret) add(F.deny, 'D-SECRET-PATH');
    }
    if (w.dynamic && !/^(~|\$HOME|\$\{HOME\})/.test(w.text)) {
      // an unresolvable word cannot be a protected path we know about; attribute changers still refuse (below)
    }
    for (const { real, k } of resolveWord(w, c, S)) {
      if (k.envfile) add(F.deny, 'D-SECRET-ENVFILE');
      if (k.secret) add(F.deny, 'D-SECRET-PATH');
      if (k.protected || (k.protectedAncestor && treeWriter)) touches.push({ w, real });
    }
    if (w.heredocLiteral) {
      // the literal body of "$(cat <<'EOF' ...)" is one argument, but its text still must not name a secret
      for (const tok of w.text.split(/\s+/).filter(Boolean)) {
        const ts = textSecret(expandHome(tok, S.pc.home) ?? tok);
        if (ts.envfile) add(F.deny, 'D-SECRET-ENVFILE');
        if (ts.secret) add(F.deny, 'D-SECRET-PATH');
      }
      if (prodRe.test(w.text)) add(F.deny, 'D-PROD-VARS');
    }
    if (inline || (B.writers || []).includes(c.nm)) {
      const L = w.text.toLowerCase();
      if (S.markers.some((m) => L.includes(m))) touches.push({ w, real: null });
    }
  }
  for (const r of c.redirs) {
    const op = r.op;
    if (op === '<<' || op === '<<-' || op === '<<<') continue;
    const readOnly = op === '<';
    const t = r.target.text;
    if (r.target.dynamic && !/^(~|\$HOME|\$\{HOME\})/.test(t)) {
      if (!readOnly) add(F.notAllow, 'dynamic_redirect_target');
      continue;
    }
    const ts = textSecret(expandHome(t, S.pc.home) ?? t);
    if (ts.envfile) add(F.deny, 'D-SECRET-ENVFILE');
    if (ts.secret) add(F.deny, 'D-SECRET-PATH');
    for (const { real, k } of resolveWord(r.target, c, S)) {
      if (k.envfile) add(F.deny, 'D-SECRET-ENVFILE');
      if (k.secret) add(F.deny, 'D-SECRET-PATH');
      if (k.protected) { if (readOnly) add(F.ask, 'K-SELF-READ'); else add(F.deny, 'D-SELF'); }
    }
  }
  // the command word itself may be a path into the install dir (running an installed file)
  if (c.name && c.name.includes('/')) {
    for (const { k } of resolveWord(c.words[0], c, S)) if (k.protected) add(F.deny, 'D-SELF');
  }
  return touches;
}

function readOnlyForSelf(c) {
  const nm = c.nm;
  if (nm === 'sed') { const s = sedInfo(c); return s.safe; }
  if (nm === 'find') return findInfo(c).readOnly;
  if (nm === 'git') {
    if (c.words.some((w) => /^--output(=|$)/.test(w.text))) return false;
    const { sub } = gitParts(c.words);
    return !!sub && ['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'blame', 'rev-parse', 'grep', 'describe', 'shortlog', 'ls-tree', 'cat-file'].includes(sub);
  }
  return false;
}

// ---- per-command rules ----
function dbHostVerdict(c, S) {
  const locals = S.B.local_hosts;
  const hosts = []; let unparsable = false;
  const isLocal = (h) => h === '' || h.startsWith('/') || locals.includes(h.toLowerCase());
  const fromString = (v) => {
    const um = /^postgres(?:ql)?:\/\/([^\s]*)/i.exec(v);
    if (um) { try { hosts.push(new URL(v).hostname.replace(/^\[|\]$/g, '')); } catch { unparsable = true; } return true; }
    const hm = /(?:^|\s)host=(\S+)/.exec(v);
    if (hm) { hosts.push(hm[1]); return true; }
    return false;
  };
  const w = arg(c);
  for (let i = 0; i < w.length; i++) {
    const t = w[i].text;
    if (w[i].dynamic || w[i].glob) { unparsable = true; continue; }
    let m;
    if (t === '-h' || t === '--host') { if (w[i + 1]) { hosts.push(w[i + 1].text); i++; } else unparsable = true; continue; }
    if ((m = /^--host=(.*)$/.exec(t))) { hosts.push(m[1]); continue; }
    if ((m = /^-h(.+)$/.exec(t)) && !t.startsWith('--')) { hosts.push(m[1]); continue; }
    if (t === '-d' || t === '--dbname') { if (w[i + 1]) { fromString(w[i + 1].text); i++; } continue; }
    if ((m = /^--dbname=(.*)$/.exec(t))) { fromString(m[1]); continue; }
    fromString(t);
  }
  for (const a of c.assigns) {
    const v = a.value.text;
    if (a.value.dynamic) unparsable = true;
    else if (a.name === 'PGHOST' || a.name === 'PGHOSTADDR') hosts.push(v);
    else if (/^DATABASE_|^PG(SERVICE|PASSFILE)/.test(a.name)) { if (!fromString(v)) unparsable = true; }
  }
  return unparsable || hosts.some((h) => !isLocal(h));
}

function gitDeny(c, F) {
  const { sub, args } = gitParts(c.words);
  if (sub === 'push') {
    let force = false; let mainHit = false; let dynamicArg = false; let bulk = false;
    for (const a of args) {
      if (a.dynamic) { dynamicArg = true; continue; }
      let t = a.text;
      if (t.startsWith('--')) {
        if (/^--(force|force-with-lease|force-if-includes)(=.*)?$/.test(t)) force = true;
        if (t === '--all' || t === '--mirror') bulk = true;
        continue;
      }
      if (isFlag(t)) { if (t.includes('f') && /^-[A-Za-z]+$/.test(t)) force = true; continue; }
      if (t.startsWith('+')) { force = true; t = t.slice(1); }
      for (const part of t.split(':')) {
        const name = part.replace(/^refs\/heads\//, '').toLowerCase();
        if (name === 'main' || name === 'master') mainHit = true;
      }
    }
    if (mainHit || bulk) add(F.deny, 'D-GIT-MAIN');
    if (force) add(F.deny, 'D-GIT-FORCE');
    if (dynamicArg) add(F.notAllow, 'dynamic_push_arg');
  } else if (sub === 'config') {
    const readOnly = args.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--get-urlmatch'].includes(a.text));
    if (!readOnly) add(F.deny, 'D-SELF'); // writes .git/config or ~/.gitconfig
  }
}

function ghDeny(c, F) {
  const w = arg(c).filter((x) => !x.dynamic);
  const pos = []; 
  for (let i = 0; i < w.length; i++) {
    const t = w[i].text;
    if (t === '-R' || t === '--repo') { i++; continue; }
    if (isFlag(t)) continue;
    pos.push(t);
  }
  const [a, b] = pos;
  if ((a === 'pr' && b === 'merge') || a === 'release' || (a === 'workflow' && b === 'run')) add(F.deny, 'D-GH');
  if (a === 'gist' && b === 'create') add(F.deny, 'D-NET');
  if (a === 'api') {
    const t = w.map((x) => x.text);
    for (let i = 0; i < t.length; i++) {
      if ((t[i] === '-X' || t[i] === '--method') && t[i + 1] && t[i + 1].toUpperCase() !== 'GET') add(F.deny, 'D-NET');
      if (/^(-X|--method=)(?!GET$)/i.test(t[i]) && t[i] !== '-X') add(F.deny, 'D-NET');
      if (['-f', '-F', '--field', '--raw-field', '--input'].includes(t[i]) || /^--(field|raw-field|input)=/.test(t[i])) add(F.deny, 'D-NET');
    }
  }
}

function rmDeny(c, F) {
  let rec = false; let force = false;
  for (const a of arg(c)) {
    const t = a.text;
    if (t === '--') break;
    if (t === '--recursive') rec = true;
    else if (t === '--force') force = true;
    else if (/^-[A-Za-z]+$/.test(t)) { if (/[rR]/.test(t)) rec = true; if (t.includes('f')) force = true; }
  }
  if (rec && force) add(F.deny, 'D-RM-RF');
}

function psEnv(c) {
  return arg(c).some((a) => !a.dynamic && /^[A-Za-z]*e[A-Za-z]*$/.test(a.text) && !a.text.startsWith('-'));
}

function judgeCommand(c, S, F) {
  const B = S.B;
  c.nm = c.name ? baseLower(c.name) : null;
  const nm = c.nm;
  const touches = checkWords(c, S, F);
  if (touches.length) F.anyTouch = true;

  if (c.dynamicName) add(F.notAllow, 'dynamic_command_name');
  if (c.unknownInner) add(F.notAllow, 'unknown_inner_script');

  if (nm) {
    if (B.railway.includes(nm)) add(F.deny, 'D-PROD-RAILWAY');
    if (B.db_clients.includes(nm) && dbHostVerdict(c, S)) add(F.deny, 'D-PROD-PSQL');
    if (B.keychain.includes(nm)) add(F.deny, 'D-SECRET-KEYCHAIN');
    if (B.env_dump.includes(nm)) add(F.deny, 'D-SECRET-ENVDUMP');
    if (B.net.includes(nm)) add(F.deny, 'D-NET');
    if (nm === 'rsync' && arg(c).some((a) => /^rsync:\/\/|^[^\/\s-][^\/\s]*:/.test(a.text) || a.text.includes('@'))) add(F.deny, 'D-NET');
    if (nm === 'env' && c.noInner) add(F.deny, 'D-SECRET-ENVDUMP');
    if (nm === 'set' && c.words.length === 1) add(F.deny, 'D-SECRET-ENVDUMP');
    if (nm === 'export' && (c.words.length === 1 || arg(c).some((a) => a.text === '-p'))) add(F.deny, 'D-SECRET-ENVDUMP');
    if ((nm === 'declare' || nm === 'typeset') && (c.words.length === 1 || arg(c).some((a) => clusterHas(a.text, 'p') || clusterHas(a.text, 'x')))) add(F.deny, 'D-SECRET-ENVDUMP');
    if (nm === 'ps' && psEnv(c)) add(F.deny, 'D-SECRET-ENVDUMP');
    if (nm === 'git') gitDeny(c, F);
    if (nm === 'gh') ghDeny(c, F);
    if (nm === 'rm') rmDeny(c, F);
    const inst = B.install[nm];
    if (inst) {
      const first = arg(c).find((a) => !isFlag(a.text));
      if (first && inst.includes(first.text)) add(F.ask, 'K-INSTALL');
    }
    if (B.system.includes(nm)) add(F.ask, 'K-SYS');
    if (B.attr_changers.includes(nm)) {
      // The user-immutable flag can be cleared without sudo, so flag/attribute changers are fenced hard: any target on a
      // protected path (or above one), a target we cannot resolve, or a directory we cannot track is deny. Targets fed from
      // stdin (xargs, pipes, find -exec) are deny when a protected path is mentioned anywhere in the command, else ask.
      const rest = arg(c).filter((a) => !isFlag(a.text));
      const spec = ['chflags', 'chgrp', 'chattr', 'setfacl'].includes(nm) ? 1 : 0;
      const stdinFed = c.nested === 'wrapper' || c.pipeIndex > 0 || rest.length <= spec;
      if (touches.length || rest.some((a) => a.dynamic || a.glob) || c.cwdUnknown) add(F.deny, 'D-SELF');
      else if (stdinFed) F.pendingAttr = true;
      else add(F.ask, 'K-ATTR');
    }
  }
  if (c.wrapper || c.opaque) {
    // belt and braces: a wrapper's unknown flag could swallow the real command word
    for (const w of arg(c)) {
      if (w.dynamic) continue;
      const wn = baseLower(w.text);
      if (B.railway.includes(wn)) add(F.deny, 'D-PROD-RAILWAY');
      if (B.net.includes(wn)) add(F.deny, 'D-NET');
      if (B.keychain.includes(wn)) add(F.deny, 'D-SECRET-KEYCHAIN');
      if (B.env_dump.includes(wn)) add(F.deny, 'D-SECRET-ENVDUMP');
    }
  }
  if (touches.length) {
    if (nm && (B.read_commands.includes(nm) || readOnlyForSelf(c))) add(F.ask, 'K-SELF-READ');
    else add(F.deny, 'D-SELF');
  }
  c.allow = F.deny.length || F.ask.length ? null : allowRule(c, S);
}

function looseDenyScan(texts, S, F) {
  const B = S.B;
  for (const t of texts) {
    const wn = baseLower(t);
    if (B.railway.includes(wn)) add(F.deny, 'D-PROD-RAILWAY');
    if (B.net.includes(wn)) add(F.deny, 'D-NET');
    if (B.keychain.includes(wn)) add(F.deny, 'D-SECRET-KEYCHAIN');
    if (B.env_dump.includes(wn)) add(F.deny, 'D-SECRET-ENVDUMP');
    const ts = textSecret(t);
    if (ts.envfile) add(F.deny, 'D-SECRET-ENVFILE');
    if (ts.secret) add(F.deny, 'D-SECRET-PATH');
  }
}

export function bashRules({ input, cwd, ctx }) {
  for (const k of Object.keys(input)) if (!BASH_KEYS.has(k)) return shape('Unknown field in Bash input.');
  const { command } = input;
  if (typeof command !== 'string' || command.trim() === '') return shape('Missing or invalid command.');
  if ('description' in input && typeof input.description !== 'string') return shape('Invalid description.');
  if ('timeout' in input && typeof input.timeout !== 'number') return shape('Invalid timeout.');
  for (const k of ['run_in_background', 'dangerouslyDisableSandbox']) if (k in input && typeof input[k] !== 'boolean') return shape('Invalid flag.');

  const policy = ctx.policy; const B = policy.bash;
  const pc = buildPathCtx(ctx);
  const cw = realResolve(cwd);
  if (!cw.ok) return shape('Working directory cannot be resolved.');
  const S = {
    ctx, B, pc, cwdReal: cw.real,
    secretVarRes: B.secret_var_regex.map((r) => new RegExp(r, 'i')),
    markers: pc.markers, prodRe: new RegExp(B.prod_vars.join('|'), 'i'),
  };
  const F = recordsFor(S);
  const prodRe = new RegExp(B.prod_vars.join('|'), 'i');

  const tooLong = command.length > MAX_PARSE;
  const parsed = tooLong ? { ok: false, errors: ['too_long'], commands: [], normalized: command, nonAscii: /[^\x00-\x7f]/.test(command), control: false } : parseShell(command);
  if (prodRe.test(parsed.code ?? parsed.normalized)) add(F.deny, 'D-PROD-VARS');
  for (const v of parsed.vars || []) if (S.secretVarRes.some((re) => re.test(v))) add(F.deny, 'D-SECRET-ENVDUMP');
  if (!parsed.ok) add(F.notAllow, 'parse:' + parsed.errors[0]);
  if (parsed.nonAscii) add(F.notAllow, 'non_ascii');
  if (parsed.control) add(F.notAllow, 'control_chars');
  if (input.dangerouslyDisableSandbox === true) add(F.notAllow, 'sandbox_override');

  if (!tooLong) {
    setupCwds(parsed, S);
    for (const c of parsed.commands) judgeCommand(c, S, F);
    if (F.pendingAttr) {
      const low = (parsed.code ?? parsed.normalized).toLowerCase();
      if (F.anyTouch || pc.markers.some((m) => low.includes(m))) add(F.deny, 'D-SELF'); else add(F.ask, 'K-ATTR');
    }
    if (parsed.commands.some((c) => c.dynamicName)) {
      // a command name we cannot read: scan every readable word for a deny item (story 2.5)
      looseDenyScan(parsed.commands.flatMap((c) => [...c.words, ...c.assigns.map((a) => a.value)]).filter((w) => !w.dynamic).map((w) => w.text), S, F);
    }
  }
  if (!parsed.ok) looseDenyScan(looseWords(parsed.code ?? parsed.normalized), S, F);

  const allowed = parsed.ok && parsed.commands.length > 0 && !F.notAllow.length && parsed.commands.every((c) => c.allow);
  if (F.deny.length) return { decision: 'deny', rule_id: F.deny[0], undecided: false, reason: policy.rules[F.deny[0]]?.reason || 'Denied.', rules: F.deny };
  if (F.ask.length) return { decision: 'ask', rule_id: F.ask[0], undecided: false, reason: policy.rules[F.ask[0]]?.reason || 'Ask.', rules: F.ask };
  if (allowed) {
    const ids = [...new Set(parsed.commands.map((c) => c.allow))];
    const main = ids.find((i) => i !== 'L-CD') || ids[0];
    return { decision: 'allow', rule_id: main, undecided: false, reason: policy.rules[main]?.reason || 'Allowed.', rules: ids };
  }
  return { decision: 'ask', rule_id: 'K-DEFAULT', undecided: true, reason: policy.rules['K-DEFAULT'].reason, rules: [], notAllow: F.notAllow };
}
