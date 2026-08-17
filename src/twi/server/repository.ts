import { assertTransition } from '../domain/job-state';
import type { JobStatus } from '../domain/types';

import { assertNonBlank, assertTimestamp } from './assertions';
import { parseInputObjectJson } from './canonical-json';
import type { D1ResultLike, TwiRepositoryEnv } from './d1-types';
import { collision, conflict, validation } from './errors';
import { mapJob, mapProject } from './mappers';
import {
  costStatements,
  estimatedJobStatements,
  findAssetById,
  findAssetByR2Key,
  findCostEvent,
  findJobById,
  findJobEvent,
  insertAsset,
  insertProject,
  insertSpec,
  publicationStatements,
  selectActiveProjects,
  selectJobRowByKey,
  selectProject,
  transitionStatements,
} from './queries';
import {
  findUnmatchedPublicationPairs,
  reconcileCost,
  reconcileEstimatedJob,
  reconcilePublication,
  reconcileTransition,
} from './reconciliation';
import {
  RETRY_CHECKPOINTS,
  type AppendCostInput,
  type AppendCostResult,
  type AssetRecord,
  type CreateEstimatedJobInput,
  type CreateEstimatedJobResult,
  type CreateProjectInput,
  type FindJobByIdempotencyKeyInput,
  type GenerationSpecRecord,
  type JobRecord,
  type ProjectRecord,
  type PublishCandidatesInput,
  type PublishCandidatesOutcome,
  type PublishCandidatesResult,
  type RegisterAssetInput,
  type RegisterAssetOutcome,
  type RegisterAssetResult,
  type RetryCheckpoint,
  type SaveSpecInput,
  type TransitionJobOptions,
  type TransitionJobResult,
  type TransitionOutcome,
  type TwiRepository,
  type TwiRepositoryEvent,
  type TwiRepositoryEventSink,
  type TwiRepositoryOptions,
} from './repository-types';
import {
  assetMatchesInput,
  costMatchesInput,
  validateAssetInput,
  validateCostInput,
  validateCreateEstimatedJobInput,
  validatePublicationInput,
  validateTransitionInput,
} from './validation';

// ---------------------------------------------------------------------------
// Public surface. The boundary is assembled from focused modules, but every name
// Task 5+ imports still resolves from `./repository`.
// ---------------------------------------------------------------------------

export type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike, TwiRepositoryEnv } from './d1-types';
export {
  TwiRepositoryCollisionError,
  TwiRepositoryConflictError,
  TwiRepositoryCorruptionError,
  TwiRepositoryValidationError,
} from './errors';
export type {
  AppendCostInput,
  AppendCostResult,
  AssetLifecycleState,
  AssetRecord,
  CandidateLabel,
  CandidatePublicationEntry,
  CandidatePublicationManifest,
  CostCategory,
  CreateEstimatedJobInput,
  CreateEstimatedJobOutcome,
  CreateEstimatedJobResult,
  CreateProjectInput,
  FindJobByIdempotencyKeyInput,
  GenerationSpecRecord,
  JobKind,
  JobRecord,
  ProjectLifecycleState,
  ProjectRecord,
  PublishCandidatesInput,
  PublishCandidatesOutcome,
  PublishCandidatesResult,
  RegisterAssetInput,
  RegisterAssetOutcome,
  RegisterAssetResult,
  RetryCheckpoint,
  SaveSpecInput,
  TransitionJobOptions,
  TransitionJobResult,
  TransitionOutcome,
  TwiRepository,
  TwiRepositoryEvent,
  TwiRepositoryEventSink,
  TwiRepositoryOptions,
} from './repository-types';

const changesOf = (results: D1ResultLike[]): Array<number | null> =>
  results.map((result) => result?.meta.changes ?? null);

const allChangesAre = (results: D1ResultLike[], expected: number[]): boolean =>
  results.length === expected.length &&
  expected.every((count, index) => results[index]?.meta.changes === count);

export class D1TwiRepository implements TwiRepository {
  private readonly onEvent: TwiRepositoryEventSink | undefined;

