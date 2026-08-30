import { DeterministicFakeMusicProvider } from './fake';
import { LyriaMusicProvider, ProviderError } from './lyria';
import type { MusicProvider } from './types';

export interface ProviderConfig {
  mode?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

const isPresent = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/*
 * The only way to get a provider is to name one. An absent, blank or unrecognised mode
 * returns null so a deployment that was never configured refuses work instead of quietly
 * choosing a billable default -- and `fake` has to be asked for by name, never inferred.
 */
export const createProvider = ({ mode, apiKey, fetchImpl }: ProviderConfig): MusicProvider | null => {
  if (mode === 'fake') return new DeterministicFakeMusicProvider();
  if (mode === 'lyria' && isPresent(apiKey)) {
    return new LyriaMusicProvider({ apiKey, fetchImpl: fetchImpl ?? fetch });
  }
  return null;
};

/*
 * A step's retry policy exists to survive transient failures, so anything that is not a
 * ProviderError keeps it. A ProviderError is retryable ONLY when the adapter can prove the
 * money path was never entered; ambiguity resolves toward not paying twice.
 */
export const mustNotRetry = (error: unknown): boolean => {
  if (!(error instanceof ProviderError)) return false;
  return !(error.code === 'provider_unavailable' && error.charged === false);
};

/*
 * Which modes this build can carry all the way to a published pair. Finishing is still the
 * fake in-Worker path (Tasks 10-11 replace it with Modal), so a PAID render would generate,
 * bill, and then fail at `finish`. Refusing before the first call is the money-path rule:
 * never buy a render this build cannot finish. Task 11 adds 'lyria' here.
 */
const FINISHABLE_MODES: ReadonlySet<string> = new Set(['fake']);

export const canCompleteRender = (mode?: string): boolean => FINISHABLE_MODES.has(mode ?? '');
