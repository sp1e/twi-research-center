import { describe, expect, it } from 'vitest';

import { DeterministicFakeMusicProvider } from './fake';
import { LyriaMusicProvider, ProviderError } from './lyria';
import { canCompleteRender, createProvider, mustNotRetry } from './select';

const fetchImpl = (async () => new Response('{}')) as unknown as typeof fetch;

describe('createProvider', () => {
  it('refuses to configure a provider when no mode is set, so deployment fails closed', () => {
    expect(createProvider({ fetchImpl })).toBeNull();
  });

  it('refuses an unrecognised mode rather than falling back to something billable', () => {
    expect(createProvider({ mode: 'lyra', apiKey: 'k', fetchImpl })).toBeNull();
  });

  it('builds the deterministic fake only when fake mode is named explicitly', () => {
    expect(createProvider({ mode: 'fake', fetchImpl })).toBeInstanceOf(DeterministicFakeMusicProvider);
  });

  it('refuses lyria mode without an api key instead of calling an unauthenticated endpoint', () => {
    expect(createProvider({ mode: 'lyria', fetchImpl })).toBeNull();
    expect(createProvider({ mode: 'lyria', apiKey: '   ', fetchImpl })).toBeNull();
  });

  it('builds the lyria adapter when the mode and the key are both present', () => {
    expect(createProvider({ mode: 'lyria', apiKey: 'k', fetchImpl })).toBeInstanceOf(LyriaMusicProvider);
  });
});

describe('mustNotRetry', () => {
  it('allows a retry only when the provider says the money path was never entered', () => {
    expect(mustNotRetry(new ProviderError('provider_unavailable', 'rate limited', false))).toBe(false);
  });

  it('forbids retrying an ambiguous call, which is the one that can pay twice', () => {
    expect(mustNotRetry(new ProviderError('provider_unavailable', 'server error', null))).toBe(true);
  });

  it('forbids retrying a call that certainly billed', () => {
    expect(mustNotRetry(new ProviderError('provider_invalid_audio', 'no audio', true))).toBe(true);
  });

  it.each([
    ['provider_rejected', false],
    ['provider_capability_mismatch', false],
  ] as const)('forbids retrying the deterministic failure %s', (code, charged) => {
    expect(mustNotRetry(new ProviderError(code, 'no', charged))).toBe(true);
  });

  it('leaves unrelated failures to the step retry policy they were written for', () => {
    expect(mustNotRetry(new Error('D1 read failed'))).toBe(false);
  });
});

describe('canCompleteRender', () => {
  const finishing = { finishUrl: 'https://m/finish/jobs', callbackOrigin: 'https://o', secret: 's' };

  it('reports that a configured deployment can finish the fake mode', () => {
    expect(canCompleteRender('fake', finishing)).toBe(true);
  });

  it('reports that a configured deployment can now finish a paid render — Task 11 wired Modal in', () => {
    expect(canCompleteRender('lyria', finishing)).toBe(true);
  });

  it('refuses EVERY mode when Modal finishing is not configured, so no render is bought that cannot be finished', () => {
    expect(canCompleteRender('fake', null)).toBe(false);
    expect(canCompleteRender('lyria', null)).toBe(false);
    expect(canCompleteRender('lyria', undefined)).toBe(false);
  });

  it('still refuses an unnamed or unrecognised mode even when finishing is configured', () => {
    expect(canCompleteRender(undefined, finishing)).toBe(false);
    expect(canCompleteRender('lyra', finishing)).toBe(false);
  });
});
