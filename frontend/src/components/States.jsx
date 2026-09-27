// Shared loading / error / empty blocks so every screen handles all three.
import { ApiError } from '../lib/api.js';

export function Loading({ label = 'Loading…' }) {
  return <div role="status" className="rounded-[10px] border border-line bg-card p-6 text-[15px] text-muted">{label}</div>;
}

export function ErrorBox({ error, onRetry }) {
  const msg = error instanceof ApiError && error.status === 404 ? 'Not found.'
    : error instanceof ApiError && error.status >= 500 ? 'The server hit an error. Try again in a moment.'
    : error instanceof TypeError ? "Can't reach the server. Check your connection."
    : error?.message ?? 'Something went wrong.';
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-accent/40 bg-card p-5 text-[15px]">
      <span>{msg}</span>
      {onRetry && <button type="button" onClick={onRetry} className="h-10 cursor-pointer rounded-lg border border-field bg-card px-4 font-medium hover:border-ink">Try again</button>}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="rounded-[10px] border border-dashed border-field bg-card p-6 text-[15px]">{children}</div>;
}
