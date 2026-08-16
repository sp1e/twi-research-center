import { assertTransition, canTransition, isTerminal } from '../domain/job-state';
import type { AssetKind, JobPhase, JobStatus } from '../domain/types';

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[];
  success: true;
  error?: never;
  meta: {
    changes: number;
    [key: string]: unknown;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

export interface TwiRepositoryEnv {
  DB: D1DatabaseLike;
}

export class TwiRepositoryValidationError extends Error {
  override readonly name = 'TwiRepositoryValidationError';
}

export class TwiRepositoryCorruptionError extends Error {
  override readonly name = 'TwiRepositoryCorruptionError';
}

export class TwiRepositoryCollisionError extends Error {
  override readonly name = 'TwiRepositoryCollisionError';
}

export class TwiRepositoryConflictError extends Error {
  override readonly name = 'TwiRepositoryConflictError';
}

export type ProjectLifecycleState = 'active' | 'deleted';
export type AssetLifecycleState = 'provisional' | 'active' | 'hidden' | 'deleted';
export type JobKind = 'full-song' | 'finish';
export type CostCategory = 'estimate' | 'provider' | 'finishing' | 'storage';
export type CandidateLabel = 'A' | 'B';
export type RetryCheckpoint = 'queued' | 'generating' | 'ingesting' | 'finishing' | 'validating';

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
  now: string;
}

export interface SaveSpecInput {
  id: string;
  projectId: string;
  specJson: string;
  specSha256: string;
  rightsAssertionVersion: string;
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
  idempotencyKey: string;
  estimateJson: string;
  estimateAmountUsd: number;
  provider: string | null;
  model: string | null;
  eventKey: string;
  eventDetailJson: string;
  costIdempotencyKey: string;
  costDetailJson: string;
  now: string;
}

export interface TransitionJobOptions {
  fromStatus: JobStatus;
  phase: JobPhase | null;
  retryCheckpoint: RetryCheckpoint | null;
  now: string;
  eventKey: string;
  detailJson?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
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
  createdAt: string;
}

export interface AppendCostResult {
  inserted: boolean;
}

export interface RegisterAssetInput {
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

export interface PublishCandidatesInput {
  projectId: string;
  jobId: string;
  candidates: [CandidatePublicationEntry, CandidatePublicationEntry];
  eventKey: string;
  eventDetailJson: string;
  now: string;
}

export interface TwiRepository {
  listProjects(): Promise<ProjectRecord[]>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  saveSpec(input: SaveSpecInput): Promise<GenerationSpecRecord>;
  findJobByIdempotencyKey(input: FindJobByIdempotencyKeyInput): Promise<JobRecord | null>;
  createEstimatedJob(input: CreateEstimatedJobInput): Promise<JobRecord>;
  transitionJob(jobId: string, to: JobStatus, options: TransitionJobOptions): Promise<JobRecord>;
  appendCost(input: AppendCostInput): Promise<AppendCostResult>;
  registerAsset(input: RegisterAssetInput): Promise<AssetRecord>;
  publishCandidates(input: PublishCandidatesInput): Promise<JobRecord>;
}

interface ProjectRow {
  id: string;
  name: string;
  current_revision_id: string | null;
  lifecycle_state: ProjectLifecycleState;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
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

interface JobEventRow {
  event_key: string;
  from_status: JobStatus | null;
  to_status: JobStatus;
  phase: JobPhase | null;
  detail_json: string;
  created_at: string;
}

interface AssetRow {
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

interface CostEventRow {
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

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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
const JOB_STATUSES: readonly JobStatus[] = [
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
const JOB_PHASES: readonly JobPhase[] = JOB_STATUSES.filter(
  (status): status is JobPhase => status !== 'draft' && status !== 'estimated',
);
const RETRY_CHECKPOINTS: readonly RetryCheckpoint[] = [
  'queued',
  'generating',
  'ingesting',
  'finishing',
  'validating',
];
const ASSET_KINDS: readonly AssetKind[] = [
  'image-reference',
  'generation-raw',
  'generation-master',
  'generation-preview',
  'provenance',
];
const ASSET_LIFECYCLES: readonly AssetLifecycleState[] = ['provisional', 'active', 'hidden', 'deleted'];
const COST_CATEGORIES: readonly CostCategory[] = ['estimate', 'provider', 'finishing', 'storage'];
const MAX_FINITE_DATABASE_NUMBER = 1e308;

function validation(message: string): never {
  throw new TwiRepositoryValidationError(message);
}

function collision(message: string): never {
  throw new TwiRepositoryCollisionError(message);
}

function conflict(message: string): never {
  throw new TwiRepositoryConflictError(message);
}

function assertNonBlank(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) validation(`${field} must be nonblank`);
}

function assertNullableNonBlank(field: string, value: unknown): asserts value is string | null {
  if (value !== null) assertNonBlank(field, value);
}

function assertFiniteNonnegative(field: string, value: unknown, nullable = false): asserts value is number | null {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= MAX_FINITE_DATABASE_NUMBER) {
    validation(`${field} must be finite, nonnegative, and less than 1e308`);
  }
}

function assertEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) validation(`${field} is invalid`);
}

function assertPlainObject(field: string, value: unknown): asserts value is Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) validation(`${field} must be a JSON object`);
}

