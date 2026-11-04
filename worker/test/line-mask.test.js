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
