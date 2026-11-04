import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeEnv, payload, runHook, readLog, cleanup } from './helpers.mjs';
import { redact, prepareRecord, appendRecord, rotate, summarizeInput, MAX_RECORD_BYTES } from '../src/log.mjs';

const envs = [];
const mk = (o) => { const e = makeEnv(o); envs.push(e); return e; };
afterEach(() => { while (envs.length) cleanup(envs.pop()); });

// Fake secrets only. None of these is a real credential.
const FAKES = [
  'sk-ant-api03-FAKEFAKEFAKE1234', 'ghp_FAKEFAKEFAKEFAKE12345', 'gho_FAKEFAKEFAKE9876', 'xoxb-1234-FAKEFAKE-abcdef',
  'AKIAFAKEFAKEFAKE1234', 'hunter2hunter2', 'p4ssw0rdFAKE', 'FAKEBEARERVALUE.abc.def',
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'QWxhZGRpbjpvcGVuIHNlc2FtZUZBS0VGQUtFRkFLRQ0123abC',
  'fakeuser:fakepass', 'FAKEDBPASSWORD',
];

test('redaction: none of the fake secrets survive in the log file (story 7.5)', async () => {
  const env = mk({ mode: 'shadow' });
  const cmds = [
    `echo ${FAKES[0]} ${FAKES[1]} ${FAKES[2]}`,
    `curl -H "Authorization: Bearer ${FAKES[7]}" https://x.example`,
    `ANTHROPIC_API_KEY=${FAKES[0]} node x.js`,
    `GITHUB_TOKEN="${FAKES[1]}" gh api x`,
    `export DATABASE_URL='postgres://${FAKES[10]}@db.example:5432/x'`,
    `psql postgresql://${FAKES[10]}@host/db`,
    `mycmd --password ${FAKES[5]} --api-key=${FAKES[6]}`,
    `echo ${FAKES[8]} ${FAKES[9]} ${FAKES[4]} ${FAKES[3]}`,
    `X_SECRET=${FAKES[11]} DB_PASSWORD='${FAKES[6]}' run`,
    `echo '{"api_key": "${FAKES[5]}"}'`,
  ];
  for (const command of cmds) await runHook(env, payload(env, { tool_input: { command } }));
  // A Write's content is never logged, only its size.
  await runHook(env, payload(env, { tool_name: 'Write', tool_input: { file_path: path.join(env.repo, 'a.txt'), content: `SECRET-CONTENT ${FAKES[0]}` } }));
  const text = fs.readFileSync(path.join(env.logDir, 'decisions.jsonl'), 'utf8');
  for (const f of FAKES) {
    for (const piece of f.split(':')) assert.ok(!text.includes(piece), `leaked ${piece}`);
  }
  assert.ok(!text.includes('SECRET-CONTENT'));
  assert.match(text, /content \d+ chars/);
  assert.equal(readLog(env).length, cmds.length + 1);
});

test('redaction keeps ordinary paths, commit ids in words and the exact input_hash', () => {
  assert.equal(redact('git status docs/requirements/M7-permission-approver.md'), 'git status docs/requirements/M7-permission-approver.md');
  assert.equal(redact('ls tools/approver/test/fixtures/transcripts'), 'ls tools/approver/test/fixtures/transcripts');
  assert.equal(redact('task-list desk-lamp'), 'task-list desk-lamp');
  const hash = 'a'.repeat(64);
  const line = JSON.parse(prepareRecord({ input_hash: hash, record_id: '0'.repeat(32), reason: hash }));
  assert.equal(line.input_hash, hash);
  assert.equal(line.reason, '[REDACTED]');
});

test('caps: long input is truncated and marked; a record never exceeds 8 KiB', () => {
  const long = 'echo ' + 'word '.repeat(5000);
  const rec = JSON.parse(prepareRecord({ input_redacted: long, reason: 'r'.repeat(5000), cwd: '/c'.repeat(1000), truncated: false }));
  assert.equal(rec.truncated, true);
  assert.ok(rec.input_redacted.length < 2100);
  assert.ok(rec.reason.length < 330);
  assert.ok(Buffer.byteLength(JSON.stringify(rec)) + 1 <= MAX_RECORD_BYTES);
  assert.equal(prepareRecord({ input_redacted: 'short' }).includes('"truncated":false'), true);
});

