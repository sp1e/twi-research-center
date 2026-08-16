/**
 * Renders through main.tsx — the real entry point — rather than mounting <App /> directly.
 *
 * Two things only this file can catch. First, main.tsx writes JSX with NO `import React`,
 * which is correct under the automatic runtime the build emits and a ReferenceError under
 * the classic transform; if the test config ever drifts back to classic (see the comment in
 * vitest.twi.config.ts) this test fails instead of the divergence going unnoticed until
 * production. Second, the mount contract itself: the app must actually attach to #root,
 * which src/twi/index.html provides.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

test('main.tsx mounts the shell into #root using the shipped JSX transform', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);

  await act(async () => {
    await import('./main');
  });

  expect(root.querySelector('h1')?.textContent).toBe('TWI Research Center');
  expect(root.querySelector('.twi-mark')?.textContent).toBe('TWI');
});
