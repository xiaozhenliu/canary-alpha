import { useState, useEffect, type ReactNode } from 'react';
import { hasAuthToken, setAuthToken, api } from '../lib/api-client';

export function TokenGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(hasAuthToken());
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const handler = () => setAuthenticated(false);
    window.addEventListener('auth-required', handler);
    return () => window.removeEventListener('auth-required', handler);
  }, []);

  const handleSubmit = async () => {
    setAuthToken(token);
    try {
      await api('/status');
      setAuthenticated(true);
      setError('');
    } catch {
      setError('Invalid token');
      setAuthToken('');
    }
  };

  if (authenticated) return <>{children}</>;

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="border border-border rounded-lg p-8 max-w-sm w-full">
        <h1 className="text-lg font-semibold mb-1 font-mono">canary-alpha-mcp</h1>
        <p className="text-xs text-muted-foreground mb-6">Enter your server auth token to continue.</p>
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          placeholder="Bearer token"
          className="w-full bg-transparent border border-border rounded px-3 py-2 text-sm outline-none focus:border-foreground mb-3"
          autoFocus
        />
        {error && <div className="text-xs text-destructive mb-3">{error}</div>}
        <button
          onClick={handleSubmit}
          className="w-full px-3 py-2 text-sm bg-foreground text-background rounded hover:opacity-90"
        >
          Connect
        </button>
      </div>
    </div>
  );
}