test('permissions: log dir 0700, log file 0600', async () => {
  const env = mk();
  await runHook(env, payload(env));
  assert.equal(fs.statSync(env.logDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(env.logDir, 'decisions.jsonl')).mode & 0o777, 0o600);
});

test('concurrent appends from 20 processes give only whole, valid lines', async () => {
  const env = mk();
  const mod = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'log.mjs')).href;
  const code = `import(${JSON.stringify(mod)}).then(m=>{for(let i=0;i<50;i++)m.appendRecord(${JSON.stringify(env.logDir)},{type:'decision',n:i,pid:process.pid,input_redacted:'x'.repeat(3000)})})`;
  await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    c.on('exit', (s) => (s === 0 ? resolve() : reject(new Error('child ' + s))));
  })));
  const lines = fs.readFileSync(path.join(env.logDir, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1000);
  for (const l of lines) JSON.parse(l);
});

test('log failure never changes the decision flow (story 5.7)', async () => {
  const boom = () => { throw new Error('ENOSPC'); };
  const shadow = mk({ mode: 'shadow' });
  const r1 = await runHook(shadow, payload(shadow), { appendRecord: boom, prefilter: () => ({ decision: 'allow', rule_id: 'L-READ' }) });
  assert.equal(r1.stdout, '');
  const enf = mk({ mode: 'enforce' });
  const r2 = await runHook(enf, payload(enf), { appendRecord: boom, prefilter: () => ({ decision: 'deny', rule_id: 'D-NET' }) });
  assert.ok(r2.stdout.includes('"deny"'));
  // a real failure: the log dir path is occupied by a file
  const blocked = mk({ mode: 'shadow' });
  fs.mkdirSync(path.dirname(blocked.logDir), { recursive: true });
  fs.writeFileSync(blocked.logDir, 'not a dir');
  const r3 = await runHook(blocked, payload(blocked));
  assert.equal(r3.stdout, '');
});

test('summarizeInput never includes file content', () => {
  assert.equal(summarizeInput('Write', { file_path: '/r/a', content: 'SECRET' }), 'Write /r/a (content 6 chars)');
  assert.ok(!summarizeInput('Edit', { file_path: '/r/a', old_string: 'OLDSECRET', new_string: 'NEWSECRET' }).includes('SECRET'));
  assert.ok(!summarizeInput('NotebookEdit', { notebook_path: '/r/n', new_source: 'SECRET' }).includes('SECRET'));
  assert.equal(summarizeInput('Bash', { command: 5 }), '[not a string]');
});

test('rotate keeps recent records and drops old ones and old ledgers', () => {
  const env = mk();
  fs.mkdirSync(env.logDir, { recursive: true });
  const now = Date.parse('2026-11-04T00:00:00Z');
  const rows = [{ ts: '2026-01-01T00:00:00Z' }, { ts: '2026-10-30T00:00:00Z' }];
  fs.writeFileSync(path.join(env.logDir, 'decisions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
  fs.writeFileSync(path.join(env.logDir, 'spend-2026-01-01.jsonl'), '');
  fs.writeFileSync(path.join(env.logDir, 'spend-2026-11-03.jsonl'), '');
  const r = rotate(env.logDir, { days: 90, now });
  assert.deepEqual(r, { kept: 2, dropped: 1, ledgers: 1 });
  assert.equal(fs.existsSync(path.join(env.logDir, 'spend-2026-01-01.jsonl')), false);
  assert.equal(fs.existsSync(path.join(env.logDir, 'spend-2026-11-03.jsonl')), true);
  assert.equal(fs.statSync(path.join(env.logDir, 'decisions.jsonl')).mode & 0o777, 0o600);
});
