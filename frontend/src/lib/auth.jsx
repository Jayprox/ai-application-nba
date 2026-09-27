import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { login as apiLogin, logout as apiLogout, onSessionChange, readSession, usernameOf } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(readSession);
  // Follows sign-in/out and token rotation in this tab AND other tabs.
  useEffect(() => onSessionChange(setSession), []);
  const value = {
    signedIn: !!session,
    username: session ? usernameOf(session) : null,
    login: async (u, p) => setSession(await apiLogin(u, p)),
    logout: async () => { await apiLogout(); setSession(null); },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

export function RequireAuth({ children }) {
  const { signedIn } = useAuth();
  const location = useLocation();
  if (!signedIn) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}