  constructor(
    private readonly env: TwiRepositoryEnv,
    options: TwiRepositoryOptions = {},
  ) {
    this.onEvent = options.onEvent;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const result = await selectActiveProjects(this.env.DB);
    return result.results.map(mapProject);
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const startedAt = Date.now();
    assertNonBlank('project.id', input.id);
    assertNonBlank('project.name', input.name);
    assertTimestamp('project.now', input.now);
    const result = await insertProject(this.env.DB, input).run();
    if (result.meta.changes !== 1) {
      conflict('project insert conflict', { projectId: input.id, changes: result.meta.changes });
    }
    this.emit({ op: 'createProject', projectId: input.id, outcome: 'created', durationMs: Date.now() - startedAt });
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
    const row = await selectProject(this.env.DB, projectId);
    return row ? mapProject(row) : null;
  }

  async saveSpec(input: SaveSpecInput): Promise<GenerationSpecRecord> {
    const startedAt = Date.now();
    assertNonBlank('spec.id', input.id);
    assertNonBlank('spec.projectId', input.projectId);
    assertNonBlank('spec.specSha256', input.specSha256);
    assertNonBlank('spec.rightsAssertionVersion', input.rightsAssertionVersion);
    assertTimestamp('spec.createdAt', input.createdAt);
    const spec = parseInputObjectJson('spec.specJson', input.specJson);
    const result = await insertSpec(this.env.DB, input, spec.canonical).run();
    if (result.meta.changes !== 1) {
      conflict('generation spec insert conflict', { specId: input.id, changes: result.meta.changes });
    }
    this.emit({
      op: 'saveSpec',
      projectId: input.projectId,
      outcome: 'created',
      durationMs: Date.now() - startedAt,
    });
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
    const row = await selectJobRowByKey(this.env.DB, input.idempotencyKey);
    if (!row) return null;
    if (row.project_id !== input.projectId || row.spec_sha256 !== input.specSha256) {
      collision('job idempotency collision', {
        idempotencyKey: input.idempotencyKey,
        expectedProjectId: input.projectId,
        observedProjectId: row.project_id,
      });
    }
    return mapJob(row);
  }

  async createEstimatedJob(input: CreateEstimatedJobInput): Promise<CreateEstimatedJobResult> {
    const startedAt = Date.now();
    const validated = validateCreateEstimatedJobInput(input);
    let results: D1ResultLike[];
    try {
      results = await this.env.DB.batch(estimatedJobStatements(this.env.DB, input, validated));
    } catch (error) {
      // `twi_jobs.idempotency_key` is UNIQUE, so a double-submitted request loses
      // this batch. Reconcile into the winner rather than leaking a driver error.
      const replay = await reconcileEstimatedJob(this.env.DB, input, validated, error);
      if (replay) return this.finishEstimatedJob(replay, 'replayed', startedAt);
      throw error;
    }
    if (!allChangesAre(results, [1, 1, 1])) {
      const replay = await reconcileEstimatedJob(this.env.DB, input, validated);
      if (replay) return this.finishEstimatedJob(replay, 'replayed', startedAt);
      conflict('estimated job creation conflict', { jobId: input.id, changes: changesOf(results) });
    }
    const created = await findJobById(this.env.DB, input.id);
    if (!created) conflict('estimated job readback conflict', { jobId: input.id });
    return this.finishEstimatedJob(created, 'created', startedAt);
  }

