/**
 * The provider-call ledger: claim, settle, resolve, list, count.
 *
 * This is the D1 half of the research P0 — "model `not_submitted → submitting →
 * accepted/completed` plus `ambiguous`; persist request ID and charge certainty; never auto-retry
 * ambiguous paid timeouts without provider idempotency/reconciliation." Task 9 gave the adapter
 * `ProviderError.charged: boolean | null`; that field dies with the isolate that threw it. These
 * functions are how it survives.
 *
 * THE ORDER IS THE INVARIANT. `claimProviderCall` runs BEFORE the billable call and refuses a second
 * claim of the same identity; `settleProviderCall` runs IMMEDIATELY after it returns, before any
 * other I/O, so the provider request id is durable as early as possible. A crash anywhere between
 * the two leaves a `submitting` row, which reads as "unknown", which is the truth. Nothing here
 * ever writes `charge_certainty` from caller input: it is looked up from the state in
 * `CHARGE_CERTAINTY_BY_STATE`, and the table CHECK refuses every other pairing as the second line of
 * defence.
 *
 * Kept out of `repository.ts` (588 lines) and `queries.ts` (547) so both stay under this project's
 * ceiling; `D1TwiRepository` delegates here and adds the telemetry event.
 */

import { assertEnum, assertNonBlank, assertNullableNonBlank, assertTimestamp } from './assertions';
import { parseInputObjectJson, parseStoredObjectJson } from './canonical-json';
import type { D1DatabaseLike } from './d1-types';
import { conflict, validation } from './errors';
import {
  CANDIDATE_LABELS,
  CHARGE_CERTAINTY_BY_STATE,
  PROVIDER_CALL_RESOLUTIONS,
  PROVIDER_CALL_SETTLED_STATES,
  type ClaimProviderCallInput,
  type ClaimProviderCallResult,
  type ProviderCallIdentity,
  type ProviderCallRecord,
  type ProviderCallRow,
  type ProviderCallState,
  type ResolveProviderCallInput,
  type ResolveProviderCallResult,
  type SettleProviderCallInput,
  type SettleProviderCallResult,
} from './provider-call-types';
import { findJobById } from './queries';
import {
  countUnreconciledProviderCalls as countUnreconciledRows,
  insertProviderCallClaim,
  providerCallClaimKey,
  selectProviderCall,
  selectProviderCalls,
  updateProviderCallResolution,
  updateProviderCallSettlement,
} from './queries-provider-calls';

export function mapProviderCall(row: ProviderCallRow): ProviderCallRecord {
  return {
    jobId: row.job_id,
    attempt: row.attempt,
    label: row.label,
    claimKey: row.claim_key,
    state: row.state,
    chargeCertainty: row.charge_certainty,
    providerMode: row.provider_mode,
    provider: row.provider,
    model: row.model,
    providerRequestId: row.provider_request_id,
    detail: parseStoredObjectJson(
      row.detail_json,
      `twi_provider_calls ${row.job_id}/${row.attempt}/${row.label} detail_json`,
    ),
    claimedAt: row.claimed_at,
    settledAt: row.settled_at,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
  };
}

const validateIdentity = (field: string, identity: ProviderCallIdentity): void => {
  assertNonBlank(`${field}.jobId`, identity.jobId);
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 0) {
    validation(`${field}.attempt must be a nonnegative safe integer`, { field, attempt: identity.attempt });
  }
  assertEnum(`${field}.label`, identity.label, CANDIDATE_LABELS);
};

const identityContext = ({ jobId, attempt, label }: ProviderCallIdentity): Record<string, unknown> => ({
  jobId,
  attempt,
  label,
});

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim().length === 0;

/**
 * Writes the `submitting` row for one billable call, or finds the one already there.
 *
 * `already-claimed` returns the EXISTING row unchanged — whatever state it has reached — because
 * the caller's next question is "may I call the provider?", and the answer is no whenever any
 * row exists: a call may be in flight, may have been paid for, or may already be settled.
 */
export async function claimProviderCall(
  db: D1DatabaseLike,
  input: ClaimProviderCallInput,
): Promise<ClaimProviderCallResult> {
  validateIdentity('providerCall', input);
  assertNonBlank('providerCall.providerMode', input.providerMode);
  assertTimestamp('providerCall.now', input.now);
  const detail = parseInputObjectJson('providerCall.detailJson', input.detailJson ?? '{}');
  const state: ProviderCallState = 'submitting';
  const chargeCertainty = CHARGE_CERTAINTY_BY_STATE[state];

  let changes: number;
  try {
    const result = await insertProviderCallClaim(db, {
      ...input,
      state,
      chargeCertainty,
      detailJson: detail.canonical,
    }).run();
    changes = result.meta.changes;
  } catch (error) {
    // A foreign-key violation on `job_id` is a caller mistake, not an outage; name it.
    const job = await findJobById(db, input.jobId);
    if (!job) conflict('provider call job not found', identityContext(input), error);
    throw error;
  }

  if (changes === 1) {
    return {
      outcome: 'claimed',
      call: {
        jobId: input.jobId,
        attempt: input.attempt,
        label: input.label,
        claimKey: providerCallClaimKey(input),
        state,
        chargeCertainty,
        providerMode: input.providerMode,
        provider: null,
        model: null,
        providerRequestId: null,
        detail: detail.object,
        claimedAt: input.now,
        settledAt: null,
        resolvedAt: null,
        resolutionNote: null,
      },
    };
  }
  const existing = await selectProviderCall(db, input);
  if (!existing) conflict('provider call claim conflict', { ...identityContext(input), changes });
  return { outcome: 'already-claimed', call: mapProviderCall(existing) };
}

