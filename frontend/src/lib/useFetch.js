import { useCallback, useEffect, useRef, useState } from 'react';

// Shared fetch hook — PLATFORM.md §2 "stale-async-state" rule, from the
// Chalk That NFL crash:
//  1. Which key the data belongs to is STATE, and staleness is computed
//     during render (`isStale = key !== state.key`). React can render with a
//     new key before the refetch effect runs; on that render we return
//     `data: undefined` + `loading: true`, never the previous key's data
//     (which may have a different shape: a crash, not just a flash).
//  2. Out-of-order responses are dropped with a "latest key" ref that is only
//     WRITTEN in a dependency-less effect, never in the render body.
//
// `key` is any string that identifies the request (null = don't fetch).
// `fetcher(signal)` does the request; it should use the values in `key`.
export function useFetch(key, fetcher) {
  const [state, setState] = useState({ key: null, data: undefined, error: null });
  const [attempt, setAttempt] = useState(0);
  const fullKey = key == null ? null : `${key}#${attempt}`;

  const latestKey = useRef(fullKey);
  const fetcherRef = useRef(fetcher);
  useEffect(() => { latestKey.current = fullKey; fetcherRef.current = fetcher; });

  useEffect(() => {
    if (fullKey == null) return undefined;
    const ctl = new AbortController();
    fetcherRef.current(ctl.signal).then(
      (data) => { if (!ctl.signal.aborted && latestKey.current === fullKey) setState({ key: fullKey, data, error: null }); },
      (error) => { if (!ctl.signal.aborted && latestKey.current === fullKey) setState({ key: fullKey, data: undefined, error }); },
    );
    return () => ctl.abort();
  }, [fullKey]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const isStale = fullKey !== state.key;
  return {
    data: isStale ? undefined : state.data,
    error: isStale ? null : state.error,
    loading: fullKey != null && isStale,
    retry,
  };
}