  async transitionJob(
    jobId: string,
    to: JobStatus,
    options: TransitionJobOptions,
  ): Promise<TransitionJobResult> {
    const startedAt = Date.now();
    const { fingerprintJson } = validateTransitionInput(jobId, to, options);
    const current = await findJobById(this.env.DB, jobId);
    if (!current) conflict('transition job not found', { jobId, to, eventKey: options.eventKey });

    const known = await findJobEvent(this.env.DB, jobId, options.eventKey);
    if (known) {
      const replay = await reconcileTransition(this.env.DB, jobId, options, to, fingerprintJson, known);
      if (replay) return this.finishTransition(replay, 'replayed', jobId, startedAt);
    }

    const from = options.fromStatus;
    if (current.status !== from) {
      conflict('job transition precondition failed', {
        jobId,
        to,
        eventKey: options.eventKey,
        expectedFrom: from,
        observedStatus: current.status,
      });
    }
    assertTransition(from, to);
    if (from === 'retrying' && RETRY_CHECKPOINTS.includes(to as RetryCheckpoint) && options.retryCheckpoint !== null) {
      validation('resumed work transition must clear retryCheckpoint', { jobId, to });
    }

    let results: D1ResultLike[];
    try {
      results = await this.env.DB.batch(transitionStatements(this.env.DB, jobId, to, options, fingerprintJson));
    } catch (error) {
      const replay = await reconcileTransition(this.env.DB, jobId, options, to, fingerprintJson);
      if (replay) return this.finishTransition(replay, 'reconciled', jobId, startedAt);
      throw error;
    }
    if (!allChangesAre(results, [1, 1, 1])) {
      const replay = await reconcileTransition(this.env.DB, jobId, options, to, fingerprintJson);
      if (replay) return this.finishTransition(replay, 'reconciled', jobId, startedAt);
      conflict('job transition conflict', {
        jobId,
        from,
        to,
        eventKey: options.eventKey,
        changes: changesOf(results),
      });
    }
    const transitioned = await findJobById(this.env.DB, jobId);
    if (!transitioned) conflict('job transition readback conflict', { jobId, to });
    return this.finishTransition(transitioned, 'applied', jobId, startedAt);
  }

  async appendCost(input: AppendCostInput): Promise<AppendCostResult> {
    const startedAt = Date.now();
    const detailJson = validateCostInput(input);
    const context = { jobId: input.jobId, idempotencyKey: input.idempotencyKey };
    const existing = await findCostEvent(this.env.DB, input.jobId, input.idempotencyKey);
    if (existing) {
      if (!costMatchesInput(existing, input, detailJson)) collision('cost idempotency collision', context);
      return this.finishCost(false, input, startedAt);
    }

    let results: D1ResultLike[];
    try {
      results = await this.env.DB.batch(costStatements(this.env.DB, input, detailJson));
    } catch (error) {
      if (await reconcileCost(this.env.DB, input, detailJson, context, error)) {
        return this.finishCost(false, input, startedAt);
      }
      // A foreign-key violation on `job_id` is a caller mistake, not an outage;
      // name it instead of leaking the driver's message.
      const job = await findJobById(this.env.DB, input.jobId);
      if (!job) conflict('cost job not found', { ...context, category: input.category }, error);
      throw error;
    }

    if (results[0]?.meta.changes === 1) {
      if (results[1]?.meta.changes !== 1) {
        conflict('cost append conflict', { ...context, changes: changesOf(results) });
      }
      return this.finishCost(true, input, startedAt);
    }
    const raced = { ...context, changes: changesOf(results) };
    if (!(await reconcileCost(this.env.DB, input, detailJson, raced))) {
      collision('cost idempotency collision after race', raced);
    }
    return this.finishCost(false, input, startedAt);
  }

  async registerAsset(input: RegisterAssetInput): Promise<RegisterAssetResult> {
    const startedAt = Date.now();
    validateAssetInput(input);
    const existingById = await findAssetById(this.env.DB, input.id);
    if (existingById) {
      if (!assetMatchesInput(existingById, input)) {
        collision('asset idempotency collision on id', { assetId: input.id, r2Key: input.r2Key });
      }
      return this.finishAsset(existingById, 'replayed', startedAt);
    }
    const existingByKey = await findAssetByR2Key(this.env.DB, input.r2Key);
    if (existingByKey) {
      if (assetMatchesInput(existingByKey, input)) return this.finishAsset(existingByKey, 'replayed', startedAt);
      collision('asset idempotency collision on r2Key', {
        assetId: input.id,
        r2Key: input.r2Key,
        observedAssetId: existingByKey.id,
      });
    }

    try {
      const result = await insertAsset(this.env.DB, input).run();
      if (result.meta.changes !== 1) {
        conflict('asset insert conflict', { assetId: input.id, changes: result.meta.changes });
      }
      return this.finishAsset({ ...input }, 'inserted', startedAt);
    } catch (error) {
      const racedById = await findAssetById(this.env.DB, input.id);
      if (racedById && assetMatchesInput(racedById, input)) {
        return this.finishAsset(racedById, 'reconciled', startedAt);
      }
      const racedByKey = await findAssetByR2Key(this.env.DB, input.r2Key);
      if (racedByKey && assetMatchesInput(racedByKey, input)) {
        return this.finishAsset(racedByKey, 'reconciled', startedAt);
      }
      if (racedById || racedByKey) {
        collision('asset idempotency collision after race', { assetId: input.id, r2Key: input.r2Key }, error);
      }
      throw error;
    }
  }

