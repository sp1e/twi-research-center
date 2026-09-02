import type { CandidateLabel } from './repository-types';

/**
 * The persisted state of ONE billable provider call — the research P0's
 * `not_submitted → submitting → accepted/completed` plus `ambiguous`, with the request id
 * and the charge certainty made durable.
 *
 * `not_submitted` is deliberately NOT a member of {@link ProviderCallState}. It is the word a
 * READER uses for the absence of a row, and it means "no call was recorded" — never "not
 * charged". That reading is sound only because the row is written BEFORE the billable call
 * (`claimProviderCall`), so absence can only mean the call was never attempted.
 */
export type ProviderCallState = 'submitting' | 'accepted' | 'completed' | 'ambiguous' | 'abandoned';

/** The states a call can be settled INTO. `submitting` is where a claim starts, never where it goes. */
export type ProviderCallSettledState = Exclude<ProviderCallState, 'submitting'>;

/** What a human may resolve an unresolved call TO. Both make the charge known. */
export type ProviderCallResolution = 'accepted' | 'abandoned';

export type ChargeCertainty = 'unknown' | 'charged' | 'not_charged';

/** The two candidates a render produces; `twi_provider_calls.label` is CHECKed to exactly these. */
export const CANDIDATE_LABELS: readonly CandidateLabel[] = ['A', 'B'];

export const PROVIDER_CALL_STATES: readonly ProviderCallState[] = [
  'submitting',
  'accepted',
  'completed',
  'ambiguous',
  'abandoned',
];

export const PROVIDER_CALL_SETTLED_STATES: readonly ProviderCallSettledState[] = [
  'accepted',
  'completed',
  'ambiguous',
  'abandoned',
];

export const PROVIDER_CALL_RESOLUTIONS: readonly ProviderCallResolution[] = ['accepted', 'abandoned'];

export const CHARGE_CERTAINTIES: readonly ChargeCertainty[] = ['unknown', 'charged', 'not_charged'];

/**
 * THE ONE PLACE the charge certainty is derived from the state. No caller passes a certainty
 * in; every writer looks it up here, and the table CHECK `twi_provider_calls_state_certainty`
 * refuses any pair this map does not produce. Exhaustive by type: adding a state without a
 * certainty is a compile error.
 */
export const CHARGE_CERTAINTY_BY_STATE: Readonly<Record<ProviderCallState, ChargeCertainty>> = {
  submitting: 'unknown',
  ambiguous: 'unknown',
  completed: 'charged',
  accepted: 'charged',
  abandoned: 'not_charged',
};

export interface ProviderCallRecord {
  jobId: string;
  attempt: number;
  label: CandidateLabel;
  /** `${jobId}:${attempt}:provider-call:${label}` — the same family as the provider cost key. */
  claimKey: string;
  state: ProviderCallState;
  chargeCertainty: ChargeCertainty;
  /** The `TWI_PROVIDER_MODE` the call was made under. Known before the call, so always present. */
  providerMode: string;
  provider: string | null;
  model: string | null;
  providerRequestId: string | null;
  detail: Record<string, unknown>;
  claimedAt: string;
  settledAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface ProviderCallRow {
  job_id: string;
  attempt: number;
  label: CandidateLabel;
  claim_key: string;
  state: ProviderCallState;
  charge_certainty: ChargeCertainty;
  provider_mode: string;
  provider: string | null;
  model: string | null;
  provider_request_id: string | null;
  detail_json: string;
  claimed_at: string;
  settled_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

/** Which call. The identity is the primary key of `twi_provider_calls`. */
export interface ProviderCallIdentity {
  jobId: string;
  attempt: number;
  label: CandidateLabel;
}

export interface ClaimProviderCallInput extends ProviderCallIdentity {
  providerMode: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  now: string;
  /** A JSON object, canonicalised before storage. Defaults to `{}`. */
  detailJson?: string;
}

/**
 * - `claimed`         — this call wrote the `submitting` row; the caller may make the billable call.
 * - `already-claimed` — a row for this identity already existed; it is returned UNCHANGED and the
 *                       caller must NOT call the provider, because a call may already be in flight
 *                       or may already have been paid for.
 */
export type ClaimProviderCallOutcome = 'claimed' | 'already-claimed';

export interface ClaimProviderCallResult {
  outcome: ClaimProviderCallOutcome;
  call: ProviderCallRecord;
}

export interface SettleProviderCallInput extends ProviderCallIdentity {
  state: ProviderCallSettledState;
  /** Required for `completed` — the P0 says persist the request id. */
  providerRequestId?: string | null;
  provider?: string | null;
  model?: string | null;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  now: string;
  /** A JSON object replacing the stored detail when supplied. */
  detailJson?: string;
}

/**
 * - `settled`         — this call moved the row out of `submitting`.
 * - `already-settled` — the row had already left `submitting`; it is returned UNCHANGED.
 * - `not-claimed`     — no row exists for this identity; `call` is `null`. Nothing was written.
 */
export type SettleProviderCallOutcome = 'settled' | 'already-settled' | 'not-claimed';

export interface SettleProviderCallResult {
  outcome: SettleProviderCallOutcome;
  call: ProviderCallRecord | null;
}

export interface ResolveProviderCallInput extends ProviderCallIdentity {
  /**
   * Required when the row is `submitting` or `ambiguous`: an unknown charge must become known
   * before the row can stop blocking a retry. Must be omitted for a row whose charge is already
   * known — a resolution acknowledges a known charge, it does not rewrite one.
   */
  to?: ProviderCallResolution;
  /** Nonblank. Who decided what, and on what evidence. */
  note: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  now: string;
}

/**
 * - `resolved`         — this call wrote `resolved_at` and the note (and the new state, if any).
 * - `already-resolved` — the row was resolved before; it is returned UNCHANGED.
 * - `not-found`        — no row exists for this identity; `call` is `null`.
 */
export type ResolveProviderCallOutcome = 'resolved' | 'already-resolved' | 'not-found';

export interface ResolveProviderCallResult {
  outcome: ResolveProviderCallOutcome;
  call: ProviderCallRecord | null;
}

/**
 * The predicate the retry gate and the reconciliation inventory share: a call whose charge is
 * not known to be absent and that no human has resolved. `countUnreconciledProviderCalls` is
 * its SQL twin (`charge_certainty <> 'not_charged' AND resolved_at IS NULL`), and a test holds
 * the two spellings to the same answer.
 */
export const isUnreconciledProviderCall = (call: ProviderCallRecord): boolean =>
  call.chargeCertainty !== 'not_charged' && call.resolvedAt === null;
