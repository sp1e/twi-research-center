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
 * Which modes this build can carry all the way to a published pair, and under what conditions.
 *
 * The rule this enforces has not changed: never buy a render this build cannot finish. What
 * changed in Task 11 is WHY a render might be unfinishable. Finishing used to be the fake
 * in-Worker path, so `lyria` was refused unconditionally and the code said so by name
 * (`finishing_not_implemented`). Finishing is now a real Modal job that takes `raw.wav` from
 * R2 and is indifferent to which provider produced it, so `lyria` belongs in this set --
 * BUT ONLY when Modal finishing is actually configured. A deployment with no
 * TWI_MODAL_FINISH_URL, no callback origin or no shared secret can finish NOTHING, whatever
 * its provider mode says, and must refuse before the first billable call rather than after it.
 *
 * That is why the second argument is required rather than optional: an accidental
 * `canCompleteRender(mode)` would answer "yes" for an unconfigured deployment, which is
 * exactly the answer that costs money.
 */
const FINISHABLE_MODES: ReadonlySet<string> = new Set(['fake', 'lyria']);

export const canCompleteRender = (mode: string | undefined, finishing: unknown): boolean =>
  finishing !== null && finishing !== undefined && FINISHABLE_MODES.has(mode ?? '');