/**
 * Moves a `submitting` row to its settled state. The charge certainty is DERIVED from the state
 * here and nowhere else; `completed` must carry the provider's request id, refused at this
 * boundary first and by the schema second.
 */
export async function settleProviderCall(
  db: D1DatabaseLike,
  input: SettleProviderCallInput,
): Promise<SettleProviderCallResult> {
  validateIdentity('providerCall', input);
  assertEnum('providerCall.state', input.state, PROVIDER_CALL_SETTLED_STATES);
  const providerRequestId = input.providerRequestId ?? null;
  const provider = input.provider ?? null;
  const model = input.model ?? null;
  assertNullableNonBlank('providerCall.providerRequestId', providerRequestId);
  assertNullableNonBlank('providerCall.provider', provider);
  assertNullableNonBlank('providerCall.model', model);
  if (input.state === 'completed' && isBlank(providerRequestId)) {
    validation('a completed provider call requires providerRequestId', identityContext(input));
  }
  assertTimestamp('providerCall.now', input.now);
  const detailJson =
    input.detailJson === undefined ? null : parseInputObjectJson('providerCall.detailJson', input.detailJson).canonical;

  const result = await updateProviderCallSettlement(db, {
    ...input,
    chargeCertainty: CHARGE_CERTAINTY_BY_STATE[input.state],
    providerRequestId,
    provider,
    model,
    detailJson,
  }).run();
  const row = await selectProviderCall(db, input);
  if (result.meta.changes === 1) {
    if (!row) conflict('provider call settle readback conflict', identityContext(input));
    return { outcome: 'settled', call: mapProviderCall(row) };
  }
  if (!row) return { outcome: 'not-claimed', call: null };
  return { outcome: 'already-settled', call: mapProviderCall(row) };
}

/**
 * THE RECONCILIATION PRIMITIVE the P0 requires: a human, having looked at the provider's
 * account, says what happened to one call. There is no HTTP route for it yet; it is reached
 * through the repository.
 *
 * Any unresolved row may be resolved. While the charge is UNKNOWN (`submitting`, `ambiguous`)
 * `to` is REQUIRED — the point of resolving is to make the charge known, and a resolution that
 * left it unknown would unblock the retry gate without settling the money. Once the charge IS
 * known (`accepted`, `completed`, `abandoned`) `to` must be omitted: acknowledging a known charge
 * is what lets a retry proceed, and rewriting it would be exactly the laundering the table CHECK
 * exists to refuse. A blank note is a validation error. Resolving twice changes nothing.
 */
export async function resolveProviderCall(
  db: D1DatabaseLike,
  input: ResolveProviderCallInput,
): Promise<ResolveProviderCallResult> {
  validateIdentity('providerCall', input);
  assertNonBlank('providerCall.note', input.note);
  assertTimestamp('providerCall.now', input.now);
  if (input.to !== undefined) assertEnum('providerCall.to', input.to, PROVIDER_CALL_RESOLUTIONS);

  const current = await selectProviderCall(db, input);
  if (!current) return { outcome: 'not-found', call: null };
  if (current.resolved_at !== null) return { outcome: 'already-resolved', call: mapProviderCall(current) };

  const chargeUnknown = current.charge_certainty === 'unknown';
  if (chargeUnknown && input.to === undefined) {
    validation('resolving a provider call whose charge is unknown requires `to`', {
      ...identityContext(input),
      state: current.state,
    });
  }
  if (!chargeUnknown && input.to !== undefined) {
    validation('resolving a provider call whose charge is known must not change it', {
      ...identityContext(input),
      state: current.state,
      to: input.to,
    });
  }
  const nextState: ProviderCallState = input.to ?? current.state;

  const result = await updateProviderCallResolution(db, {
    ...input,
    expectedState: current.state,
    state: nextState,
    chargeCertainty: CHARGE_CERTAINTY_BY_STATE[nextState],
  }).run();
  const after = await selectProviderCall(db, input);
  if (result.meta.changes === 1) {
    if (!after) conflict('provider call resolve readback conflict', identityContext(input));
    return { outcome: 'resolved', call: mapProviderCall(after) };
  }
  // The guarded write matched nothing: the row moved between the read and the write.
  if (!after) return { outcome: 'not-found', call: null };
  if (after.resolved_at !== null) return { outcome: 'already-resolved', call: mapProviderCall(after) };
  return conflict('provider call resolution precondition failed', {
    ...identityContext(input),
    expectedState: current.state,
    observedState: after.state,
  });
}

/** Every call of one job, ordered by (attempt, label). The retry gate's read. */
export async function listProviderCalls(db: D1DatabaseLike, jobId: string): Promise<ProviderCallRecord[]> {
  assertNonBlank('jobId', jobId);
  const result = await selectProviderCalls(db, jobId);
  return result.results.map(mapProviderCall);
}

/** The estate-wide inventory. Read-only; see `countUnreconciledProviderCalls` in the queries module. */
export const countUnreconciledProviderCalls = (db: D1DatabaseLike): Promise<number> => countUnreconciledRows(db);