function canonicalizeJson(value: JsonValue, reject: (reason: string) => never, path = '$'): JsonValue {
  if (typeof value === 'number' && !Number.isFinite(value)) reject(`${path} contains a non-finite number`);
  if (Array.isArray(value)) return value.map((child, index) => canonicalizeJson(child, reject, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key]!, reject, `${path}.${key}`)]),
    );
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
    reject(`${path} contains an unsupported JSON value`);
  }
  return value;
}

function canonicalStringify(value: Record<string, JsonValue>, reject: (reason: string) => never): string {
  return JSON.stringify(canonicalizeJson(value, reject));
}

function parseInputObjectJson(field: string, json: unknown): { object: Record<string, JsonValue>; canonical: string } {
  assertNonBlank(field, json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    validation(`${field} must contain valid JSON`);
  }
  assertPlainObject(field, parsed);
  const canonical = canonicalStringify(parsed, (reason) => validation(`${field} ${reason}`));
  return { object: JSON.parse(canonical) as Record<string, JsonValue>, canonical };
}

function parseStoredObjectJson(
  json: string | null,
  context: string,
  nullable: true,
): Record<string, unknown> | null;
function parseStoredObjectJson(json: string, context: string, nullable?: false): Record<string, unknown>;
function parseStoredObjectJson(
  json: string | null,
  context: string,
  nullable = false,
): Record<string, unknown> | null {
  if (json === null) {
    if (nullable) return null;
    throw new TwiRepositoryCorruptionError(`corrupt ${context}: unexpected null`);
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown JSON error';
    throw new TwiRepositoryCorruptionError(`corrupt ${context}: ${reason}`);
  }
}

function canonicalStoredObjectJson(json: string, context: string): string {
  return canonicalStringify(parseStoredObjectJson(json, context) as Record<string, JsonValue>, (reason) => {
    throw new TwiRepositoryCorruptionError(`corrupt ${context}: ${reason}`);
  });
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    currentRevisionId: row.current_revision_id,
    lifecycleState: row.lifecycle_state,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    specId: row.spec_id,
    specSha256: row.spec_sha256,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    workflowId: row.workflow_id,
    provider: row.provider,
    model: row.model,
    idempotencyKey: row.idempotency_key,
    estimate: parseStoredObjectJson(row.estimate_json, `twi_jobs ${row.id} estimate_json`, true),
    actualCostUsd: row.actual_cost_usd,
    outputManifest: parseStoredObjectJson(
      row.output_manifest_json,
      `twi_jobs ${row.id} output_manifest_json`,
      true,
    ),
    retryCheckpoint: row.retry_checkpoint,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function mapAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind,
    label: row.label,
    r2Key: row.r2_key,
    contentType: row.content_type,
    bytes: row.bytes,
    durationSeconds: row.duration_seconds,
    sha256: row.sha256,
    provenanceKey: row.provenance_key,
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

function assetMatchesInput(asset: AssetRecord, input: RegisterAssetInput): boolean {
  return (
    asset.id === input.id &&
    asset.projectId === input.projectId &&
    asset.jobId === input.jobId &&
    asset.kind === input.kind &&
    asset.label === input.label &&
    asset.r2Key === input.r2Key &&
    asset.contentType === input.contentType &&
    asset.bytes === input.bytes &&
    asset.durationSeconds === input.durationSeconds &&
    asset.sha256 === input.sha256 &&
    asset.provenanceKey === input.provenanceKey &&
    asset.lifecycleState === input.lifecycleState &&
    asset.createdAt === input.createdAt &&
    asset.deletedAt === input.deletedAt
  );
}

function validateAssetInput(input: RegisterAssetInput): void {
  assertNonBlank('asset.id', input.id);
  assertNonBlank('asset.projectId', input.projectId);
  assertNullableNonBlank('asset.jobId', input.jobId);
  assertEnum('asset.kind', input.kind, ASSET_KINDS);
  assertNullableNonBlank('asset.label', input.label);
  assertNonBlank('asset.r2Key', input.r2Key);
  assertNonBlank('asset.contentType', input.contentType);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
    validation('asset.bytes must be a nonnegative safe integer');
  }
  assertFiniteNonnegative('asset.durationSeconds', input.durationSeconds, true);
  assertNonBlank('asset.sha256', input.sha256);
  assertNullableNonBlank('asset.provenanceKey', input.provenanceKey);
  assertEnum('asset.lifecycleState', input.lifecycleState, ASSET_LIFECYCLES);
  assertNonBlank('asset.createdAt', input.createdAt);
  assertNullableNonBlank('asset.deletedAt', input.deletedAt);
  if (input.lifecycleState === 'deleted' && input.deletedAt === null) {
    validation('deleted asset requires deletedAt');
  }
  if (input.lifecycleState !== 'deleted' && input.deletedAt !== null) {
    validation('non-deleted asset must have null deletedAt');
  }
}

