import { describe, expect, it } from 'vitest';

import {
  CALLBACK_REPLAY_WINDOW_MS,
  assertCallbackAuthentic,
  isFreshCallbackTimestamp,
  isOpaqueToken,
  secretsMatch,
} from './callback-auth';

const SECRET = 'a-long-random-shared-secret-value';
const NOW = Date.parse('2026-08-30T10:00:00.000Z');

describe('secretsMatch', () => {
  it('accepts the exact secret', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
  });

  it('refuses a wrong secret of the same length', () => {
    expect(secretsMatch(`${SECRET.slice(0, -1)}X`, SECRET)).toBe(false);
  });

  it('refuses a prefix of the secret rather than accepting it', () => {
    expect(secretsMatch(SECRET.slice(0, 10), SECRET)).toBe(false);
  });

  it('refuses a missing header', () => {
    expect(secretsMatch(null, SECRET)).toBe(false);
  });

  it('refuses when the deployment has no secret configured, rather than matching a blank one', () => {
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch(null, '')).toBe(false);
  });
});

describe('isFreshCallbackTimestamp', () => {
  it('accepts a timestamp inside the replay window', () => {
    expect(isFreshCallbackTimestamp('2026-08-30T09:58:00.000Z', NOW)).toBe(true);
  });

  it('refuses a timestamp older than the replay window', () => {
    expect(isFreshCallbackTimestamp('2026-08-30T09:00:00.000Z', NOW)).toBe(false);
  });

  it('refuses a timestamp from the future beyond the window', () => {
    expect(isFreshCallbackTimestamp('2026-08-30T11:00:00.000Z', NOW)).toBe(false);
  });

  it('refuses anything that is not a JS-generated YYYY-MM-DDTHH:MM:SS.sssZ instant', () => {
    for (const value of ['2026-08-30 10:00:00', '2026-08-30T10:00:00Z', 'now', '', String(NOW)]) {
      expect(isFreshCallbackTimestamp(value, NOW)).toBe(false);
    }
  });

  it('has a replay window measured in minutes, not hours', () => {
    expect(CALLBACK_REPLAY_WINDOW_MS).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(CALLBACK_REPLAY_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe('isOpaqueToken', () => {
  it('accepts a UUID-shaped token', () => {
    expect(isOpaqueToken('55555555-5555-4555-8555-555555555555')).toBe(true);
  });

  it('refuses a blank, short or oversized token', () => {
    expect(isOpaqueToken('')).toBe(false);
    expect(isOpaqueToken('   ')).toBe(false);
    expect(isOpaqueToken('short')).toBe(false);
    expect(isOpaqueToken('x'.repeat(200))).toBe(false);
  });

  it('refuses a token carrying characters that are not opaque-token characters', () => {
    expect(isOpaqueToken('55555555-5555-4555-8555-5555555555 55')).toBe(false);
    expect(isOpaqueToken("55555555'--")).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isOpaqueToken(undefined)).toBe(false);
    expect(isOpaqueToken(42)).toBe(false);
  });
});

describe('assertCallbackAuthentic', () => {
  const good = {
    presentedSecret: SECRET,
    expectedSecret: SECRET,
    timestamp: '2026-08-30T09:59:30.000Z',
    nonce: '66666666-6666-4666-8666-666666666666',
    callbackId: '55555555-5555-4555-8555-555555555555',
    now: NOW,
  };

  it('accepts a callback that satisfies every requirement at once', () => {
    expect(() => assertCallbackAuthentic(good)).not.toThrow();
  });

  it('refuses a wrong secret', () => {
    expect(() => assertCallbackAuthentic({ ...good, presentedSecret: 'wrong' })).toThrow('callback_unauthorized');
  });

  it('refuses a stale timestamp even when the secret is right', () => {
    expect(() => assertCallbackAuthentic({ ...good, timestamp: '2026-08-30T08:00:00.000Z' }))
      .toThrow('callback_stale');
  });

  it('refuses a missing nonce even when the secret and timestamp are right', () => {
    expect(() => assertCallbackAuthentic({ ...good, nonce: '' })).toThrow('callback_unidentified');
  });

  it('refuses a missing callback id even when everything else is right', () => {
    expect(() => assertCallbackAuthentic({ ...good, callbackId: '' })).toThrow('callback_unidentified');
  });

  it('refuses a nonce that equals the callback id, which would make one of them decorative', () => {
    expect(() => assertCallbackAuthentic({ ...good, nonce: good.callbackId })).toThrow('callback_unidentified');
  });
});
