/**
 * Every statement this layer sends to D1, and the typed reads built on them.
 *
 * Keeping the SQL here means `repository.ts` reads as orchestration — validate,
 * guard, reconcile, report — rather than as a wall of template literals, and it
 * gives the guarded batches one place to be reviewed side by side.
 */

import { isTerminal } from '../domain/job-state';
import type { JobStatus } from '../domain/types';

import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-types';
import { mapAsset, mapJob } from './mappers';
import type {
  AppendCostInput,
  AssetRecord,
  AssetRow,
  CostEventRow,
  CreateEstimatedJobInput,
  CreateProjectInput,
  JobEventRow,
  JobRecord,
  JobRow,
  ProjectRow,
  PublishCandidatesInput,
  RegisterAssetInput,
  SaveSpecInput,
  TransitionJobOptions,
} from './repository-types';
import type { ValidatedEstimatedJob, ValidatedPublication } from './validation';

const PROJECT_COLUMNS = `id, name, current_revision_id, lifecycle_state, deleted_at, created_at, updated_at`;
const JOB_COLUMNS = `j.id, j.project_id, j.spec_id, s.spec_sha256, j.kind, j.status, j.phase,
  j.workflow_id, j.provider, j.model, j.idempotency_key, j.estimate_json, j.actual_cost_usd,
  j.output_manifest_json, j.retry_checkpoint, j.error_code, j.error_message, j.created_at,
  j.updated_at, j.finished_at`;
const ASSET_COLUMNS = `id, project_id, job_id, kind, label, r2_key, content_type, bytes,
  duration_seconds, sha256, provenance_key, lifecycle_state, created_at, deleted_at`;
const EVENT_COLUMNS = `event_key, from_status, to_status, phase, detail_json, created_at`;
const COST_COLUMNS = `job_id, idempotency_key, category, provider, model, amount_usd, quantity,
  detail_json, created_at`;
const JOB_SOURCE = `FROM twi_jobs j
       JOIN twi_generation_specs s ON s.id = j.spec_id AND s.project_id = j.project_id`;

// ---------------------------------------------------------------------------
// Single-statement writes
// ---------------------------------------------------------------------------

