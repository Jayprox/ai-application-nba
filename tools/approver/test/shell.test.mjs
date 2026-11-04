import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell } from '../src/shell/parse.mjs';
import { normalizeText, baseLower, looseWords } from '../src/shell/normalize.mjs';

const names = (cmd) => parseShell(cmd).commands.map((c) => c.name && baseLower(c.name)).filter(Boolean);
const sees = (cmd, n = 'curl') => names(cmd).includes(n);

test('story 2.2: a deny item is found after every operator', () => {
  for (const c of [
    'ls && curl x', 'ls || curl x', 'ls ; curl x', 'ls | curl x', 'ls & curl x', 'ls\ncurl x', 'ls;;curl x',
    'ls |& curl x', 'true && false || curl x',
  ]) assert.ok(sees(c), c);
});

test('story 2.2: found inside ( ), { ; }, $( ) and backticks, also nested', () => {
  for (const c of [
    '(curl x)', 'ls && (curl x)', '{ curl x; }', '{ ls; curl x; }', 'echo $(curl x)', 'echo "$(curl x)"', 'echo `curl x`',
    'echo "a `curl x` b"', 'x=$(curl x)', 'echo $(echo $(curl x))', 'ls <(curl x)', 'cat >(curl x)', 'echo ${y:-$(curl x)}',
    'echo $(( $(curl x) + 1 ))', 'if curl x; then ls; fi', 'while true; do curl x; done', 'for i in 1 2; do curl x; done',
  ]) assert.ok(sees(c), c);
});

test('story 2.2: found after env-prefix and wrappers', () => {
  for (const c of [
    'FOO=1 curl x', 'FOO=1 BAR=2 curl x', 'env curl x', 'env -i FOO=1 curl x', 'env -u X curl x', 'command curl x', 'exec curl x', 'time curl x',
    'nohup curl x', 'sudo curl x', 'sudo -u root curl x', 'timeout 5 curl x', 'nice -n 5 curl x', 'xargs curl', 'xargs -I {} curl {}',
    'watch curl x', 'watch -n 5 curl x', 'builtin curl x', 'npx curl', 'env FOO=1 nohup sudo curl x', 'stdbuf -o L curl x',
  ]) assert.ok(sees(c), c);
});

test('story 2.2: found as the argument of bash -c, sh -c, zsh -c, eval, find -exec', () => {
  for (const c of [
    "bash -c 'curl x'", 'sh -c "curl x"', "zsh -c 'ls; curl x'", "bash -lc 'curl x'", "bash -c 'bash -c \"curl x\"'", "eval 'curl x'",
    'eval curl x', 'eval "cu"rl x', 'find . -exec curl {} \;', 'find . -execdir curl {} +', 'find . -ok curl {} \;', "sudo bash -c 'curl x'",
    "env bash -c 'curl x'", 'trap "curl x" EXIT', "alias c='curl x'; c",
  ]) assert.ok(sees(c), c);
});

test('story 2.2: found after a here-doc, in a here-doc fed to a shell, and in process substitution', () => {
  assert.ok(sees('cat <<EOF\nhello\nEOF\ncurl x'));
  assert.ok(sees("bash <<'EOF'\ncurl x\nEOF"));
  assert.ok(sees('bash <<< "curl x"'));
  assert.ok(sees('cat <<EOF\n$(curl x)\nEOF'), 'unquoted heredoc expands $()');
  assert.ok(!sees("cat <<'EOF'\n$(curl x)\nEOF"), 'quoted heredoc does not expand');
  assert.ok(sees('diff <(ls) <(curl x)'));
});

test('story 2.2: found through an alias or function defined earlier in the same command', () => {
  assert.ok(sees('f(){ curl x; }; f'));
  assert.ok(sees('f() { curl x; }\nf'));
  assert.ok(sees('function f { curl x; }; f'));
  assert.ok(sees("alias ll='curl x'; ll"));
  assert.ok(sees('g() ( curl x ); g'));
});

test('story 2.5: syntax the parser cannot follow is flagged, readable part still scanned', () => {
  for (const c of ['echo "unterminated', "echo 'unterminated", 'echo $(unterminated', 'echo `unterminated', 'ls )', '(ls', '{ ls', 'echo ${unterminated', 'echo > ', 'cat <<EOF\nnever closed']) {
    assert.equal(parseShell(c).ok, false, c);
  }
  assert.ok(sees('curl x "unterminated'), 'visible deny item survives a parse error');
  assert.equal(parseShell('echo ok').ok, true);
});

test('story 2.5: dynamic command names and decoded payloads are marked dynamic', () => {
  for (const c of ['$CMD x', '"${x}rm" -rf /', '$(echo curl) x', '`echo curl` x', '${PROG:-ls} x']) {
    const r = parseShell(c);
    assert.ok(r.commands.some((x) => x.dynamicName), c);
  }
  const r = parseShell('echo Y3VybA== | base64 -d | sh');
  const sh = r.commands.find((c) => c.name === 'sh');
  assert.equal(sh.unknownInner, true);
  assert.equal(sh.pipeIndex, 2);
  assert.ok(parseShell('echo $((1+2))').commands[0].words[1].dynamic);
});