function validateTransitionInput(
  jobId: string,
  to: JobStatus,
  options: TransitionJobOptions,
): { fingerprintJson: string } {
  assertNonBlank('jobId', jobId);
  assertEnum('transition.to', to, JOB_STATUSES);
  assertEnum('transition.fromStatus', options.fromStatus, JOB_STATUSES);
  if (options.phase !== null) assertEnum('transition.phase', options.phase, JOB_PHASES);
  if (!Object.prototype.hasOwnProperty.call(options, 'retryCheckpoint')) {
    validation('transition.retryCheckpoint must be supplied explicitly');
  }
  if (options.retryCheckpoint !== null) {
    assertEnum('transition.retryCheckpoint', options.retryCheckpoint, RETRY_CHECKPOINTS);
  }
  assertNonBlank('transition.now', options.now);
  assertNonBlank('transition.eventKey', options.eventKey);

  if (to === 'error') {
    assertNonBlank('transition.errorCode', options.errorCode);
    assertNonBlank('transition.errorMessage', options.errorMessage);
    if (options.retryCheckpoint === null) validation('error transition requires retryCheckpoint');
  } else if (options.errorCode !== undefined || options.errorMessage !== undefined) {
    validation('non-error transition must not provide error metadata');
  }
  if (to === 'retrying' && options.retryCheckpoint === null) {
    validation('retrying transition requires retryCheckpoint');
  }
  if (to !== 'error' && to !== 'retrying' && options.retryCheckpoint !== null) {
    validation('non-retry transition must clear retryCheckpoint');
  }

  const callerDetail = parseInputObjectJson('transition.detailJson', options.detailJson ?? '{}');
  const fingerprint = {
    schemaVersion: 1,
    eventType: 'job-transition',
    fromStatus: options.fromStatus,
    toStatus: to,
    phase: options.phase,
    retryCheckpoint: options.retryCheckpoint,
    errorCode: to === 'error' ? (options.errorCode as string) : null,
    errorMessage: to === 'error' ? (options.errorMessage as string) : null,
    detail: callerDetail.object,
  } as unknown as Record<string, JsonValue>;
  return {
    fingerprintJson: canonicalStringify(fingerprint, (reason) =>
      validation(`transition fingerprint ${reason}`),
    ),
  };
}

function transitionEventMatches(
  jobId: string,
  event: JobEventRow,
  from: JobStatus,
  to: JobStatus,
  phase: JobPhase | null,
  fingerprintJson: string,
): boolean {
  if (event.from_status !== from || !canTransition(from, to)) return false;
  const eventDetail = canonicalStoredObjectJson(
    event.detail_json,
    `twi_job_events ${jobId}/${event.event_key} detail_json`,
  );
  return (
    event.to_status === to &&
    event.phase === phase &&
    eventDetail === fingerprintJson
  );
}

