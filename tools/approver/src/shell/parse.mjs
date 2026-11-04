// Parser for the subset of bash the approver understands. It never executes anything. Anything it
// cannot follow sets ok=false (the caller then refuses to allow) but the readable part is still
// returned so a visible deny item can still deny (story 2.5).
import { normalizeText, baseLower, expandBraces } from './normalize.mjs';

export const MAX_NEST = 4;
const BLANK = new Set([' ', '\t']);
const BOUNDARY = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const SKIP_RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac', '!', '}']);
const OPAQUE_RESERVED = new Set(['for', 'select', 'case', 'function', '[[', 'coproc']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'su']);

// Wrapper commands: which of their own flags take a value, and whether a positional (duration) comes first.
const WRAPPERS = {
  env: { value: ['-u', '-C', '-S', '--unset', '--chdir'], assigns: true },
  command: { value: [], stop: ['-v', '-V'] },
  exec: { value: ['-a'] },
  time: { value: ['-f', '-o'] },
  nohup: { value: [] },
  builtin: { value: [] },
  setsid: { value: [] },
  caffeinate: { value: ['-t', '-w'] },
  nice: { value: ['-n'] },
  ionice: { value: ['-c', '-n', '-p'] },
  timeout: { value: ['-s', '-k'], positional: 1 },
  stdbuf: { value: ['-i', '-o', '-e'] },
  sudo: { value: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T'], assigns: true },
  xargs: { value: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-J'] },
  npx: { value: ['-p', '--package', '-c', '--call'] },
  watch: { value: ['-n', '--interval', '-d'], script: true },
  arch: { value: ['-arch', '-c'] },
  noglob: { value: [] },
  nocorrect: { value: [] },
  '-': { value: [] },
  repeat: { value: [], positional: 1 },
  script: { value: ['-t', '-F'], positional: 1 },
  'sandbox-exec': { value: ['-f', '-p', '-n', '-D'] },
  flock: { value: ['-w', '-E'], positional: 1 },
  unbuffer: { value: [] },
  parallel: { value: ['-j', '-n', '-a'] },
  chronic: { value: [] },
  doas: { value: ['-u', '-C'] },
};

export class Word {
  constructor() { this.text = ''; this.raw = ''; this.dynamic = false; this.glob = false; this.quoted = false; this.vars = []; this.ansi = false; }
}

class ParseError extends Error {}

function newCommand(parser) {
  return {
    name: null, words: [], assigns: [], redirs: [], heredocs: [], herestring: null,
    pipeIndex: parser.pipeIdx, prevOp: parser.prevOp, nextOp: null, background: false,
    depth: parser.st.depth, nested: parser.st.kind, complex: false, opaque: false, dynamicName: false,
    unknownInner: false, funcName: null,
  };
}

class Parser {
  constructor(src, st, nest) {
    this.s = src; this.i = 0; this.st = st; this.nest = nest;
    this.pending = []; this.deferred = []; this.root = false; this.prevOp = null; this.pipeIdx = 0; this.last = null;
  }

  err(msg) { this.st.errors.push(msg); }
  skipBlanks() {
    const s = this.s;
    for (;;) {
      if (BLANK.has(s[this.i])) this.i++;
      else if (s[this.i] === '\\' && s[this.i + 1] === '\n') this.i += 2;
      else break;
    }
  }
  atWordStart() { const p = this.s[this.i - 1]; return this.i === 0 || BOUNDARY.has(p); }
  setOp(op) {
    if (this.last) this.last.nextOp = op;
    this.prevOp = op;
    this.pipeIdx = op === '|' ? this.pipeIdx + 1 : 0;
  }

  withKind(kind, fn) {
    const prev = this.st.kind; this.st.kind = kind; this.st.depth++;
    try { fn(); } finally { this.st.kind = prev; this.st.depth--; }
  }

  parseSequence(closer) {
    const s = this.s;
    for (;;) {
      this.skipBlanks();
      if (this.i >= s.length) { if (closer) this.err('unterminated_' + (closer === ')' ? 'paren' : 'brace')); return; }
      const c = s[this.i];
      if (c === '#' && this.atWordStart()) { const from = this.i; while (this.i < s.length && s[this.i] !== '\n') this.i++; if (this.root) this.st.comments.push([from, this.i]); continue; }
      if (c === '\n') { this.i++; this.readHeredocs(); this.setOp('\n'); continue; }
      if (c === ';') { this.i++; if (s[this.i] === ';') this.i++; if (s[this.i] === '&') this.i++; this.setOp(';'); continue; }
      if (c === '&' && s[this.i + 1] !== '>') {
        if (s[this.i + 1] === '&') { this.i += 2; this.setOp('&&'); } else { this.i++; if (this.last) this.last.background = true; this.setOp('&'); }
        continue;
      }
      if (c === '|') {
        if (s[this.i + 1] === '|') { this.i += 2; this.setOp('||'); }
        else if (s[this.i + 1] === '&') { this.i += 2; this.setOp('|'); }
        else { this.i++; this.setOp('|'); }
        continue;
      }
      if (c === ')') {
        if (closer === ')') { this.i++; return; }
        this.err('unexpected_close_paren'); this.i++; continue;
      }
      if (c === '(') {
        if (s[this.i + 1] === '(') { this.arithCommand(); continue; }
        this.i++;
        this.withKind(this.st.kind, () => this.parseSequence(')'));
        continue;
      }
      if (closer === '}' && c === '}' && (this.i + 1 >= s.length || BOUNDARY.has(s[this.i + 1]))) { this.i++; return; }
      const before = this.i;
      this.parseSimple();
      if (this.i === before) { this.err('no_progress'); this.i++; }
    }
  }

  arithCommand() {
    const end = this.findArithEnd(this.i + 2);
    const cmd = newCommand(this);
    cmd.complex = true; cmd.opaque = true; cmd.dynamicName = true;
    if (end < 0) { this.err('unterminated_arith'); this.i = this.s.length; } else {
      this.scanEmbedded(this.s.slice(this.i + 2, end));
      this.i = end + 2;
    }
    this.st.commands.push(cmd); this.last = cmd;
  }

  findArithEnd(from) {
    let d = 0;
    for (let j = from; j < this.s.length; j++) {
      const c = this.s[j];
      if (c === '(') d++;
      else if (c === ')') { if (d === 0 && this.s[j + 1] === ')') return j; d--; if (d < 0) return -1; }
    }
    return -1;
  }

  scanEmbedded(text) {
    const p = new Parser(text, this.st, this.nest);
    const w = new Word();
    p.readDQ(null, w);
    this.st.vars.push(...w.vars); // expansions inside unquoted here-docs and ${...} are still expansions
  }

  parseSimple() {
    const s = this.s;
    const cmd = newCommand(this);
    let sawSomething = false;
    for (;;) {
      this.skipBlanks();
      if (this.i >= s.length) break;
      const c = s[this.i];
      if (c === '#' && this.atWordStart()) { const from = this.i; while (this.i < s.length && s[this.i] !== '\n') this.i++; if (this.root) this.st.comments.push([from, this.i]); continue; }
      if (c === '\n' || c === ';' || c === '|' || c === ')') break;
      if (c === '&' && s[this.i + 1] !== '>') break;
      if (c === '(') {
        const m = /^\(\s*\)\s*/.exec(s.slice(this.i));
        if (cmd.words.length === 1 && !cmd.assigns.length && m) { this.functionBody(cmd, m[0].length); sawSomething = true; break; }
        this.err('unexpected_open_paren'); this.i++; continue;
      }
      if (c === '}' && !cmd.words.length && !cmd.assigns.length && (this.i + 1 >= s.length || BOUNDARY.has(s[this.i + 1]))) {
        this.i++; cmd.complex = true; sawSomething = true; continue;
      }
      sawSomething = true;
      if (/^(\d+)?(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.test(s.slice(this.i, this.i + 12)) && !s.startsWith('<(', this.i) && !s.startsWith('>(', this.i)) {
        this.redirect(cmd); continue;
      }
      const w = this.readWord();
      if (!cmd.words.length && !cmd.opaque) {
        if (!w.quoted && !w.dynamic) {
          if (SKIP_RESERVED.has(w.text)) { cmd.complex = true; continue; }
          if (w.text === 'function') {
            cmd.complex = true; cmd.opaque = true; cmd.words.push(w);
            this.skipBlanks();
            const nm = this.readWord(); cmd.words.push(nm);
            this.skipBlanks();
            const m = /^\(\s*\)\s*/.exec(s.slice(this.i));
            this.functionBody(cmd, m ? m[0].length : 0, nm.text);
            break;
          }
          if (OPAQUE_RESERVED.has(w.text)) { cmd.complex = true; cmd.opaque = true; cmd.words.push(w); continue; }
          if (w.text === '{') {
            cmd.complex = true;
            this.withKind(this.st.kind, () => this.parseSequence('}'));
            continue;
          }
        }
        const am = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(w.raw);
        if (am) {
          const v = Object.assign(new Word(), w, { text: w.text.slice(am[0].length) });
          cmd.assigns.push({ name: am[1], value: v }); continue;
        }
      }
      cmd.words.push(w);
    }
    if (!sawSomething) return;
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length && !cmd.complex) return;
    this.finish(cmd);
  }

  finish(cmd) {
    const w0 = cmd.words[0];
    if (w0 && w0.expansions && !cmd.opaque) {
      // {curl,x} and curl{,}: bash runs `curl x`, zsh runs a command named `curl,x`. The parser cannot know which, so the real
      // command stays dynamic (never allowed) and a deny-only shadow copy with the bash expansion is judged for deny/ask results.
      const lit = (t) => Object.assign(new Word(), { text: t, raw: t });
      const shadow = { ...cmd, words: [...w0.expansions.map(lit), ...cmd.words.slice(1)], denyOnly: true };
      shadow.name = shadow.words[0].text;
      this.st.commands.push(shadow);
      this.unwrap(shadow);
    }
    if (w0 && !cmd.opaque) {
      // any brace syntax in the command word (quoted or not) means the command cannot be judged as written
      if ((w0.dynamic && !w0.ansi) || /[{}]/.test(w0.raw)) cmd.dynamicName = true; else cmd.name = w0.text; // ANSI-C quoting decodes statically
    }
    this.st.commands.push(cmd);
    this.last = cmd;
    if (cmd.name && !cmd.opaque) {
      // A shell fed by a here-doc needs the body, which is read at the next newline.
      if (this.pending.some((q) => q.cmd === cmd)) this.deferred.push(cmd); else this.unwrap(cmd);
    }
  }

  flushDeferred() {
    while (this.deferred.length) this.unwrap(this.deferred.shift());
  }

  functionBody(cmd, parenLen, fname = cmd.words[0].text) {
    cmd.funcName = fname; cmd.complex = true; cmd.opaque = true;
    this.i += parenLen;
    while (this.s[this.i] === '\n' || BLANK.has(this.s[this.i])) this.i++;
    const c = this.s[this.i];
    if (c === '{') { this.i++; this.withKind('func', () => this.parseSequence('}')); }
    else if (c === '(') { this.i++; this.withKind('func', () => this.parseSequence(')')); }
    else this.err('bad_function_body');
  }

  redirect(cmd) {
    const s = this.s;
    const m = /^(\d+)?(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(s.slice(this.i, this.i + 12));
    this.i += m[0].length;
    this.skipBlanks();
    if (this.i >= s.length || BOUNDARY.has(s[this.i]) && !s.startsWith('<(', this.i) && !s.startsWith('>(', this.i)) {
      this.err('redirect_without_target'); return;
    }
    const target = this.readWord();
    const op = m[2];
    cmd.redirs.push({ op, fd: m[1] ?? null, target });
    if (op === '<<' || op === '<<-') this.pending.push({ cmd, delim: target.text, strip: op === '<<-', quoted: target.quoted });
    if (op === '<<<') cmd.herestring = target;
  }

  readHeredocs() {
    const s = this.s;
    while (this.pending.length) {
      const p = this.pending.shift();
      let body = ''; let found = false;
      while (this.i < s.length) {
        let nl = s.indexOf('\n', this.i); if (nl < 0) nl = s.length;
        let line = s.slice(this.i, nl);
        this.i = Math.min(nl + 1, s.length);
        const cmp = p.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === p.delim) { found = true; break; }
        // bash 3.2 ends a here-doc inside $( ) at a line like `EOF)` where zsh does not: any body line that
        // starts with the delimiter is ambiguous, so the command is not fully parsed (Sec 6).
        if (p.delim && cmp.startsWith(p.delim)) this.err('heredoc_ambiguous_terminator');
        body += line + '\n';
      }
      if (!found) this.err('heredoc_unterminated');
      p.cmd.heredocs.push({ delim: p.delim, quoted: p.quoted, body });
      if (!p.quoted) this.scanEmbedded(body);
      if (!this.pending.some((q) => q.cmd === p.cmd)) {
        const i = this.deferred.indexOf(p.cmd);
        if (i >= 0) { this.deferred.splice(i, 1); this.unwrap(p.cmd); }
      }
    }
  }

  // ---- words ----
  readWord() {
    const s = this.s; const w = new Word(); const start = this.i;
    if (s.startsWith('<(', this.i) || s.startsWith('>(', this.i)) {
      this.i += 2; w.dynamic = true;
      this.withKind('subst', () => this.parseSequence(')'));
    }
    while (this.i < s.length) {
      const c = s[this.i];
      if (BOUNDARY.has(c)) break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') { this.i += 2; continue; }
        w.quoted = true;
        if (this.i + 1 < s.length) { w.text += s[this.i + 1]; this.i += 2; } else { w.text += '\\'; this.i++; }
      } else if (c === "'") {
        const e = s.indexOf("'", this.i + 1);
        if (e < 0) { this.err('unterminated_single_quote'); w.text += s.slice(this.i + 1); this.i = s.length; w.quoted = true; break; }
        w.text += s.slice(this.i + 1, e); w.quoted = true; this.i = e + 1;
      } else if (c === '"') {
        w.quoted = true; this.i++;
        this.readDQ('"', w);
      } else if (c === '$') {
        this.readDollar(w, false);
      } else if (c === '`') {
        this.readBacktick(w);
      } else if (c === '*' || c === '?' || c === '[') {
        w.glob = true; w.text += c; this.i++;
      } else { w.text += c; this.i++; }
    }
    w.raw = s.slice(start, this.i);
    if (w.raw.length > 4096) w.dynamic = true; // too long to scan for braces in linear time: never a plain literal
    else if (/(?<![\\$])\{[^{}]*(,|\.\.)[^{}]*\}/.test(w.raw.replace(/'[^']*'|"[^"]*"/g, ''))) {
      if (!w.dynamic && !w.quoted && /\{[^{}]*,[^{}]*\}/.test(w.raw)) w.expansions = expandBraces(w.raw);
      w.dynamic = true; // brace expansion
    }
    return w;
  }

  // Double-quote content. term '"' consumes the closing quote; null reads to the end (heredoc bodies).
  readDQ(term, w) {
    const s = this.s;
    for (;;) {
      if (this.i >= s.length) { if (term) this.err('unterminated_double_quote'); return; }
      const c = s[this.i];
      if (term && c === term) { this.i++; return; }
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === '\n') { this.i += 2; continue; }
        if (n === '$' || n === '`' || n === '"' || n === '\\') { w.text += n; this.i += 2; continue; }
        w.text += c; this.i++; continue;
      }
      if (c === '$') { this.readDollar(w, true); continue; }
      if (c === '`') { this.readBacktick(w); continue; }
      w.text += c; this.i++;
    }
  }

  readDollar(w, inDQ) {
    const s = this.s; const n = s[this.i + 1];
    if (n === '(') {
      if (s[this.i + 2] === '(') {
        const end = this.findArithEnd(this.i + 3);
        w.dynamic = true;
        if (end < 0) { this.err('unterminated_arith'); w.text += s.slice(this.i); this.i = s.length; return; }
        w.text += s.slice(this.i, end + 2); this.scanEmbedded(s.slice(this.i + 3, end)); this.i = end + 2; return;
      }
      this.i += 2;
      const startIdx = this.st.commands.length;
      this.withKind('subst', () => this.parseSequence(')'));
      const sub = this.st.commands.slice(startIdx);
      // $(cat <<'EOF' ... EOF) is a literal string: the usual way to pass a multi-line commit message.
      if (inDQ && sub.length === 1 && sub[0].name === 'cat' && sub[0].words.length === 1 && sub[0].heredocs.length === 1
        && sub[0].heredocs[0].quoted && sub[0].redirs.length === 1 && sub[0].assigns.length === 0) {
        w.text += sub[0].heredocs[0].body.replace(/\n+$/, '');
        w.heredocLiteral = true;
        this.st.commands.splice(startIdx); // it is a string now, not a command
      } else w.dynamic = true;
      return;
    }
    if (n === '{') {
      let d = 0; let j = this.i + 1;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '\\') { j++; continue; }
        if (c === "'" && !inDQ) { const e = s.indexOf("'", j + 1); if (e < 0) { j = s.length; break; } j = e; continue; }
        if (c === '{') d++;
        else if (c === '}') { d--; if (d === 0) break; }
      }
      w.dynamic = true;
      if (j >= s.length) { this.err('unterminated_brace_expansion'); w.text += s.slice(this.i); this.i = s.length; return; }
      const inner = s.slice(this.i + 2, j);
      const nm = /^[!#]?([A-Za-z_][A-Za-z0-9_]*)/.exec(inner);
      if (nm) w.vars.push(nm[1]);
      w.text += s.slice(this.i, j + 1);
      this.scanEmbedded(inner);
      this.i = j + 1; return;
    }
    if (n === "'" && !inDQ) {
      let j = this.i + 2; let out = '';
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === '\\' && j + 1 < s.length) {
          const e = s[++j];
          if (e === 'n') out += '\n'; else if (e === 't') out += '\t'; else if (e === 'r') out += '\r';
          else if (e === 'x') { const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 1)); if (m) { out += String.fromCharCode(parseInt(m[0], 16)); j += m[0].length; } else out += 'x'; }
          else if (/[0-7]/.test(e)) { const m = /^[0-7]{1,3}/.exec(s.slice(j)); out += String.fromCharCode(parseInt(m[0], 8)); j += m[0].length - 1; }
          else if (e === 'u' || e === 'U') { const m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(j + 1)); if (m) { try { out += String.fromCodePoint(parseInt(m[0], 16)); } catch { /* ignore */ } j += m[0].length; } }
          else out += e;
        } else out += s[j];
      }
      if (j >= s.length) { this.err('unterminated_ansi_quote'); this.i = s.length; } else this.i = j + 1;
      w.text += out; w.dynamic = true; w.ansi = true; w.quoted = true; return;
    }
    if (n === '"' && !inDQ) { this.i += 2; w.quoted = true; this.readDQ('"', w); return; }
    const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.i + 1, this.i + 200));
    if (nm) { w.vars.push(nm[0]); w.text += '$' + nm[0]; w.dynamic = true; this.i += 1 + nm[0].length; return; }
    if (n !== undefined && /[0-9?$@*#!-]/.test(n)) { w.text += '$' + n; w.dynamic = true; this.i += 2; return; }
    w.text += '$'; this.i++;
  }

  readBacktick(w) {
    const s = this.s;
    let j = this.i + 1; let inner = '';
    for (; j < s.length && s[j] !== '`'; j++) {
      if (s[j] === '\\' && (s[j + 1] === '`' || s[j + 1] === '\\' || s[j + 1] === '$')) { inner += s[++j]; } else inner += s[j];
    }
    w.dynamic = true;
    if (j >= s.length) { this.err('unterminated_backtick'); this.i = s.length; w.text += '`' + inner; return; }
    this.i = j + 1;
    w.text += '`' + inner + '`';
    this.nestedScript(inner, 'subst');
  }

  // ---- nested scripts and wrapper commands ----
  nestedScript(text, kind = 'script') {
    if (this.nest + 1 > MAX_NEST) { this.err('nest_depth'); return; }
    const p = new Parser(text, this.st, this.nest + 1);
    const prev = this.st.kind; this.st.kind = kind; this.st.depth++;
    try { p.parseSequence(null); p.readHeredocs(); p.flushDeferred(); } finally { this.st.kind = prev; this.st.depth--; }
  }

  nestedArgv(words, parentCmd) {
    if (!words.length) return;
    if (this.nest + 1 > MAX_NEST) { this.err('nest_depth'); return; }
    const cmd = {
      ...newCommand(this), words, nested: 'wrapper', pipeIndex: parentCmd.pipeIndex, prevOp: parentCmd.prevOp,
      depth: this.st.depth + 1,
    };
    if (words[0].dynamic && !words[0].ansi) cmd.dynamicName = true; else cmd.name = words[0].text;
    this.st.commands.push(cmd);
    if (cmd.name) {
      const p = new Parser('', this.st, this.nest + 1);
      p.pipeIdx = parentCmd.pipeIndex; p.prevOp = parentCmd.prevOp;
      p.unwrap(cmd);
    }
  }

  unwrap(cmd) {
    const nm = baseLower(cmd.name);
    const w = cmd.words;
    cmd.wrapper = false;
    if (SHELLS.has(nm)) {
      cmd.wrapper = true;
      let script = null;
      for (let k = 1; k < w.length - 1; k++) {
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w[k].text) && !w[k].dynamic) { script = w[k + 1]; break; }
      }
      if (script) {
        if (script.dynamic) cmd.unknownInner = true; else this.nestedScript(script.text, 'script');
      } else if (cmd.heredocs.length) this.nestedScript(cmd.heredocs.map((h) => h.body).join('\n'), 'script');
      else if (cmd.herestring) { if (cmd.herestring.dynamic) cmd.unknownInner = true; else this.nestedScript(cmd.herestring.text, 'script'); }
      else if (w.slice(1).some((x) => !x.text.startsWith('-'))) cmd.runsFile = true; // `bash script.sh`: a file, never allowed
      else cmd.unknownInner = true; // script comes from stdin
      return;
    }
    if (nm === 'eval') {
      cmd.wrapper = true;
      if (w.slice(1).some((x) => x.dynamic)) cmd.unknownInner = true; else this.nestedScript(w.slice(1).map((x) => x.text).join(' '), 'script');
      return;
    }
    if (nm === 'source' || nm === '.') { cmd.wrapper = true; cmd.unknownInner = true; return; }
    if (nm === 'alias') {
      for (const a of w.slice(1)) {
        const m = /^[^=]+=(.*)$/s.exec(a.text);
        if (m) { if (a.dynamic) cmd.unknownInner = true; else this.nestedScript(m[1], 'alias'); }
      }
      return;
    }
    if (nm === 'trap') {
      if (w[1]) { if (w[1].dynamic) cmd.unknownInner = true; else this.nestedScript(w[1].text, 'script'); }
      return;
    }
    if (nm === 'find') {
      for (let k = 1; k < w.length; k++) {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(w[k].text)) {
          cmd.wrapper = true;
          let e = k + 1;
          while (e < w.length && !(w[e].text === ';' || w[e].text === '+')) e++;
          this.nestedArgv(w.slice(k + 1, e), cmd);
        }
      }
      return;
    }
    const spec = WRAPPERS[nm];
    if (!spec) return;
    cmd.wrapper = true;
    let k = 1;
    let positional = spec.positional || 0;
    for (; k < w.length; k++) {
      const t = w[k].text;
      if (w[k].dynamic && !(spec.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k].raw))) { break; }
      if (t === '--') { k++; break; }
      if (spec.stop && spec.stop.includes(t)) return; // `command -v x` only looks a name up
      if (t.startsWith('-') && t.length > 1) {
        if (nm === 'env' && t === '-S') { if (w[k + 1]) this.nestedScript(w[k + 1].text, 'script'); return; }
        if (nm === 'sudo' && (t === '-s' || t === '-i')) { /* shell: remaining words are the command or none */ }
        if (spec.value.includes(t)) k++;
        continue;
      }
      if (spec.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k].raw)) continue;
      if (positional > 0) { positional--; continue; }
      break;
    }
    const argv = w.slice(k);
    if (!argv.length) cmd.noInner = true;
    if (spec.script && argv.length) {
      if (argv.some((x) => x.dynamic)) cmd.unknownInner = true; else this.nestedScript(argv.map((x) => x.text).join(' '), 'script');
      return;
    }
    if (argv.length === 0 && nm !== 'env' && nm !== 'nohup' && nm !== 'sudo') return;
    if (argv.length) this.nestedArgv(argv, cmd);
  }
}

// Returns { ok, errors, commands, normalized, nonAscii, control }.
export function parseShell(raw) {
  const { text, nonAscii, control } = normalizeText(raw);
  const st = { commands: [], errors: [], depth: 0, kind: null, vars: [], comments: [] };
  const p = new Parser(text, st, 0);
  p.root = true;
  try { p.parseSequence(null); p.readHeredocs(); p.flushDeferred(); } catch (e) { if (e instanceof ParseError) st.errors.push(e.message); else st.errors.push('internal_parse_error'); }
  // `code` is the text with the comments the parser found blanked out: comment text must never change a decision (QA 6)
  let code = text;
  for (const [a, b] of st.comments.slice().reverse()) code = code.slice(0, a) + ' '.repeat(b - a) + code.slice(b);
  return { ok: st.errors.length === 0, errors: st.errors, commands: st.commands, vars: st.vars, normalized: text, code, nonAscii, control };
}
