/**
 * Every statement the provider-call ledger sends to D1, and the typed reads built on them.
 *
 * Kept beside `./queries` rather than inside it for the same reason that file exists at all:
 * `provider-calls.ts` should read as orchestration — validate, write, read back, report — and
 * the guarded SQL should sit in one place where the WHERE clauses can be reviewed side by side.
 * Every guard here is a WHERE clause on state, never a read-then-write in TypeScript, so two
 * concurrent writers cannot both believe they moved the row.
 */

import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-types';
import type {
  ChargeCertainty,
  ProviderCallIdentity,
  ProviderCallRow,
  ProviderCallSettledState,
  ProviderCallState,
} from './provider-call-types';

const PROVIDER_CALL_COLUMNS = `job_id, attempt, label, claim_key, state, charge_certainty, provider_mode,
  provider, model, provider_request_id, detail_json, claimed_at, settled_at, resolved_at, resolution_note`;

/**
 * `${jobId}:${attempt}:provider-call:${label}` — the same family as the provider cost key
 * (`${jobId}:${attempt}:provider:${label}`), distinguished by the segment so the two can never be
 * confused for one another in a log. Colons are correct here: this is a D1 key with no character
 * restriction, unlike a Workflow INSTANCE id.
 */
export const providerCallClaimKey = ({ jobId, attempt, label }: ProviderCallIdentity): string =>
  `${jobId}:${attempt}:provider-call:${label}`;

export interface ClaimStatementInput extends ProviderCallIdentity {
  state: ProviderCallState;
  chargeCertainty: ChargeCertainty;
  providerMode: string;
  detailJson: string;
  now: string;
}

/**
 * THE CLAIM. `ON CONFLICT(job_id, attempt, label) DO NOTHING` on the primary key is what makes it
 * idempotent: a re-executed step body finds its own row, `changes()` reports 0, and the caller
 * refuses to call the provider. Nothing else in this statement is conditional.
 */
export const insertProviderCallClaim = (db: D1DatabaseLike, input: ClaimStatementInput): D1PreparedStatementLike =>
  db
    .prepare(
      `INSERT INTO twi_provider_calls
         (job_id, attempt, label, claim_key, state, charge_certainty, provider_mode, detail_json, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, attempt, label) DO NOTHING`,
    )
    .bind(
      input.jobId,
      input.attempt,
      input.label,
      providerCallClaimKey(input),
      input.state,
      input.chargeCertainty,
      input.providerMode,
      input.detailJson,
      input.now,
    );

export interface SettleStatementInput extends ProviderCallIdentity {
  state: ProviderCallSettledState;
  chargeCertainty: ChargeCertainty;
  providerRequestId: string | null;
  provider: string | null;
  model: string | null;
  /** Canonical JSON object text, or `null` to keep what the claim stored. */
  detailJson: string | null;
  now: string;
}

/**
 * THE SETTLEMENT, guarded on `state = 'submitting'`. A row settles exactly once; a second
 * settlement — a replayed step, a reconciliation racing the Workflow — matches no row and
 * `changes()` reports 0. The COALESCEs keep whatever the claim already knew when the caller
 * supplies nothing newer, so a ProviderError path that has no request id cannot blank one.
 */
export const updateProviderCallSettlement = (
  db: D1DatabaseLike,
  input: SettleStatementInput,
): D1PreparedStatementLike =>
  db
    .prepare(
      `UPDATE twi_provider_calls
       SET state = ?, charge_certainty = ?,
           provider_request_id = COALESCE(?, provider_request_id),
           provider = COALESCE(?, provider),
           model = COALESCE(?, model),
           detail_json = COALESCE(?, detail_json),
           settled_at = ?
       WHERE job_id = ? AND attempt = ? AND label = ? AND state = 'submitting'`,
    )
    .bind(
      input.state,
      input.chargeCertainty,
      input.providerRequestId,
      input.provider,
      input.model,
      input.detailJson,
      input.now,
      input.jobId,
      input.attempt,
      input.label,
    );

export interface ResolveStatementInput extends ProviderCallIdentity {
  /** The state read at preflight — the optimistic-concurrency token. */
  expectedState: ProviderCallState;
  state: ProviderCallState;
  chargeCertainty: ChargeCertainty;
  note: string;
  now: string;
}

/**
 * THE RESOLUTION, the human reconciliation seam. Guarded on the state the caller read AND on
 * `resolved_at IS NULL`, so a resolution cannot overwrite a settlement or another resolution
 * that landed between the read and the write. `settled_at` is filled only if the row had never
 * settled — a `submitting` row resolved by a human leaves `submitting` at that moment, and the
 * schema requires the timestamp to say so.
 */
export const updateProviderCallResolution = (
  db: D1DatabaseLike,
  input: ResolveStatementInput,
): D1PreparedStatementLike =>
  db
    .prepare(
      `UPDATE twi_provider_calls
       SET state = ?, charge_certainty = ?,
           settled_at = COALESCE(settled_at, ?),
           resolved_at = ?, resolution_note = ?
       WHERE job_id = ? AND attempt = ? AND label = ? AND state = ? AND resolved_at IS NULL`,
    )
    .bind(
      input.state,
      input.chargeCertainty,
      input.now,
      input.now,
      input.note,
      input.jobId,
      input.attempt,
      input.label,
      input.expectedState,
    );

export const selectProviderCall = (db: D1DatabaseLike, identity: ProviderCallIdentity): Promise<ProviderCallRow | null> =>
  db
    .prepare(
      `SELECT ${PROVIDER_CALL_COLUMNS}
       FROM twi_provider_calls
       WHERE job_id = ? AND attempt = ? AND label = ?`,
    )
    .bind(identity.jobId, identity.attempt, identity.label)
    .first<ProviderCallRow>();

/** Every call of one job, in the order the attempts were made and A before B within each. */
export const selectProviderCalls = (db: D1DatabaseLike, jobId: string): Promise<{ results: ProviderCallRow[] }> =>
  db
    .prepare(
      `SELECT ${PROVIDER_CALL_COLUMNS}
       FROM twi_provider_calls
       WHERE job_id = ?
       ORDER BY attempt, label`,
    )
    .bind(jobId)
    .all<ProviderCallRow>();

/**
 * The reconciliation inventory, estate-wide and unscoped on purpose — an operator asking this
 * question wants every call whose money is unaccounted for, not one job's slice.
 *
 * The predicate is the SQL twin of `isUnreconciledProviderCall` in `./provider-call-types` and
 * is spelled byte for byte as the partial index `idx_twi_provider_calls_unresolved` spells its
 * WHERE clause, which is the condition SQLite places on using that index at all.
 */
export const countUnreconciledProviderCalls = async (db: D1DatabaseLike): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM twi_provider_calls
       WHERE charge_certainty <> 'not_charged' AND resolved_at IS NULL`,
    )
    .first<{ total: number }>();
  return row?.total ?? 0;
};