function validateCostInput(input: AppendCostInput): string {
  assertNonBlank('cost.jobId', input.jobId);
  assertNonBlank('cost.idempotencyKey', input.idempotencyKey);
  assertEnum('cost.category', input.category, COST_CATEGORIES);
  assertNullableNonBlank('cost.provider', input.provider);
  assertNullableNonBlank('cost.model', input.model);
  assertFiniteNonnegative('cost.amountUsd', input.amountUsd);
  assertFiniteNonnegative('cost.quantity', input.quantity, true);
  assertNonBlank('cost.createdAt', input.createdAt);
  return parseInputObjectJson('cost.detailJson', input.detailJson).canonical;
}

function costMatchesInput(row: CostEventRow, input: AppendCostInput, detailJson: string): boolean {
  return (
    row.job_id === input.jobId &&
    row.idempotency_key === input.idempotencyKey &&
    row.category === input.category &&
    row.provider === input.provider &&
    row.model === input.model &&
    row.amount_usd === input.amountUsd &&
    row.quantity === input.quantity &&
    canonicalStoredObjectJson(
      row.detail_json,
      `twi_cost_events ${row.job_id}/${row.idempotency_key} detail_json`,
    ) === detailJson
  );
}

interface PublicationPair {
  id: string;
  label: CandidateLabel;
  kind: Exclude<AssetKind, 'image-reference'>;
}

interface ValidatedPublication {
  manifest: CandidatePublicationManifest;
  manifestJson: string;
  fingerprintJson: string;
  pairs: PublicationPair[];
}

function validatePublicationInput(input: PublishCandidatesInput): ValidatedPublication {
  assertNonBlank('publication.projectId', input.projectId);
  assertNonBlank('publication.jobId', input.jobId);
  assertNonBlank('publication.eventKey', input.eventKey);
  assertNonBlank('publication.now', input.now);
  if (!Array.isArray(input.candidates) || input.candidates.length !== 2) {
    validation('publication requires exactly two candidates');
  }

  const normalized = input.candidates.map((candidate, index): CandidatePublicationEntry => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      validation(`publication.candidates[${index}] must be an object`);
    }
    assertEnum(`publication.candidates[${index}].label`, candidate.label, ['A', 'B'] as const);
    assertNonBlank(`publication.candidates[${index}].rawAssetId`, candidate.rawAssetId);
    assertNonBlank(`publication.candidates[${index}].masterAssetId`, candidate.masterAssetId);
    assertNonBlank(`publication.candidates[${index}].previewAssetId`, candidate.previewAssetId);
    assertNonBlank(`publication.candidates[${index}].provenanceAssetId`, candidate.provenanceAssetId);
    return {
      label: candidate.label,
      rawAssetId: candidate.rawAssetId,
      masterAssetId: candidate.masterAssetId,
      previewAssetId: candidate.previewAssetId,
      provenanceAssetId: candidate.provenanceAssetId,
    };
  });
  if (new Set(normalized.map(({ label }) => label)).size !== 2) {
    validation('publication candidates must contain labels A and B exactly once');
  }
  normalized.sort((left, right) => left.label.localeCompare(right.label));
  const candidates = normalized as [CandidatePublicationEntry, CandidatePublicationEntry];
  const ids = candidates.flatMap(({ rawAssetId, masterAssetId, previewAssetId, provenanceAssetId }) => [
    rawAssetId,
    masterAssetId,
    previewAssetId,
    provenanceAssetId,
  ]);
  if (new Set(ids).size !== 8) validation('publication asset IDs must be globally unique');

  const manifest: CandidatePublicationManifest = { schemaVersion: 1, candidates };
  const callerDetail = parseInputObjectJson('publication.eventDetailJson', input.eventDetailJson);
  const fingerprint = {
    schemaVersion: 1,
    eventType: 'candidate-publication',
    manifest,
    detail: callerDetail.object,
  } as unknown as Record<string, JsonValue>;
  const pairs: PublicationPair[] = candidates.flatMap((candidate) => [
    { id: candidate.rawAssetId, label: candidate.label, kind: 'generation-raw' },
    { id: candidate.masterAssetId, label: candidate.label, kind: 'generation-master' },
    { id: candidate.previewAssetId, label: candidate.label, kind: 'generation-preview' },
    { id: candidate.provenanceAssetId, label: candidate.label, kind: 'provenance' },
  ]);
  return {
    manifest,
    manifestJson: JSON.stringify(manifest),
    fingerprintJson: canonicalStringify(fingerprint, (reason) =>
      validation(`publication fingerprint ${reason}`),
    ),
    pairs,
  };
}

