import { render, screen } from '@testing-library/react';
import React from 'react';
import { vi } from 'vitest';
import { App } from './App';

const originalFetch = globalThis.fetch;

test('shows the TWI identity while owner auth is checked', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  render(<App />);
  expect(screen.getByRole('heading', { name: 'TWI Research Center' })).toBeInTheDocument();
  expect(screen.getByText('Verifying private access…')).toBeInTheDocument();
});

test('restores the fetch global after a test stub', () => {
  expect(globalThis.fetch).toBe(originalFetch);
});
