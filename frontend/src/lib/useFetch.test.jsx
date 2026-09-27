// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useFetch } from './useFetch.js';

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

// Renders the hook and records every value it returned, render by render.
function harness() {
  const seen = [];
  const pending = {};
  function Probe({ k }) {
    const r = useFetch(k, () => { pending[k] = deferred(); return pending[k].p; });
    seen.push({ k, ...r });
    return null;
  }
  return { seen, pending, Probe };
}

describe('useFetch (PLATFORM.md stale-async-state rule)', () => {
  it('never returns the previous key\'s data on the render where the key changes', async () => {
    const { seen, pending, Probe } = harness();
    const { rerender } = render(<Probe k="a" />);
    await act(async () => pending.a.resolve({ shape: 'A' }));
    expect(seen.at(-1)).toMatchObject({ k: 'a', data: { shape: 'A' }, loading: false });

    rerender(<Probe k="b" />);                       // new key, before any refetch resolves
    const firstB = seen.find((s) => s.k === 'b');
    expect(firstB.data).toBeUndefined();
    expect(firstB.loading).toBe(true);
    expect(seen.filter((s) => s.k === 'b').every((s) => s.data?.shape !== 'A')).toBe(true);

    await act(async () => pending.b.resolve({ shape: 'B' }));
    expect(seen.at(-1)).toMatchObject({ k: 'b', data: { shape: 'B' }, loading: false });
  });

  it('drops an out-of-order response from an older key', async () => {
    const { seen, pending, Probe } = harness();
    const { rerender } = render(<Probe k="old" />);
    const oldReq = pending.old;
    rerender(<Probe k="new" />);
    await act(async () => pending.new.resolve('NEW'));
    await act(async () => oldReq.resolve('OLD'));   // lands late
    expect(seen.at(-1)).toMatchObject({ k: 'new', data: 'NEW' });
    expect(seen.some((s) => s.k === 'new' && s.data === 'OLD')).toBe(false);
  });

  it('surfaces errors for the current key only, and retry refetches', async () => {
    const { seen, pending, Probe } = harness();
    render(<Probe k="x" />);
    await act(async () => pending.x.resolve(Promise.reject(new Error('boom'))));
    expect(seen.at(-1).error.message).toBe('boom');
    await act(async () => seen.at(-1).retry());
    expect(seen.at(-1)).toMatchObject({ loading: true, error: null });
    await act(async () => pending.x.resolve('ok'));
    expect(seen.at(-1)).toMatchObject({ data: 'ok', loading: false });
  });

  it('null key = idle, no fetch', () => {
    const { seen, pending, Probe } = harness();
    render(<Probe k={null} />);
    expect(seen.at(-1)).toMatchObject({ data: undefined, loading: false });
    expect(Object.keys(pending)).toHaveLength(0);
  });
});
