import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineMasker } from '../src/line-mask.js';

const KEY = 'test-key-DO-NOT-LOG-abcdef0123456789';
const run = (chunks) => { const out = []; const m = createLineMasker(KEY, (t) => out.push(t)); for (const c of chunks) m.push(c); m.flush(); return out.join(''); };

test('a key split across two writes is masked', () => {
  const out = run(['hello test-key-DO-NO', 'T-LOG-abcdef0123456789 world\n']);
  assert.ok(!out.includes(KEY) && !out.includes('abcdef0123456789'));
  assert.equal(out, 'hello [redacted] world\n');
});
test('a key split over three writes, and text without a newline, is masked on flush', () => {
  assert.equal(run(['x test-key-', 'DO-NOT-LOG', '-abcdef0123456789']), 'x [redacted]');
});
test('a key in one write, buffers and Buffers work, other text passes unchanged', () => {
  assert.equal(run([`a ${KEY}\n`, Buffer.from('plain\n')]), 'a [redacted]\nplain\n');
});
test('very long output without newlines stays bounded and never leaks a key at the cut', () => {
  const big = 'y'.repeat(70000);
  const out = run([big + KEY.slice(0, 10), KEY.slice(10) + 'tail']);
  assert.ok(!out.includes(KEY));
});
test('no key (or a short one) leaves text as is', () => {
  const out = []; const m = createLineMasker('', (t) => out.push(t)); m.push('abc\n'); m.flush();
  assert.equal(out.join(''), 'abc\n');
});

test('C4: key straddling the 64 KiB cut is never printed', () => {
  for (const pad of [65536 - 20, 65536 - 5, 65536 - 36, 65536]) {
    const out = run(['y'.repeat(pad) + KEY + 'zzz']);
    assert.ok(!out.includes(KEY) && !out.includes('abcdef0123456789'), `pad ${pad}`);
    assert.ok(out.includes('[redacted]'));
  }
});
test('C4: 70,000 chars + key + zzz in one write, and a key fully inside the overflowed part', () => {
  const a = run(['y'.repeat(70000) + KEY + 'zzz']);
  assert.ok(!a.includes(KEY));
  const b = run(['y'.repeat(100) + KEY + 'y'.repeat(70000)]);
  assert.ok(!b.includes(KEY));
  assert.equal(b.split('[redacted]').length, 2);
});
test('C4: a key split over the overflow boundary across two writes is still masked', () => {
  const out = run(['y'.repeat(70000) + KEY.slice(0, 12), KEY.slice(12) + '\n']);
  assert.ok(!out.includes(KEY));
});
test('R3-3: endLine terminates pending unterminated text so the next write starts on a fresh line', () => {
  const out = []; const m = createLineMasker(KEY, (t) => out.push(t));
  m.push('partial ' + KEY.slice(0, 8)); m.endLine(); m.push('@@WEEKLY {}\n'); m.flush();
  const text = out.join('');
  assert.ok(text.split('\n').includes('@@WEEKLY {}'));
  assert.ok(!text.includes(KEY));
});
