import { assertTransition } from '../domain/job-state';
import type { JobStatus } from '../domain/types';

import { assertEnum, assertNonBlank, assertNullableNonBlank, assertTimestamp } from './assertions';
import type { D1ResultLike, TwiRepositoryEnv } from './d1-types';
import { collision, conflict, validation } from './errors';
import { mapJob, mapProject } from './mappers';
import type {
  ClaimProviderCallInput,
  ClaimProviderCallResult,
  ProviderCallRecord,
  ResolveProviderCallInput,
  ResolveProviderCallResult,
  SettleProviderCallInput,
  SettleProviderCallResult,
} from './provider-call-types';
import {
  claimProviderCall,
  countUnreconciledProviderCalls,
  listProviderCalls,
  resolveProviderCall,
  settleProviderCall,
} from './provider-calls';
import {
  costStatements,
  countJobEvents,
  countOrphanedSpecs,
  countProjectAssets,
  deleteUnreferencedSpec,
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
  selectJobs,
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
  ASSET_KINDS,
  JOB_STATUSES,
  RETRY_CHECKPOINTS,
  type AppendCostInput,
  type AppendCostResult,
  type AssetRecord,
  type CountJobEventsInput,
  type CountProjectAssetsInput,
  type CreateEstimatedJobInput,
  type CreateEstimatedJobResult,
  type CreateProjectInput,
  type DiscardUnreferencedSpecInput,
  type FindJobByIdempotencyKeyInput,
  type GenerationSpecRecord,
  type JobRecord,
  type ListJobsInput,
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
import { canonicalSpecDocument } from './spec-digest';
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
  CountJobEventsInput,
  CountProjectAssetsInput,
  CreateEstimatedJobInput,
  CreateEstimatedJobOutcome,
  CreateEstimatedJobResult,
  CreateProjectInput,
  FindJobByIdempotencyKeyInput,
  GenerationSpecRecord,
  JobKind,
  JobRecord,
  ListJobsInput,
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
// The provider-call ledger's vocabulary (research P0). The logic lives in ./provider-calls and
// is reached through the D1TwiRepository methods below; the names resolve from here like the rest.
export type {
  ChargeCertainty,
  ClaimProviderCallInput,
  ClaimProviderCallOutcome,
  ClaimProviderCallResult,
  ProviderCallRecord,
  ProviderCallResolution,
  ProviderCallSettledState,
  ProviderCallState,
  ResolveProviderCallInput,
  ResolveProviderCallOutcome,
  ResolveProviderCallResult,
  SettleProviderCallInput,
  SettleProviderCallOutcome,
  SettleProviderCallResult,
} from './provider-call-types';
// The one sanctioned way to fingerprint a spec. `saveSpec` derives the stored
// digest with it; the submit path needs the same value before the spec exists, to
// find a job to replay, and must not roll its own.
export { specSha256 } from './spec-digest';
export type { CanonicalSpecDocument } from './spec-digest';

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
    assertNonBlank('spec.rightsAssertionVersion', input.rightsAssertionVersion);
    assertTimestamp('spec.createdAt', input.createdAt);
    // The digest is derived from the canonical text this call is about to store,
    // never accepted from the caller. See `./spec-digest`.
    const spec = await canonicalSpecDocument('spec.specJson', input.specJson);
    const result = await insertSpec(this.env.DB, input, spec).run();
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
      specSha256: spec.sha256,
      rightsAssertionVersion: input.rightsAssertionVersion,
      createdAt: input.createdAt,
    };
  }

  /**
   * Reaps a specification row nothing references. See {@link TwiRepository} for WHY the
   * write order forces this to exist, and `deleteUnreferencedSpec` for why the guard is in
   * the SQL rather than in the caller.
   *
   * Reports `false` for a row that is still referenced instead of raising, because the
   * caller is compensating for a failure it has already decided to report: a reap that
   * refused would replace the caller's diagnosis with its own.
   */
  async discardUnreferencedSpec(input: DiscardUnreferencedSpecInput): Promise<boolean> {
    const startedAt = Date.now();
    assertNonBlank('spec.projectId', input.projectId);
    assertNonBlank('spec.id', input.id);
    const result = await deleteUnreferencedSpec(this.env.DB, input).run();
    const removed = result.meta.changes === 1;
    this.emit({
      op: 'discardUnreferencedSpec',
      projectId: input.projectId,
      outcome: removed ? 'removed' : 'retained',
      durationMs: Date.now() - startedAt,
    });
    return removed;
  }

  /**
   * The reap's residual as a number. See {@link TwiRepository} for why it is worth counting.
   *
   * No `assertNonBlank` because it takes no input, and no `emit` because it writes nothing —
   * the telemetry channel reports write outcomes, and adding a read to it would make the
   * sink's survivorship bias harder to reason about rather than easier.
   */
  async countOrphanedSpecs(): Promise<number> {
    return countOrphanedSpecs(this.env.DB);
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

  async findAssetById(assetId: string): Promise<AssetRecord | null> {
    assertNonBlank('assetId', assetId);
    return findAssetById(this.env.DB, assetId);
  }

  async findJobById(jobId: string): Promise<JobRecord | null> {
    assertNonBlank('jobId', jobId);
    return findJobById(this.env.DB, jobId);
  }

  async listJobs(input: ListJobsInput): Promise<JobRecord[]> {
    assertNullableNonBlank('jobs.projectId', input.projectId);
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      validation('jobs.limit must be a positive safe integer', { limit: input.limit });
    }
    const result = await selectJobs(this.env.DB, input);
    return result.results.map(mapJob);
  }

  /**
   * Zero ids is answered WITHOUT a query, and that is a correctness guard rather than
   * an optimisation: the statement builds its placeholder list from the array, so an
   * empty list would send `id IN ()` — which SQLite refuses outright.
   */
  async countProjectAssets(input: CountProjectAssetsInput): Promise<number> {
    assertNonBlank('assets.projectId', input.projectId);
    if (input.kind !== null) assertEnum('assets.kind', input.kind, ASSET_KINDS);
    if (input.assetIds.length === 0) return 0;
    input.assetIds.forEach((assetId, index) => assertNonBlank(`assets.assetIds[${index}]`, assetId));
    return countProjectAssets(this.env.DB, input);
  }

  async countJobEvents(input: CountJobEventsInput): Promise<number> {
    assertNonBlank('events.jobId', input.jobId);
    assertEnum('events.toStatus', input.toStatus, JOB_STATUSES);
    return countJobEvents(this.env.DB, input);
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
  // The provider-call ledger (research P0). Logic in ./provider-calls; this class
  // adds the telemetry event, the way every other write here reports itself.
  // -------------------------------------------------------------------------

  async claimProviderCall(input: ClaimProviderCallInput): Promise<ClaimProviderCallResult> {
    const startedAt = Date.now();
    const result = await claimProviderCall(this.env.DB, input);
    this.emit({ op: 'claimProviderCall', jobId: input.jobId, outcome: result.outcome, durationMs: Date.now() - startedAt });
    return result;
  }

  async settleProviderCall(input: SettleProviderCallInput): Promise<SettleProviderCallResult> {
    const startedAt = Date.now();
    const result = await settleProviderCall(this.env.DB, input);
    this.emit({ op: 'settleProviderCall', jobId: input.jobId, outcome: result.outcome, durationMs: Date.now() - startedAt });
    return result;
  }

  async resolveProviderCall(input: ResolveProviderCallInput): Promise<ResolveProviderCallResult> {
    const startedAt = Date.now();
    const result = await resolveProviderCall(this.env.DB, input);
    this.emit({ op: 'resolveProviderCall', jobId: input.jobId, outcome: result.outcome, durationMs: Date.now() - startedAt });
    return result;
  }

  listProviderCalls(jobId: string): Promise<ProviderCallRecord[]> {
    return listProviderCalls(this.env.DB, jobId);
  }

  /** Read-only and estate-wide, like {@link countOrphanedSpecs}: no input, no telemetry. */
  countUnreconciledProviderCalls(): Promise<number> {
    return countUnreconciledProviderCalls(this.env.DB);
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