  async publishCandidates(input: PublishCandidatesInput): Promise<PublishCandidatesResult> {
    const startedAt = Date.now();
    const publication = validatePublicationInput(input);
    const current = await findJobById(this.env.DB, input.jobId);
    if (!current) conflict('publication job not found', { jobId: input.jobId, projectId: input.projectId });
    if (current.status === 'complete') {
      const replay = await reconcilePublication(this.env.DB, input, publication, current);
      if (replay) return this.finishPublication(replay, 'replayed', input, startedAt);
    }
    // Route completion through the same state machine `transitionJob` obeys, so
    // publication cannot reach 'complete' from a status the model forbids. The
    // modelled `cancelling → complete` edge (late cancel, work already finished)
    // is served here because this is the only writer that attaches a manifest.
    assertTransition(current.status, 'complete');
    const from = current.status;
    const expected = [publication.pairs.length, 1, 1];

    let results: D1ResultLike[];
    try {
      results = await this.env.DB.batch(publicationStatements(this.env.DB, input, publication, from));
    } catch (error) {
      const replay = await reconcilePublication(this.env.DB, input, publication);
      if (replay) return this.finishPublication(replay, 'reconciled', input, startedAt);
      throw error;
    }
    if (!allChangesAre(results, expected)) {
      const replay = await reconcilePublication(this.env.DB, input, publication);
      if (replay) return this.finishPublication(replay, 'reconciled', input, startedAt);
      conflict('candidate publication conflict', {
        jobId: input.jobId,
        projectId: input.projectId,
        fromStatus: from,
        expectedChanges: expected,
        changes: changesOf(results),
        unmatchedPairs: await findUnmatchedPublicationPairs(this.env.DB, input, publication.pairs),
      });
    }
    const completed = await findJobById(this.env.DB, input.jobId);
    if (!completed) conflict('candidate publication readback conflict', { jobId: input.jobId });
    return this.finishPublication(completed, 'published', input, startedAt);
  }

  // -------------------------------------------------------------------------
  // Result shaping and telemetry
  // -------------------------------------------------------------------------

  private emit(event: TwiRepositoryEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch {
      // Telemetry must never break a write. Intentionally swallowed.
    }
  }

  private finishEstimatedJob(
    job: JobRecord,
    outcome: CreateEstimatedJobResult['outcome'],
    startedAt: number,
  ): CreateEstimatedJobResult {
    this.emit({
      op: 'createEstimatedJob',
      jobId: job.id,
      projectId: job.projectId,
      outcome,
      durationMs: Date.now() - startedAt,
    });
    return { job, outcome };
  }

  private finishTransition(
    job: JobRecord,
    outcome: TransitionOutcome,
    jobId: string,
    startedAt: number,
  ): TransitionJobResult {
    this.emit({
      op: 'transitionJob',
      jobId,
      projectId: job.projectId,
      outcome,
      durationMs: Date.now() - startedAt,
    });
    return { job, outcome };
  }

  private finishCost(inserted: boolean, input: AppendCostInput, startedAt: number): AppendCostResult {
    this.emit({
      op: 'appendCost',
      jobId: input.jobId,
      outcome: inserted ? 'inserted' : 'replayed',
      durationMs: Date.now() - startedAt,
    });
    return { inserted };
  }

  private finishAsset(
    asset: AssetRecord,
    outcome: RegisterAssetOutcome,
    startedAt: number,
  ): RegisterAssetResult {
    this.emit({
      op: 'registerAsset',
      jobId: asset.jobId ?? undefined,
      projectId: asset.projectId,
      outcome,
      durationMs: Date.now() - startedAt,
    });
    return { asset, outcome };
  }

  private finishPublication(
    job: JobRecord,
    outcome: PublishCandidatesOutcome,
    input: PublishCandidatesInput,
    startedAt: number,
  ): PublishCandidatesResult {
    this.emit({
      op: 'publishCandidates',
      jobId: input.jobId,
      projectId: input.projectId,
      outcome,
      durationMs: Date.now() - startedAt,
    });
    return { job, outcome };
  }
}
