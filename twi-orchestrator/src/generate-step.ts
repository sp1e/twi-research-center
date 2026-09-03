import { NonRetryableError } from 'cloudflare:workflows';

import type { GenerationSpec } from '../../src/twi/domain/types';
import type {
  ClaimProviderCallInput,
  ClaimProviderCallResult,
  ProviderCallIdentity,
  ProviderCallSettledState,
  SettleProviderCallInput,
  SettleProviderCallResult,
} from '../../src/twi/server/provider-call-types';
import { assetId, objectPrefix, sha256Hex, type CandidateIdentity, type RawCandidateManifest } from './candidate-manifest';
import { ProviderError } from './providers/lyria';
import { mustNotRetry } from './providers/select';
import type { CandidateLabel, MusicProvider, ProviderCandidate } from './providers/types';

/**
 * The body of the `generate-<label>` Workflow step, as a function of its dependencies.
 *
 * WHY IT IS A FUNCTION AND NOT A STEP BODY. This is the ONE place in the system that spends the
 * owner's money, and the research P0 demands an order inside it that no happy-path test can see:
 * the claim must be written BEFORE the provider is called, and the settlement IMMEDIATELY after
 * it returns. A unit test can record the order of calls against doubles; a step body inside the
 * Workflow class cannot be called without the Workflow engine. Section 16 of the contract check
 * then proves the Workflow still CALLS this function inside the step -- a unit test proves the
 * predicate, only the call graph proves the call.
 *
 * THE ORDER, and why each line is where it is:
 *
 *   1. `claimProviderCall` -- the `submitting` row, before ANY other I/O. If the claim is
 *      `already-claimed`, refuse WITHOUT calling the provider. This is the CF-2 defence: an
 *      evicted isolate re-runs an incomplete step body, and with nothing in D1 the re-run would
 *      pay again. With the row there, the re-run finds its own claim and stops.
 *   2. `provider.generate` -- the billable call.
 *   3. `settleProviderCall` -- immediately on return, before hashing, before the R2 put, so the
 *      provider request id is durable as early as possible. On a ProviderError the row is settled
 *      by what the adapter can PROVE about the money (`charged`): false -> abandoned, true ->
 *      accepted, null -> ambiguous. On any other error NOTHING is settled -- the row stays
 *      `submitting`, which reads as an unknown charge, which is the truth.
 *
 * A settlement failure never masks the original provider failure and is never swallowed: it is
 * carried as the rethrown error's `cause`. A settlement failure after a SUCCESSFUL call fails the
 * step -- the row stays `submitting`, and the retry gate holds.
 */

export const PROVIDER_CALL_ALREADY_CLAIMED = 'provider_call_already_claimed';

/** The two ledger writes the step needs. `TwiWorkflowStore` satisfies it; a test can too. */
export interface GenerateStepStore {
  claimProviderCall(input: ClaimProviderCallInput): Promise<ClaimProviderCallResult>;
  settleProviderCall(input: SettleProviderCallInput): Promise<SettleProviderCallResult>;
}

export interface GenerateStepInput {
  store: GenerateStepStore;
  provider: MusicProvider;
  /** `TWI_PROVIDER_MODE`, known before the call and recorded on the claim. */
  providerMode: string;
  payload: CandidateIdentity;
  spec: GenerationSpec;
  label: CandidateLabel;
  files: Pick<R2Bucket, 'put'>;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. The Workflow's event timestamp. */
  now: string;
}

/**
 * A terminal error the engine will not retry. The NAME alone does not survive the RPC hop into
 * miniflare's binding worker, so the MESSAGE carries the marker too -- the engine accepts either
 * (`name === 'NonRetryableError' || message.startsWith('NonRetryableError')`).
 */
const nonRetryable = (code: string): NonRetryableError => new NonRetryableError(`NonRetryableError: ${code}`);

/** What the adapter proved about the money, as the state the row settles into. */
const settledStateFor = (charged: boolean | null): ProviderCallSettledState => {
  if (charged === false) return 'abandoned';
  if (charged === true) return 'accepted';
  return 'ambiguous';
};

/**
 * Settles a failed call by its `charged` field. Returns the settlement's OWN failure, if any,
 * rather than throwing it, so the caller can rethrow the provider error with this attached.
 */
const settleProviderFailure = async (
  store: GenerateStepStore,
  identity: ProviderCallIdentity,
  error: ProviderError,
  now: string,
): Promise<unknown> => {
  try {
    await store.settleProviderCall({
      ...identity,
      state: settledStateFor(error.charged),
      now,
      detailJson: JSON.stringify({ schemaVersion: 1, code: error.code, charged: error.charged }),
    });
    return null;
  } catch (settleError) {
    return settleError;
  }
};

export async function runGenerateStep(input: GenerateStepInput): Promise<RawCandidateManifest> {
  const { store, provider, providerMode, payload, spec, label, files, now } = input;
  const identity: ProviderCallIdentity = { jobId: payload.jobId, attempt: payload.attempt, label };

  // 1. The claim. Nothing -- not the provider, not R2, not a hash -- runs before this returns.
  const claim = await store.claimProviderCall({
    ...identity,
    providerMode,
    now,
    detailJson: JSON.stringify({ schemaVersion: 1, projectId: payload.projectId }),
  });
  if (claim.outcome === 'already-claimed') throw nonRetryable(PROVIDER_CALL_ALREADY_CLAIMED);

  // 2. The billable call.
  let candidate: ProviderCandidate;
  try {
    candidate = await provider.generate(spec, label);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const settleFailure = await settleProviderFailure(store, identity, error, now);
    // The same promotion callProvider made before this module existed: a ProviderError that might
    // already have been paid for must not be retried by the step policy.
    const rethrown: Error = mustNotRetry(error) ? new NonRetryableError(error.code) : error;
    if (settleFailure !== null) rethrown.cause = settleFailure;
    throw rethrown;
  }

  // 3. The settlement, before any other I/O. A failure here fails the step; the row stays submitting.
  const settled = await store.settleProviderCall({
    ...identity,
    state: 'completed',
    providerRequestId: candidate.providerRequestId,
    provider: candidate.provider,
    model: candidate.model,
    now,
  });
  if (settled.outcome !== 'settled') {
    throw new Error(`provider call settlement was ${settled.outcome}, so the candidate cannot be recorded against its charge`);
  }

  const prefix = objectPrefix(payload, label);
  const key = `${prefix}/raw.wav`;
  const provenanceKey = `${prefix}/provenance.json`;
  const sha256 = await sha256Hex(candidate.bytes);
  await files.put(key, candidate.bytes, {
    httpMetadata: { contentType: candidate.contentType },
    customMetadata: {
      provider: candidate.provider,
      model: candidate.model,
      providerRequestId: candidate.providerRequestId,
    },
  });
  return {
    id: assetId(payload, label, 'raw'),
    key,
    contentType: candidate.contentType,
    sizeBytes: candidate.bytes.byteLength,
    sha256,
    durationSeconds: candidate.durationSeconds,
    label,
    provider: candidate.provider,
    model: candidate.model,
    providerCostUsd: candidate.providerCostUsd,
    providerRequestId: candidate.providerRequestId,
    provenanceKey,
  };
}
