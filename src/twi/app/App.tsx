import React, { useEffect, useState } from 'react';

type AuthState = 'checking' | 'allowed' | 'denied';

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    fetch('/api/auth/check', { credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : { authenticated: false })
      .then((body: { authenticated?: boolean }) => setAuth(body.authenticated ? 'allowed' : 'denied'))
      .catch(() => setAuth('denied'));
  }, []);

  return (
    <main className="twi-shell">
      <header className="twi-header"><span className="twi-mark">TWI</span></header>
      <section className="twi-entry">
        <p className="twi-kicker">Private audio research environment</p>
        <h1>TWI Research Center</h1>
        {auth === 'checking' && <p>Verifying private access…</p>}
        {auth === 'denied' && <a href="/">Return to SP1E to authenticate</a>}
        {auth === 'allowed' && <p>Creation Core ready.</p>}
      </section>
    </main>
  );
}