test('quote and escape handling: quote splitting, backslashes, ANSI-C, brace expansion', () => {
  assert.equal(parseShell('c"ur"l x').commands[0].name, 'curl');
  assert.equal(parseShell("c'ur'l x").commands[0].name, 'curl');
  assert.equal(parseShell('\\curl x').commands[0].name, 'curl');
  assert.equal(parseShell('cu\\\nrl x').commands[0].name, 'curl');
  const ansi = parseShell("$'\\x63url' x").commands[0];
  assert.equal(ansi.words[0].text, 'curl');
  assert.equal(ansi.words[0].dynamic, true, 'ANSI-C quoting never counts as a plain literal');
  assert.ok(parseShell('echo {a,b}').commands[0].words[1].dynamic);
  assert.ok(!parseShell("echo '{a,b}'").commands[0].words[1].dynamic);
  assert.ok(parseShell('ls *.js').commands[0].words[1].glob);
  assert.ok(!parseShell("ls '*.js'").commands[0].words[1].glob);
  assert.deepEqual(parseShell('echo "$FOO_KEY and ${BAR}"').commands[0].words[1].vars, ['FOO_KEY', 'BAR']);
  assert.deepEqual(parseShell("echo '$FOO_KEY'").commands[0].words[1].vars, []);
});

test('story 2.6: normalisation of case, paths, tabs, runs of spaces, lookalikes, invisibles', () => {
  assert.equal(baseLower('/usr/bin/CURL'), 'curl');
  assert.equal(parseShell('/usr/bin/curl x').commands[0].name, '/usr/bin/curl');
  assert.equal(parseShell('curl\t\t  x').commands[0].words.length, 2);
  const cyr = parseShell('сurl x'); // first letter is Cyrillic es
  assert.equal(cyr.commands[0].name, 'curl');
  assert.equal(cyr.nonAscii, true);
  assert.equal(parseShell('ｃｕｒｌ x').commands[0].name, 'curl'); // fullwidth
  assert.equal(parseShell('cu​rl x').commands[0].name, 'curl'); // zero width space
  assert.equal(parseShell('cu­rl x').commands[0].name, 'curl'); // soft hyphen
  assert.equal(parseShell('rаilway up').commands[0].name, 'railway'); // Cyrillic a
  assert.equal(parseShell('ls\u0000 x').control, true);
  assert.equal(parseShell('cu\0rl x').commands[0].name, 'curl');
  assert.equal(parseShell('ls\rcurl').control, true);
  assert.equal(parseShell('ls').nonAscii, false);
  assert.deepEqual(normalizeText('a​b').text, 'ab');
});

test('structure: operators, pipes, background, depth, redirections, assignments, wrappers', () => {
  const r = parseShell('cd a && ls | wc -l &\nFOO=1 BAR=2 echo hi 2>&1 >/dev/null');
  const by = (n) => r.commands.find((c) => c.name === n);
  assert.equal(by('cd').nextOp, '&&');
  assert.equal(by('ls').nextOp, '|');
  assert.equal(by('wc').pipeIndex, 1);
  assert.equal(by('wc').background, true);
  const echo = by('echo');
  assert.deepEqual(echo.assigns.map((a) => a.name), ['FOO', 'BAR']);
  assert.deepEqual(echo.redirs.map((x) => [x.fd, x.op, x.target.text]), [['2', '>&', '1'], [null, '>', '/dev/null']]);
  assert.equal(parseShell('(ls)').commands[0].depth, 1);
  assert.equal(parseShell('echo > /tmp/x').commands[0].redirs[0].target.text, '/tmp/x');
  assert.equal(parseShell('echo >> /tmp/x').commands[0].redirs[0].op, '>>');
  assert.equal(parseShell('echo hi &> /tmp/x').commands[0].redirs[0].op, '&>');
  assert.equal(parseShell('echo # curl x').commands.length, 1);
  assert.equal(parseShell('echo a#b').commands[0].words[1].text, 'a#b');
  assert.equal(parseShell('').commands.length, 0);
});

test('literal command substitution of cat <<EOF is a plain string (git commit -m "$(cat <<EOF ...)")', () => {
  const r = parseShell("git commit -m \"$(cat <<'EOF'\nfix the thing\n\nsecond paragraph\nEOF\n)\"");
  const git = r.commands.find((c) => c.name === 'git');
  assert.equal(r.ok, true);
  assert.equal(git.words[3].text, 'fix the thing\n\nsecond paragraph');
  assert.equal(git.words[3].dynamic, false);
  const unq = parseShell('git commit -m "$(cat <<EOF\n$HOME\nEOF\n)"').commands.find((c) => c.name === 'git');
  assert.equal(unq.words[3].dynamic, true, 'an unquoted heredoc expands, so it is not literal');
  const withArg = parseShell("git commit -m \"$(cat f <<'EOF'\nx\nEOF\n)\"").commands.find((c) => c.name === 'git');
  assert.equal(withArg.words[3].dynamic, true);
});

test('recursion is bounded', () => {
  let s = 'curl x';
  for (let i = 0; i < 6; i++) s = `bash -c ${JSON.stringify(s)}`;
  const r = parseShell(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('nest_depth'));
  assert.ok(r.commands.length > 0);
});

test('looseWords strips quotes and backslashes for the fallback scan', () => {
  assert.ok(looseWords('x "unterminated c"ur"l y').includes('curl') || looseWords('c"ur"l').includes('curl'));
  assert.deepEqual(looseWords("a;b|c (d) \\e"), ['a', 'b', 'c', 'd', 'e']);
});

test('function definitions are recorded once and their bodies are parsed', () => {
  const r = parseShell('f(){ curl x; }; f');
  assert.equal(r.commands.filter((c) => c.funcName === 'f').length, 1);
  assert.equal(r.commands.filter((c) => c.name === 'f').length, 1);
  assert.equal(parseShell('function g { ls; }').commands.filter((c) => c.funcName === 'g').length, 1);
});