export class D1TwiRepository implements TwiRepository {
  constructor(private readonly env: TwiRepositoryEnv) {}

  async listProjects(): Promise<ProjectRecord[]> {
    const result = await this.env.DB.prepare(
      `SELECT ${PROJECT_COLUMNS}
       FROM twi_projects
       WHERE lifecycle_state = 'active'
       ORDER BY updated_at DESC`,
    ).all<ProjectRow>();
    return result.results.map(mapProject);
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    assertNonBlank('project.id', input.id);
    assertNonBlank('project.name', input.name);
    assertNonBlank('project.now', input.now);
    const result = await this.env.DB.prepare(
      `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
      .bind(input.id, input.name, input.now, input.now)
      .run();
    if (result.meta.changes !== 1) conflict('project insert conflict');
    return {
      id: input.id,
      name: input.name,
      currentRevisionId: null,
      lifecycleState: 'active',
      deletedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    assertNonBlank('projectId', projectId);
    const row = await this.env.DB.prepare(
      `SELECT ${PROJECT_COLUMNS}
       FROM twi_projects
       WHERE id = ? AND lifecycle_state = 'active'`,
    )
      .bind(projectId)
      .first<ProjectRow>();
    return row ? mapProject(row) : null;
  }

  async saveSpec(input: SaveSpecInput): Promise<GenerationSpecRecord> {
    assertNonBlank('spec.id', input.id);
    assertNonBlank('spec.projectId', input.projectId);
    assertNonBlank('spec.specSha256', input.specSha256);
    assertNonBlank('spec.rightsAssertionVersion', input.rightsAssertionVersion);
    assertNonBlank('spec.createdAt', input.createdAt);
    const spec = parseInputObjectJson('spec.specJson', input.specJson);
    const result = await this.env.DB.prepare(
      `INSERT INTO twi_generation_specs
         (id, project_id, spec_json, spec_sha256, rights_assertion_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.id,
        input.projectId,
        spec.canonical,
        input.specSha256,
        input.rightsAssertionVersion,
        input.createdAt,
      )
      .run();
    if (result.meta.changes !== 1) conflict('generation spec insert conflict');
    return {
      id: input.id,
      projectId: input.projectId,
      spec: spec.object,
      specSha256: input.specSha256,
      rightsAssertionVersion: input.rightsAssertionVersion,
      createdAt: input.createdAt,
    };
  }

  async findJobByIdempotencyKey(input: FindJobByIdempotencyKeyInput): Promise<JobRecord | null> {
    assertNonBlank('job.projectId', input.projectId);
    assertNonBlank('job.idempotencyKey', input.idempotencyKey);
    assertNonBlank('job.specSha256', input.specSha256);
    const row = await this.env.DB.prepare(
      `SELECT ${JOB_COLUMNS}
       FROM twi_jobs j
       JOIN twi_generation_specs s ON s.id = j.spec_id AND s.project_id = j.project_id
       WHERE j.idempotency_key = ?`,
    )
      .bind(input.idempotencyKey)
      .first<JobRow>();
    if (!row) return null;
    if (row.project_id !== input.projectId || row.spec_sha256 !== input.specSha256) {
      collision('job idempotency collision');
    }
    return mapJob(row);
  }

  async createEstimatedJob(input: CreateEstimatedJobInput): Promise<JobRecord> {
    assertNonBlank('job.id', input.id);
    assertNonBlank('job.projectId', input.projectId);
    assertNonBlank('job.specId', input.specId);
    assertNonBlank('job.idempotencyKey', input.idempotencyKey);
    assertNonBlank('job.eventKey', input.eventKey);
    assertNonBlank('job.costIdempotencyKey', input.costIdempotencyKey);
    assertNonBlank('job.now', input.now);
    assertNullableNonBlank('job.provider', input.provider);
    assertNullableNonBlank('job.model', input.model);
    assertFiniteNonnegative('job.estimateAmountUsd', input.estimateAmountUsd);
    const estimate = parseInputObjectJson('job.estimateJson', input.estimateJson);
    const eventDetail = parseInputObjectJson('job.eventDetailJson', input.eventDetailJson);
    const costDetail = parseInputObjectJson('job.costDetailJson', input.costDetailJson);
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO twi_jobs
           (id, project_id, spec_id, kind, status, phase, provider, model, idempotency_key,
            estimate_json, actual_cost_usd, created_at, updated_at)
         VALUES (?, ?, ?, 'full-song', 'estimated', NULL, ?, ?, ?, ?, 0, ?, ?)`,
      ).bind(
        input.id,
        input.projectId,
        input.specId,
        input.provider,
        input.model,
        input.idempotencyKey,
        estimate.canonical,
        input.now,
        input.now,
      ),
      this.env.DB.prepare(
        `INSERT INTO twi_job_events
           (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
         VALUES (?, ?, NULL, 'estimated', NULL, ?, ?)`,
      ).bind(input.id, input.eventKey, eventDetail.canonical, input.now),
      this.env.DB.prepare(
        `INSERT INTO twi_cost_events
           (job_id, idempotency_key, category, provider, model, amount_usd, quantity, detail_json, created_at)
         VALUES (?, ?, 'estimate', ?, ?, ?, NULL, ?, ?)`,
      ).bind(
        input.id,
        input.costIdempotencyKey,
        input.provider,
        input.model,
        input.estimateAmountUsd,
        costDetail.canonical,
        input.now,
      ),
    ]);
    if (results.some((result) => result.meta.changes !== 1)) conflict('estimated job creation conflict');
    const created = await this.findJobById(input.id);
    if (!created) conflict('estimated job readback conflict');
    return created;
  }

  async transitionJob(jobId: string, to: JobStatus, options: TransitionJobOptions): Promise<JobRecord> {
    const transition = validateTransitionInput(jobId, to, options);
    const current = await this.findJobById(jobId);
    if (!current) conflict('job not found');
    const event = await this.findJobEvent(jobId, options.eventKey);
    const errorCode = to === 'error' ? (options.errorCode as string) : null;
    const errorMessage = to === 'error' ? (options.errorMessage as string) : null;

    if (event) {
      const replay = await this.reconcileTransition(
        jobId,
        options.eventKey,
        options.fromStatus,
        to,
        options.phase,
        transition.fingerprintJson,
        event,
      );
      if (replay) return replay;
    }

    const from = options.fromStatus;
    if (current.status !== from) conflict('job transition conflict');
    assertTransition(from, to);
    if (from === 'retrying' && RETRY_CHECKPOINTS.includes(to as RetryCheckpoint) && options.retryCheckpoint !== null) {
      validation('resumed work transition must clear retryCheckpoint');
    }
    const finishedAt = isTerminal(to) ? options.now : null;
    let results: D1ResultLike[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE twi_jobs
           SET status = ?, phase = ?, updated_at = MAX(updated_at, ?), error_code = ?, error_message = ?
           WHERE id = ? AND status = ?`,
        ).bind(to, options.phase, options.now, errorCode, errorMessage, jobId, from),
        this.env.DB.prepare(
          `UPDATE twi_jobs
           SET finished_at = ?, retry_checkpoint = ?
           WHERE id = ? AND status = ? AND changes() = 1`,
        ).bind(finishedAt, options.retryCheckpoint, jobId, to),
        this.env.DB.prepare(
          `INSERT INTO twi_job_events
             (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1`,
        ).bind(jobId, options.eventKey, from, to, options.phase, transition.fingerprintJson, options.now),
      ]);
    } catch (error) {
      const replay = await this.reconcileTransition(
        jobId,
        options.eventKey,
        from,
        to,
        options.phase,
        transition.fingerprintJson,
      );
      if (replay) return replay;
      throw error;
    }
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      const replay = await this.reconcileTransition(
        jobId,
        options.eventKey,
        from,
        to,
        options.phase,
        transition.fingerprintJson,
      );
      if (replay) return replay;
      conflict('job transition conflict');
    }
    const transitioned = await this.findJobById(jobId);
    if (!transitioned) conflict('job transition readback conflict');
    return transitioned;
  }

  async appendCost(input: AppendCostInput): Promise<AppendCostResult> {
    const detailJson = validateCostInput(input);
    const existing = await this.findCostEvent(input.jobId, input.idempotencyKey);
    if (existing) {
      if (!costMatchesInput(existing, input, detailJson)) collision('cost idempotency collision');
      return { inserted: false };
    }

    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO twi_cost_events
           (job_id, idempotency_key, category, provider, model, amount_usd, quantity, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id,idempotency_key) DO NOTHING`,
      ).bind(
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
      this.env.DB.prepare(
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
      ).bind(input.jobId, input.createdAt, input.jobId),
    ]);

    if (results[0]?.meta.changes === 1) {
      if (results[1]?.meta.changes !== 1) conflict('cost append conflict');
      return { inserted: true };
    }
    const raced = await this.findCostEvent(input.jobId, input.idempotencyKey);
    if (!raced || !costMatchesInput(raced, input, detailJson)) collision('cost idempotency collision');
    return { inserted: false };
  }

  async registerAsset(input: RegisterAssetInput): Promise<AssetRecord> {
    validateAssetInput(input);
    const existingById = await this.findAssetById(input.id);
    if (existingById) {
      if (!assetMatchesInput(existingById, input)) collision('asset idempotency collision');
      return existingById;
    }
    const existingByKey = await this.findAssetByR2Key(input.r2Key);
    if (existingByKey) {
      if (assetMatchesInput(existingByKey, input)) return existingByKey;
      collision('asset idempotency collision');
    }

    try {
      const result = await this.env.DB.prepare(
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
        )
        .run();
      if (result.meta.changes !== 1) conflict('asset insert conflict');
      return { ...input };
    } catch (error) {
      const racedById = await this.findAssetById(input.id);
      if (racedById && assetMatchesInput(racedById, input)) return racedById;
      const racedByKey = await this.findAssetByR2Key(input.r2Key);
      if (racedByKey && assetMatchesInput(racedByKey, input)) return racedByKey;
      if (racedById || racedByKey) collision('asset idempotency collision');
      throw error;
    }
  }

  async publishCandidates(input: PublishCandidatesInput): Promise<JobRecord> {
    const publication = validatePublicationInput(input);
    const current = await this.findJobById(input.jobId);
    if (current?.status === 'complete') {
      const replay = await this.reconcilePublication(input, publication, current);
      if (replay) return replay;
    }

    const pairPredicate = publication.pairs.map(() => `(id = ? AND label = ? AND kind = ?)`).join(' OR ');
    const pairBindings = publication.pairs.flatMap(({ id, label, kind }) => [id, label, kind]);
    let results: D1ResultLike[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE twi_assets
           SET lifecycle_state = 'active'
           WHERE project_id = ?
             AND job_id = ?
             AND lifecycle_state = 'provisional'
             AND (${pairPredicate})
             AND EXISTS (
               SELECT 1 FROM twi_jobs
               WHERE id = ? AND project_id = ? AND status = 'validating'
             )
             AND (
               SELECT COUNT(*) FROM twi_assets
               WHERE project_id = ?
                 AND job_id = ?
                 AND lifecycle_state = 'provisional'
                 AND (${pairPredicate})
             ) = 8`,
        ).bind(
          input.projectId,
          input.jobId,
          ...pairBindings,
          input.jobId,
          input.projectId,
          input.projectId,
          input.jobId,
          ...pairBindings,
        ),
        this.env.DB.prepare(
          `UPDATE twi_jobs
           SET status = 'complete', phase = 'complete', output_manifest_json = ?,
               retry_checkpoint = NULL, error_code = NULL, error_message = NULL,
               updated_at = MAX(updated_at, ?), finished_at = ?
           WHERE id = ? AND project_id = ? AND status = 'validating' AND changes() = 8`,
        ).bind(publication.manifestJson, input.now, input.now, input.jobId, input.projectId),
        this.env.DB.prepare(
          `INSERT INTO twi_job_events
             (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
           SELECT ?, ?, 'validating', 'complete', 'complete', ?, ?
           WHERE changes() = 1`,
        ).bind(input.jobId, input.eventKey, publication.fingerprintJson, input.now),
      ]);
    } catch (error) {
      const replay = await this.reconcilePublication(input, publication);
      if (replay) return replay;
      throw error;
    }
    if (results[0]?.meta.changes !== 8 || results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      const replay = await this.reconcilePublication(input, publication);
      if (replay) return replay;
      conflict('candidate publication conflict');
    }
    const completed = await this.findJobById(input.jobId);
    if (!completed) conflict('candidate publication readback conflict');
    return completed;
  }

  private async reconcileTransition(
    jobId: string,
    eventKey: string,
    from: JobStatus,
    to: JobStatus,
    phase: JobPhase | null,
    fingerprintJson: string,
    knownEvent?: JobEventRow,
  ): Promise<JobRecord | null> {
    const event = knownEvent ?? (await this.findJobEvent(jobId, eventKey));
    if (!event) return null;
    if (!transitionEventMatches(jobId, event, from, to, phase, fingerprintJson)) {
      collision('transition idempotency collision');
    }
    const latest = await this.findJobById(jobId);
    if (!latest) conflict('job not found');
    return latest;
  }

  private async reconcilePublication(
    input: PublishCandidatesInput,
    publication: ValidatedPublication,
    knownJob?: JobRecord,
  ): Promise<JobRecord | null> {
    const latest = knownJob ?? (await this.findJobById(input.jobId));
    const event = await this.findJobEvent(input.jobId, input.eventKey);
    if (latest?.status !== 'complete' && !event) return null;
    if (!latest || latest.status !== 'complete' || !event) collision('candidate publication collision');

    const storedManifest = latest.outputManifest
      ? canonicalStringify(latest.outputManifest as Record<string, JsonValue>, (reason) => {
          throw new TwiRepositoryCorruptionError(
            `corrupt twi_jobs ${input.jobId} output_manifest_json: ${reason}`,
          );
        })
      : null;
    const expectedManifest = canonicalStringify(
      publication.manifest as unknown as Record<string, JsonValue>,
      (reason) => validation(`publication manifest ${reason}`),
    );
    const storedFingerprint = canonicalStoredObjectJson(
      event.detail_json,
      `twi_job_events ${input.jobId}/${input.eventKey} detail_json`,
    );
    if (
      latest.projectId !== input.projectId ||
      latest.phase !== 'complete' ||
      latest.finishedAt === null ||
      storedManifest !== expectedManifest ||
      event.from_status !== 'validating' ||
      event.to_status !== 'complete' ||
      event.phase !== 'complete' ||
      storedFingerprint !== publication.fingerprintJson
    ) {
      collision('candidate publication collision');
    }
    return latest;
  }

  private async findJobById(jobId: string): Promise<JobRecord | null> {
    const row = await this.env.DB.prepare(
      `SELECT ${JOB_COLUMNS}
       FROM twi_jobs j
       JOIN twi_generation_specs s ON s.id = j.spec_id AND s.project_id = j.project_id
       WHERE j.id = ?`,
    )
      .bind(jobId)
      .first<JobRow>();
    return row ? mapJob(row) : null;
  }

  private async findJobEvent(jobId: string, eventKey: string): Promise<JobEventRow | null> {
    return this.env.DB.prepare(
      `SELECT ${EVENT_COLUMNS}
       FROM twi_job_events
       WHERE job_id = ? AND event_key = ?`,
    )
      .bind(jobId, eventKey)
      .first<JobEventRow>();
  }

  private async findAssetById(assetId: string): Promise<AssetRecord | null> {
    const row = await this.env.DB.prepare(
      `SELECT ${ASSET_COLUMNS}
       FROM twi_assets
       WHERE id = ?`,
    )
      .bind(assetId)
      .first<AssetRow>();
    return row ? mapAsset(row) : null;
  }

  private async findAssetByR2Key(r2Key: string): Promise<AssetRecord | null> {
    const row = await this.env.DB.prepare(
      `SELECT ${ASSET_COLUMNS}
       FROM twi_assets
       WHERE r2_key = ?`,
    )
      .bind(r2Key)
      .first<AssetRow>();
    return row ? mapAsset(row) : null;
  }

  private async findCostEvent(jobId: string, idempotencyKey: string): Promise<CostEventRow | null> {
    return this.env.DB.prepare(
      `SELECT ${COST_COLUMNS}
       FROM twi_cost_events
       WHERE job_id = ? AND idempotency_key = ?`,
    )
      .bind(jobId, idempotencyKey)
      .first<CostEventRow>();
  }
}