export const insertProject = (db: D1DatabaseLike, input: CreateProjectInput): D1PreparedStatementLike =>
  db
    .prepare(
      `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .bind(input.id, input.name, input.now, input.now);

export const insertSpec = (
  db: D1DatabaseLike,
  input: SaveSpecInput,
  canonicalSpecJson: string,
): D1PreparedStatementLike =>
  db
    .prepare(
      `INSERT INTO twi_generation_specs
         (id, project_id, spec_json, spec_sha256, rights_assertion_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.projectId,
      canonicalSpecJson,
      input.specSha256,
      input.rightsAssertionVersion,
      input.createdAt,
    );

export const insertAsset = (db: D1DatabaseLike, input: RegisterAssetInput): D1PreparedStatementLike =>
  db
    .prepare(
      `INSERT INTO twi_assets
         (id, project_id, job_id, kind, label, r2_key, content_type, bytes, duration_seconds,
          sha256, provenance_key, lifecycle_state, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.projectId,
      input.jobId,
      input.kind,
      input.label,
      input.r2Key,
      input.contentType,
      input.bytes,
      input.durationSeconds,
      input.sha256,
      input.provenanceKey,
      input.lifecycleState,
      input.createdAt,
      input.deletedAt,
    );

// ---------------------------------------------------------------------------
// Guarded batches
// ---------------------------------------------------------------------------

export const estimatedJobStatements = (
  db: D1DatabaseLike,
  input: CreateEstimatedJobInput,
  validated: ValidatedEstimatedJob,
): D1PreparedStatementLike[] => [
  db
    .prepare(
      `INSERT INTO twi_jobs
         (id, project_id, spec_id, kind, status, phase, provider, model, idempotency_key,
          estimate_json, actual_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, 'full-song', 'estimated', NULL, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      input.id,
      input.projectId,
      input.specId,
      input.provider,
      input.model,
      input.idempotencyKey,
      validated.estimateJson,
      input.now,
      input.now,
    ),
  db
    .prepare(
      `INSERT INTO twi_job_events
         (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
       VALUES (?, ?, NULL, 'estimated', NULL, ?, ?)`,
    )
    .bind(input.id, input.eventKey, validated.eventDetailJson, input.now),
  db
    .prepare(
      `INSERT INTO twi_cost_events
         (job_id, idempotency_key, category, provider, model, amount_usd, quantity, detail_json, created_at)
       VALUES (?, ?, 'estimate', ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      input.id,
      input.costIdempotencyKey,
      input.provider,
      input.model,
      input.estimateAmountUsd,
      validated.costDetailJson,
      input.now,
    ),
];

/**
 * Statement 1 is the serialisation point: `WHERE id = ? AND status = ?` with
 * `from` bound last. Statements 2 and 3 chain on `changes() = 1`, so the whole
 * batch is a no-op unless statement 1 actually won the race.
 *
 * `updated_at = MAX(updated_at, ?)` rather than `= ?` keeps the column
 * monotonic: a transition carrying an older `now` must not roll back a newer
 * timestamp written by a concurrent `appendCost`, which advances the same column
 * the same way. That is only safe because `assertTimestamp` guarantees
 * fixed-width ISO-8601 UTC input — `MAX()` over TEXT compares lexicographically.
 */
export const transitionStatements = (
  db: D1DatabaseLike,
  jobId: string,
  to: JobStatus,
  options: TransitionJobOptions,
  fingerprintJson: string,
): D1PreparedStatementLike[] => {
  const from = options.fromStatus;
  const errorCode = to === 'error' ? (options.errorCode as string) : null;
  const errorMessage = to === 'error' ? (options.errorMessage as string) : null;
  const finishedAt = isTerminal(to) ? options.now : null;
  return [
    db
      .prepare(
        `UPDATE twi_jobs
         SET status = ?, phase = ?, updated_at = MAX(updated_at, ?), error_code = ?, error_message = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(to, options.phase, options.now, errorCode, errorMessage, jobId, from),
    db
      .prepare(
        `UPDATE twi_jobs
         SET finished_at = ?, retry_checkpoint = ?
         WHERE id = ? AND status = ? AND changes() = 1`,
      )
      .bind(finishedAt, options.retryCheckpoint, jobId, to),
    db
      .prepare(
        `INSERT INTO twi_job_events
           (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE changes() = 1`,
      )
      .bind(jobId, options.eventKey, from, to, options.phase, fingerprintJson, options.now),
  ];
};

/**
 * The job total is *recomputed* from `SUM(amount_usd)` rather than incremented,
 * so even a duplicated cost row could not inflate it. The aggregate update
 * chains on `changes() = 1` so a suppressed `ON CONFLICT DO NOTHING` insert does
 * not touch `updated_at`.
 */
export const costStatements = (
  db: D1DatabaseLike,
  input: AppendCostInput,
  detailJson: string,
): D1PreparedStatementLike[] => [
  db
    .prepare(
      `INSERT INTO twi_cost_events
         (job_id, idempotency_key, category, provider, model, amount_usd, quantity, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id,idempotency_key) DO NOTHING`,
    )
    .bind(
      input.jobId,
      input.idempotencyKey,
      input.category,
      input.provider,
      input.model,
      input.amountUsd,
      input.quantity,
      detailJson,
      input.createdAt,
    ),
  db
    .prepare(
      `UPDATE twi_jobs
       SET actual_cost_usd = MIN(
         COALESCE((
           SELECT SUM(amount_usd)
           FROM twi_cost_events
           WHERE job_id = ? AND category <> 'estimate'
         ), 0),
         9.99999999999999e307
       ),
       updated_at = MAX(updated_at, ?)
       WHERE id = ? AND changes() = 1`,
    )
    .bind(input.jobId, input.createdAt, input.jobId),
];

/**
 * All-or-nothing publication. The asset update activates the candidate rows only
 * if *all* of them are still provisional (the uncorrelated `COUNT(*)` subquery is
 * hoisted under `OP_Once`, so it does not decay as rows flip), the job update
 * fires only if exactly that many rows changed, and the event insert only if the
 * job update landed. `from` is bound rather than hardcoded so the modelled
 * `cancelling → complete` edge is served by the same statement as `validating`.
 */
export const publicationStatements = (
  db: D1DatabaseLike,
  input: PublishCandidatesInput,
  publication: ValidatedPublication,
  from: JobStatus,
): D1PreparedStatementLike[] => {
  const pairPredicate = publication.pairs.map(() => `(id = ? AND label = ? AND kind = ?)`).join(' OR ');
  const pairBindings = publication.pairs.flatMap(({ id, label, kind }) => [id, label, kind]);
  const pairCount = publication.pairs.length;
  return [
    db
      .prepare(
        `UPDATE twi_assets
         SET lifecycle_state = 'active'
         WHERE project_id = ?
           AND job_id = ?
           AND lifecycle_state = 'provisional'
           AND (${pairPredicate})
           AND EXISTS (
             SELECT 1 FROM twi_jobs
             WHERE id = ? AND project_id = ? AND status = ?
           )
           AND (
             SELECT COUNT(*) FROM twi_assets
             WHERE project_id = ?
               AND job_id = ?
               AND lifecycle_state = 'provisional'
               AND (${pairPredicate})
           ) = ${pairCount}`,
      )
      .bind(
        input.projectId,
        input.jobId,
        ...pairBindings,
        input.jobId,
        input.projectId,
        from,
        input.projectId,
        input.jobId,
        ...pairBindings,
      ),
    db
      .prepare(
        `UPDATE twi_jobs
         SET status = 'complete', phase = 'complete', output_manifest_json = ?,
             retry_checkpoint = NULL, error_code = NULL, error_message = NULL,
             updated_at = MAX(updated_at, ?), finished_at = ?
         WHERE id = ? AND project_id = ? AND status = ? AND changes() = ${pairCount}`,
      )
      .bind(publication.manifestJson, input.now, input.now, input.jobId, input.projectId, from),
    db
      .prepare(
        `INSERT INTO twi_job_events
           (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
         SELECT ?, ?, ?, 'complete', 'complete', ?, ?
         WHERE changes() = 1`,
      )
      .bind(input.jobId, input.eventKey, from, publication.fingerprintJson, input.now),
  ];
};

// ---------------------------------------------------------------------------
// Typed reads
// ---------------------------------------------------------------------------

export const selectActiveProjects = (db: D1DatabaseLike): Promise<{ results: ProjectRow[] }> =>
  db
    .prepare(
      `SELECT ${PROJECT_COLUMNS}
       FROM twi_projects
       WHERE lifecycle_state = 'active'
       ORDER BY updated_at DESC`,
    )
    .all<ProjectRow>();

export const selectProject = (db: D1DatabaseLike, projectId: string): Promise<ProjectRow | null> =>
  db
    .prepare(
      `SELECT ${PROJECT_COLUMNS}
       FROM twi_projects
       WHERE id = ? AND lifecycle_state = 'active'`,
    )
    .bind(projectId)
    .first<ProjectRow>();

export const selectJobRowByKey = (db: D1DatabaseLike, idempotencyKey: string): Promise<JobRow | null> =>
  db
    .prepare(`SELECT ${JOB_COLUMNS} ${JOB_SOURCE} WHERE j.idempotency_key = ?`)
    .bind(idempotencyKey)
    .first<JobRow>();

export async function findJobByKey(db: D1DatabaseLike, idempotencyKey: string): Promise<JobRecord | null> {
  const row = await selectJobRowByKey(db, idempotencyKey);
  return row ? mapJob(row) : null;
}

export async function findJobById(db: D1DatabaseLike, jobId: string): Promise<JobRecord | null> {
  const row = await db
    .prepare(`SELECT ${JOB_COLUMNS} ${JOB_SOURCE} WHERE j.id = ?`)
    .bind(jobId)
    .first<JobRow>();
  return row ? mapJob(row) : null;
}

export const findJobEvent = (
  db: D1DatabaseLike,
  jobId: string,
  eventKey: string,
): Promise<JobEventRow | null> =>
  db
    .prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM twi_job_events
       WHERE job_id = ? AND event_key = ?`,
    )
    .bind(jobId, eventKey)
    .first<JobEventRow>();

export async function findAssetById(db: D1DatabaseLike, assetId: string): Promise<AssetRecord | null> {
  const row = await db
    .prepare(`SELECT ${ASSET_COLUMNS} FROM twi_assets WHERE id = ?`)
    .bind(assetId)
    .first<AssetRow>();
  return row ? mapAsset(row) : null;
}

export async function findAssetByR2Key(db: D1DatabaseLike, r2Key: string): Promise<AssetRecord | null> {
  const row = await db
    .prepare(`SELECT ${ASSET_COLUMNS} FROM twi_assets WHERE r2_key = ?`)
    .bind(r2Key)
    .first<AssetRow>();
  return row ? mapAsset(row) : null;
}

export const findCostEvent = (
  db: D1DatabaseLike,
  jobId: string,
  idempotencyKey: string,
): Promise<CostEventRow | null> =>
  db
    .prepare(
      `SELECT ${COST_COLUMNS}
       FROM twi_cost_events
       WHERE job_id = ? AND idempotency_key = ?`,
    )
    .bind(jobId, idempotencyKey)
    .first<CostEventRow>();

export const selectProvisionalCandidates = (
  db: D1DatabaseLike,
  projectId: string,
  jobId: string,
): Promise<{ results: Array<{ id: string; label: string | null; kind: string }> }> =>
  db
    .prepare(
      `SELECT id, label, kind
       FROM twi_assets
       WHERE project_id = ? AND job_id = ? AND lifecycle_state = 'provisional'`,
    )
    .bind(projectId, jobId)
    .all<{ id: string; label: string | null; kind: string }>();
