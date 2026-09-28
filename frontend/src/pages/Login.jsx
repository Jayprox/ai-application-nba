import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../lib/auth.jsx';

export default function Login() {
  const { signedIn, login } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (signedIn) return <Navigate to={location.state?.from ?? '/'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await login(username.trim(), password); }
    catch (err) {
      setError(err.status === 401 ? 'Wrong username or password.'
        : err.status === 429 ? 'Too many failed attempts. Wait 15 minutes, then try again.'
        : err.status ? 'Sign-in failed. Try again.' : "Can't reach the server.");
      setBusy(false);
    }
  }

  const field = 'h-11 rounded-lg border border-field bg-card px-3 text-base';
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <form onSubmit={submit} className="flex w-full max-w-[400px] flex-col gap-5 rounded-[14px] border border-line bg-card p-8 sm:p-10">
        <div className="text-center font-display text-3xl font-bold tracking-[0.04em]">CHALK THAT <span className="text-nav-accent">NBA</span></div>
        <h1 className="m-0 text-center text-xl font-semibold">Sign in</h1>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">Username
          <input className={field} autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">Password
          <input className={field} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="m-0 text-sm font-medium text-accent">{error}</p>}
        <button type="submit" disabled={busy} className="h-12 cursor-pointer rounded-lg bg-accent text-base font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-wait disabled:opacity-70">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
