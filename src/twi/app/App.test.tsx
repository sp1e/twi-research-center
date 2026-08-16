import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from './App';

const originalFetch = globalThis.fetch;

/**
 * These tests exist because the first version of this suite asserted only the 'checking'
 * state, which meant deleting the auth effect entirely, inverting the branch into a
 * fail-OPEN, dropping `credentials`, or removing the `.catch` all kept it green. Every test
 * below was verified to fail against at least one of those four mutations — keep it that
 * way. The denial copy is the return link, because a locked-out owner must be given a way
 * back to authenticate rather than a dead spinner.
 */

const RESPONSE = 'Creation Core ready.';
const RETURN_LINK = 'Return to SP1E to authenticate';

/** Stubs fetch with a settled response and hands back the spy for call assertions. */
function stubFetch(response: unknown) {
  const spy = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const authResponse = (authenticated: boolean) => ({
  ok: true,
  json: async () => ({ authenticated }),
});

test('shows the TWI identity while owner auth is checked', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<App />);
  expect(screen.getByRole('heading', { name: 'TWI Research Center' })).toBeInTheDocument();
  expect(screen.getByText('Verifying private access…')).toBeInTheDocument();
});

test('reaches the allowed state when the owner session is valid', async () => {
  stubFetch(authResponse(true));
  render(<App />);
  expect(await screen.findByText(RESPONSE)).toBeInTheDocument();
  expect(screen.queryByText(RETURN_LINK)).not.toBeInTheDocument();
});

test('denies access when the session check reports authenticated: false', async () => {
  stubFetch(authResponse(false));
  render(<App />);
  expect(await screen.findByRole('link', { name: RETURN_LINK })).toHaveAttribute('href', '/');
  expect(screen.queryByText(RESPONSE)).not.toBeInTheDocument();
});

test('denies access when the check responds non-ok', async () => {
  stubFetch({ ok: false, json: async () => ({ authenticated: true }) });
  render(<App />);
  expect(await screen.findByRole('link', { name: RETURN_LINK })).toBeInTheDocument();
  expect(screen.queryByText(RESPONSE)).not.toBeInTheDocument();
});

test('denies access — never hangs on the spinner — when the check rejects', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  render(<App />);
  expect(await screen.findByRole('link', { name: RETURN_LINK })).toBeInTheDocument();
  expect(screen.queryByText('Verifying private access…')).not.toBeInTheDocument();
});

test('denies access when the body is not JSON', async () => {
  stubFetch({ ok: true, json: async () => { throw new SyntaxError('not json'); } });
  render(<App />);
  expect(await screen.findByRole('link', { name: RETURN_LINK })).toBeInTheDocument();
});

test('asks /api/auth/check for the session and sends the session cookie', async () => {
  const spy = stubFetch(authResponse(true));
  render(<App />);
  await screen.findByText(RESPONSE);
  expect(spy).toHaveBeenCalledTimes(1);
  const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/auth/check');
  // Without same-origin credentials the session cookie is not attached and every owner is
  // silently locked out in production, while a cookie-free test stub stays green.
  expect(init?.credentials).toBe('same-origin');
});

test('restores the fetch global after a test stub', () => {
  expect(globalThis.fetch).toBe(originalFetch);
});
