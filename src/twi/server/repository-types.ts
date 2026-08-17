import type { AssetKind, JobPhase, JobStatus } from '../domain/types';

export type ProjectLifecycleState = 'active' | 'deleted';
export type AssetLifecycleState = 'provisional' | 'active' | 'hidden' | 'deleted';
export type JobKind = 'full-song' | 'finish';
export type CostCategory = 'estimate' | 'provider' | 'finishing' | 'storage';
export type CandidateLabel = 'A' | 'B';
export type RetryCheckpoint = 'queued' | 'generating' | 'ingesting' | 'finishing' | 'validating';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProjectRecord {
  id: string;
  name: string;
  currentRevisionId: string | null;
  lifecycleState: ProjectLifecycleState;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationSpecRecord {
  id: string;
  projectId: string;
  spec: Record<string, unknown>;
  specSha256: string;
  rightsAssertionVersion: string;
  createdAt: string;
}

export interface JobRecord {
  id: string;
  projectId: string;
  specId: string;
  specSha256: string;
  kind: JobKind;
  status: JobStatus;
  phase: JobPhase | null;
  workflowId: string | null;
  provider: string | null;
  model: string | null;
  idempotencyKey: string;
  estimate: Record<string, unknown> | null;
  actualCostUsd: number;
  outputManifest: Record<string, unknown> | null;
  retryCheckpoint: RetryCheckpoint | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AssetRecord {
  id: string;
  projectId: string;
  jobId: string | null;
  kind: AssetKind;
  label: string | null;
  r2Key: string;
  contentType: string;
  bytes: number;
  durationSeconds: number | null;
  sha256: string;
  provenanceKey: string | null;
  lifecycleState: AssetLifecycleState;
  createdAt: string;
  deletedAt: string | null;
}

export interface CandidatePublicationEntry {
  label: CandidateLabel;
  rawAssetId: string;
  masterAssetId: string;
  previewAssetId: string;
  provenanceAssetId: string;
}

export interface CandidatePublicationManifest {
  schemaVersion: 1;
  candidates: [CandidatePublicationEntry, CandidatePublicationEntry];
}

export interface CreateProjectInput {
  id: string;
  name: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  now: string;
}

export interface SaveSpecInput {
  id: string;
  projectId: string;
  specJson: string;
  specSha256: string;
  rightsAssertionVersion: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  createdAt: string;
}

export interface FindJobByIdempotencyKeyInput {
  projectId: string;
  idempotencyKey: string;
  specSha256: string;
}

export interface CreateEstimatedJobInput {
  id: string;
  projectId: string;
  specId: string;
  /**
   * Database-enforced deduplication token (`twi_jobs.idempotency_key` is UNIQUE).
   * A losing concurrent submission is reconciled into `outcome: 'replayed'`
   * rather than surfacing a raw driver error.
   */
  idempotencyKey: string;
  estimateJson: string;
  estimateAmountUsd: number;
  provider: string | null;
  model: string | null;
  eventKey: string;
  eventDetailJson: string;
  costIdempotencyKey: string;
  costDetailJson: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  now: string;
}

export interface TransitionJobOptions {
  /**
   * Optimistic-concurrency token, not a hint: the guarded UPDATE matches
   * `status = fromStatus`, so a stale value makes the whole transition fail
   * rather than silently applying against a status the caller did not expect.
   */
  fromStatus: JobStatus;
  phase: JobPhase | null;
  retryCheckpoint: RetryCheckpoint | null;
  /**
   * ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise —
   * `updated_at` is advanced with SQLite `MAX()` over TEXT, which compares
   * lexicographically, so a non-ISO value would outrank every future
   * timestamp and permanently freeze the column.
   */
  now: string;
  /**
   * Sole idempotency token for this transition, unique per `(job_id, event_key)`.
   *
   * Derivation is the caller's responsibility and it must include the attempt
   * ordinal — for example `` `${jobId}:${attempt}:${to}` ``. A scheme like
   * `` `${jobId}:${to}` `` collides on the first retry loop
   * (`queued→generating`, then `error→retrying→generating` reuses the key) and
   * the second call is a silent no-op replay, not a transition.
   */
  eventKey: string;
  detailJson?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Why a transition call returned the job it did.
 *
 * - `applied`    — this call performed the `from → to` write.
 * - `replayed`   — the `eventKey` already existed at preflight; nothing was written.
 * - `reconciled` — the guarded write lost a race and a matching committed
 *                  outcome was found; nothing was written by this call.
 *
 * `replayed` and `reconciled` both return the job's *current* state, which may
 * be a later status than `to`. A retried Workflow step lands here by design.
 */
export type TransitionOutcome = 'applied' | 'replayed' | 'reconciled';

export interface TransitionJobResult {
  job: JobRecord;
  outcome: TransitionOutcome;
}

export type CreateEstimatedJobOutcome = 'created' | 'replayed';

export interface CreateEstimatedJobResult {
  job: JobRecord;
  outcome: CreateEstimatedJobOutcome;
}

export type PublishCandidatesOutcome = 'published' | 'replayed' | 'reconciled';

export interface PublishCandidatesResult {
  job: JobRecord;
  outcome: PublishCandidatesOutcome;
}

export interface AppendCostInput {
  jobId: string;
  idempotencyKey: string;
  category: CostCategory;
  provider: string | null;
  model: string | null;
  amountUsd: number;
  quantity: number | null;
  detailJson: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  createdAt: string;
}

export interface AppendCostResult {
  inserted: boolean;
}

/**
 * Why a `registerAsset` call returned the asset it did.
 *
 * - `inserted`   — this call performed the insert.
 * - `replayed`   — a matching asset already existed (by id or by `r2Key`)
 *                  before this call ran; nothing was written.
 * - `reconciled` — the insert lost a race and a matching committed row was
 *                  found afterward; nothing was written by this call.
 */
export type RegisterAssetOutcome = 'inserted' | 'replayed' | 'reconciled';

export interface RegisterAssetResult {
  asset: AssetRecord;
  outcome: RegisterAssetOutcome;
}

export interface RegisterAssetInput {
  id: string;
  projectId: string;
  jobId: string | null;
  kind: AssetKind;
  /**
   * Free-form in the schema, but `publishCandidates` matches candidate assets on
   * exactly `'A'` / `'B'`. Any other value makes publication fail closed.
   */
  label: string | null;
  r2Key: string;
  contentType: string;
  bytes: number;
  durationSeconds: number | null;
  sha256: string;
  provenanceKey: string | null;
  lifecycleState: AssetLifecycleState;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  createdAt: string;
  /** ISO-8601 UTC timestamp or `null`. Required exactly when lifecycle is `deleted`. */
  deletedAt: string | null;
}

export interface PublishCandidatesInput {
  projectId: string;
  jobId: string;
  candidates: [CandidatePublicationEntry, CandidatePublicationEntry];
  eventKey: string;
  eventDetailJson: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`. Rejected otherwise. */
  now: string;
}

/** Terminal outcome of a repository write, for the optional telemetry sink. */
export interface TwiRepositoryEvent {
  op: 'createProject' | 'saveSpec' | 'createEstimatedJob' | 'transitionJob' | 'appendCost' | 'registerAsset' | 'publishCandidates';
  jobId?: string;
  projectId?: string;
  outcome: string;
  durationMs: number;
}

/**
 * Optional observability hook. Keeps the repository free of a logger import
 * while letting Task 5/6 forward these to `console.log` or Analytics Engine.
 * Sink failures are swallowed: telemetry must never break a write.
 */
export type TwiRepositoryEventSink = (event: TwiRepositoryEvent) => void;

export interface TwiRepositoryOptions {
  onEvent?: TwiRepositoryEventSink;
}

export interface TwiRepository {
  listProjects(): Promise<ProjectRecord[]>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  saveSpec(input: SaveSpecInput): Promise<GenerationSpecRecord>;
  findJobByIdempotencyKey(input: FindJobByIdempotencyKeyInput): Promise<JobRecord | null>;
  /**
   * Inserts the job, its `estimated` event and its estimate cost row atomically.
   * A concurrent submission of the same `idempotencyKey` is reconciled rather
   * than surfacing the UNIQUE-constraint failure to the caller.
   */
  createEstimatedJob(input: CreateEstimatedJobInput): Promise<CreateEstimatedJobResult>;
  /**
   * Applies a guarded `from → to` status change plus its audit event.
   *
   * `to === 'complete'` is rejected: a job is only complete once it also has an
   * output manifest, which is `publishCandidates`' job. Inspect
   * `result.outcome` — a resolved promise does not mean this call wrote anything.
   */
  transitionJob(jobId: string, to: JobStatus, options: TransitionJobOptions): Promise<TransitionJobResult>;
  /**
   * Appends one cost row and *recomputes* `twi_jobs.actual_cost_usd` as
   * `SUM(amount_usd) WHERE category <> 'estimate'`. It never increments, so a
   * duplicated row cannot inflate the total.
   */
  appendCost(input: AppendCostInput): Promise<AppendCostResult>;
  /**
   * Inserts an asset row, deduplicating on `id` and on `r2Key`. Inspect
   * `result.outcome` — a resolved promise does not mean this call wrote
   * anything.
   */
  registerAsset(input: RegisterAssetInput): Promise<RegisterAssetResult>;
  /**
   * Flips the eight provisional candidate assets to `active`, stores the output
   * manifest and completes the job — all or nothing. This is the only writer
   * that can produce a `complete` job, so "complete" and "has a manifest" are
   * the same fact.
   */
  publishCandidates(input: PublishCandidatesInput): Promise<PublishCandidatesResult>;
}

export interface ProjectRow {
  id: string;
  name: string;
  current_revision_id: string | null;
  lifecycle_state: ProjectLifecycleState;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  project_id: string;
  spec_id: string;
  spec_sha256: string;
  kind: JobKind;
  status: JobStatus;
  phase: JobPhase | null;
  workflow_id: string | null;
  provider: string | null;
  model: string | null;
  idempotency_key: string;
  estimate_json: string | null;
  actual_cost_usd: number;
  output_manifest_json: string | null;
  retry_checkpoint: RetryCheckpoint | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface JobEventRow {
  event_key: string;
  from_status: JobStatus | null;
  to_status: JobStatus;
  phase: JobPhase | null;
  detail_json: string;
  created_at: string;
}

export interface AssetRow {
  id: string;
  project_id: string;
  job_id: string | null;
  kind: AssetKind;
  label: string | null;
  r2_key: string;
  content_type: string;
  bytes: number;
  duration_seconds: number | null;
  sha256: string;
  provenance_key: string | null;
  lifecycle_state: AssetLifecycleState;
  created_at: string;
  deleted_at: string | null;
}

export interface CostEventRow {
  job_id: string;
  idempotency_key: string;
  category: CostCategory;
  provider: string | null;
  model: string | null;
  amount_usd: number;
  quantity: number | null;
  detail_json: string;
  created_at: string;
}

export const JOB_STATUSES: readonly JobStatus[] = [
  'draft',
  'estimated',
  'queued',
  'generating',
  'ingesting',
  'finishing',
  'validating',
  'complete',
  'cancelling',
  'cancelled',
  'error',
  'retrying',
];

export const JOB_PHASES: readonly JobPhase[] = JOB_STATUSES.filter(
  (status): status is JobPhase => status !== 'draft' && status !== 'estimated',
);

export const RETRY_CHECKPOINTS: readonly RetryCheckpoint[] = [
  'queued',
  'generating',
  'ingesting',
  'finishing',
  'validating',
];

export const ASSET_KINDS: readonly AssetKind[] = [
  'image-reference',
  'generation-raw',
  'generation-master',
  'generation-preview',
  'provenance',
];

export const ASSET_LIFECYCLES: readonly AssetLifecycleState[] = ['provisional', 'active', 'hidden', 'deleted'];

export const COST_CATEGORIES: readonly CostCategory[] = ['estimate', 'provider', 'finishing', 'storage'];

export const MAX_FINITE_DATABASE_NUMBER = 1e308;
