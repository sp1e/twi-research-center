// @vitest-environment node
/// <reference types="node" />
//
// Fake-D1 suite: records SQL and bindings, returns scripted results. This is the
// only place statement shape and binding order can be asserted. Behaviour is
// proven against a real database in `repository-sqlite.test.ts`, and D1's own
// batch semantics in `repository-d1.test.ts`.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  D1TwiRepository,
  TwiRepositoryValidationError,
  type PublishCandidatesInput,
  type TwiRepositoryEvent,
} from './repository';
import {
  assetInput,
  assetRow,
  candidateA,
  candidateB,
  completeJobRow,
  jobRow,
  normalized,
  projectRow,
  publicationEventRow,
  publicationFingerprint,
  publicationInput,
  transitionFingerprint,
} from './repository.fixtures';
import { ScriptedD1, changed, rows } from './repository.harness';

const generatingOptions = {
  fromStatus: 'queued' as const,
  phase: 'generating' as const,
  retryCheckpoint: null,
  now: '2026-08-16T04:30:00.000Z',
  eventKey: 'job-1:generating:1',
  detailJson: '{"z":1,"attempt":1}',
};

const transitionEventRow = {
  event_key: 'job-1:generating:1',
  from_status: 'queued',
  to_status: 'generating',
  phase: 'generating',
  detail_json: transitionFingerprint(),
  created_at: '2026-08-16T04:00:00.000Z',
};

describe('D1TwiRepository fast behavior', () => {
  let db: ScriptedD1;
  let repository: D1TwiRepository;

  beforeEach(() => {
    db = new ScriptedD1();
    repository = new D1TwiRepository({ DB: db });
  });

  it('maps project rows and keeps active newest-first query semantics', async () => {
    db.allResults.push(rows([projectRow]));
    const projects = await repository.listProjects();

    expect(projects[0]).toEqual({
      id: 'project-1',
      name: 'Night Signal',
      currentRevisionId: 'revision-2',
      lifecycleState: 'active',
      deletedAt: null,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T01:00:00.000Z',
    });
    expect(projects[0]).not.toHaveProperty('current_revision_id');
    expect(normalized(db.statements[0]!.sql)).toContain("WHERE lifecycle_state = 'active' ORDER BY updated_at DESC");
    expect(db.drained()).toBe(true);
  });

  it('creates, gets, and saves validated records with canonical object JSON', async () => {
    db.runResults.push(changed(1), changed(1));
    db.firstResults.push(projectRow);

    await expect(
      repository.createProject({ id: 'project-2', name: 'Glass Current', now: '2026-08-16T02:00:00.000Z' }),
    ).resolves.toMatchObject({ id: 'project-2', lifecycleState: 'active' });

    await expect(repository.getProject('project-1')).resolves.toMatchObject({ id: 'project-1' });

    await expect(
      repository.saveSpec({
        id: 'spec-1',
        projectId: 'project-1',
        specJson: '{"z":1,"a":{"d":2,"c":3}}',
        specSha256: 'spec-sha',
        rightsAssertionVersion: '2026-08-16',
        createdAt: '2026-08-16T02:00:00.000Z',
      }),
    ).resolves.toMatchObject({ spec: { a: { c: 3, d: 2 }, z: 1 } });
    expect(db.statements.at(-1)!.bindings).toContain('{"a":{"c":3,"d":2},"z":1}');
    expect(db.drained()).toBe(true);
  });

  it('scopes idempotency lookup to project and spec hash and maps the hash', async () => {
    db.firstResults.push(jobRow, jobRow, jobRow);

    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-1',
        idempotencyKey: 'submission-1',
        specSha256: 'spec-sha',
      }),
    ).resolves.toMatchObject({ projectId: 'project-1', specSha256: 'spec-sha' });
    expect(normalized(db.statements[0]!.sql)).toContain('JOIN twi_generation_specs');

    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-2',
        idempotencyKey: 'submission-1',
        specSha256: 'spec-sha',
      }),
    ).rejects.toThrow(/^job idempotency collision$/);

    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-1',
        idempotencyKey: 'submission-1',
        specSha256: 'different-sha',
      }),
    ).rejects.toThrow(/^job idempotency collision$/);
    expect(db.drained()).toBe(true);
  });

  it('creates an estimated job/event/cost atomically with canonical replay payloads', async () => {
    db.batchResults.push([changed(1), changed(1), changed(1)]);
    db.firstResults.push({
      ...jobRow,
      id: 'job-2',
      status: 'estimated',
      phase: null,
      idempotency_key: 'submission-2',
      estimate_json: '{"total":2.5}',
      actual_cost_usd: 0,
      workflow_id: null,
      created_at: '2026-08-16T03:00:00.000Z',
      updated_at: '2026-08-16T03:00:00.000Z',
    });
    const created = await repository.createEstimatedJob({
      id: 'job-2',
      projectId: 'project-1',
      specId: 'spec-1',
      idempotencyKey: 'submission-2',
      estimateJson: '{"total":2.5}',
      estimateAmountUsd: 2.5,
      provider: 'google',
      model: 'lyria-3-pro-preview',
      eventKey: 'job-2:estimated',
      eventDetailJson: '{"z":1,"a":2}',
      costIdempotencyKey: 'job-2:estimate',
      costDetailJson: '{"basis":"maximum-quality"}',
      now: '2026-08-16T03:00:00.000Z',
    });

    expect(created.outcome).toBe('created');
    expect(created.job).toMatchObject({ status: 'estimated', specSha256: 'spec-sha', estimate: { total: 2.5 } });
    expect(db.statements.at(-1)!.sql).toContain('JOIN twi_generation_specs');
    expect(db.batches[0]).toHaveLength(3);
    expect(db.batches[0]![1]!.bindings).toContain('job-2:estimated');
    expect(db.batches[0]![1]!.bindings).toContain('{"a":2,"z":1}');
    expect(db.batches[0]![2]!.bindings).toContain('job-2:estimate');
    expect(db.drained()).toBe(true);
  });

  it('preserves the exact first transition update and chains metadata/event guards', async () => {
    db.firstResults.push(
      jobRow,
      null,
      { ...jobRow, status: 'generating', phase: 'generating', updated_at: '2026-08-16T04:00:00.000Z' },
    );
    db.batchResults.push([changed(1), changed(1), changed(1)]);

    const transitioned = await repository.transitionJob('job-1', 'generating', {
      ...generatingOptions,
      now: '2026-08-16T04:00:00.000Z',
    });

    const update = db.batches[0]![0]!;
    const metadata = db.batches[0]![1]!;
    const event = db.batches[0]![2]!;
    expect(normalized(update.sql)).toBe(
      'UPDATE twi_jobs SET status = ?, phase = ?, updated_at = MAX(updated_at, ?), error_code = ?, error_message = ? WHERE id = ? AND status = ?',
    );
    expect(update.bindings).toEqual([
      'generating',
      'generating',
      '2026-08-16T04:00:00.000Z',
      null,
      null,
      'job-1',
      'queued',
    ]);
    expect(normalized(metadata.sql)).toContain('finished_at = ?, retry_checkpoint = ?');
    expect(normalized(metadata.sql)).toContain('changes() = 1');
    expect(normalized(event.sql)).toMatch(/INSERT INTO twi_job_events .* WHERE changes\(\) = 1/i);
    expect(event.bindings).toContain(transitionFingerprint());
    expect(transitioned.outcome).toBe('applied');
    expect(transitioned.job).toMatchObject({ status: 'generating', finishedAt: null, retryCheckpoint: null });
    expect(db.drained()).toBe(true);
  });

  it('reconciles a lost transition response and rejects a stable-key collision', async () => {
    const current = { ...jobRow, status: 'ingesting', phase: 'ingesting' };
    db.firstResults.push(current, transitionEventRow, current);

    const replayed = await repository.transitionJob('job-1', 'generating', generatingOptions);
    expect(replayed).toMatchObject({ outcome: 'replayed', job: { status: 'ingesting' } });
    expect(db.batches).toHaveLength(0);

    db.firstResults.push(current, transitionEventRow);
    await expect(
      repository.transitionJob('job-1', 'generating', { ...generatingOptions, detailJson: '{"attempt":2}' }),
    ).rejects.toThrow(/^transition idempotency collision$/);

    db.firstResults.push(current, transitionEventRow);
    await expect(
      repository.transitionJob('job-1', 'generating', {
        ...generatingOptions,
        fromStatus: 'estimated',
        detailJson: '{"attempt":1,"z":1}',
      }),
    ).rejects.toThrow(/^transition idempotency collision$/);
    expect(db.drained()).toBe(true);
  });

  it('re-reads latest state when an exact event appears after the initial job read', async () => {
    const latest = { ...jobRow, status: 'generating', phase: 'generating' };
    db.firstResults.push(jobRow, transitionEventRow, latest);

    const replayed = await repository.transitionJob('job-1', 'generating', {
      ...generatingOptions,
      detailJson: '{"attempt":1,"z":1}',
    });
    expect(replayed).toMatchObject({ outcome: 'replayed', job: { status: 'generating' } });
    expect(db.batches).toHaveLength(0);
    expect(db.drained()).toBe(true);
  });

  it('refuses to complete a job through transitionJob, naming publishCandidates', async () => {
    await expect(
      repository.transitionJob('job-1', 'complete', {
        fromStatus: 'validating',
        phase: 'complete',
        retryCheckpoint: null,
        now: '2026-08-16T05:00:00.000Z',
        eventKey: 'job-1:complete',
      }),
    ).rejects.toThrow(/publishCandidates/);
    await expect(
      repository.transitionJob('job-1', 'complete', {
        fromStatus: 'cancelling',
        phase: 'complete',
        retryCheckpoint: null,
        now: '2026-08-16T05:00:00.000Z',
        eventKey: 'job-1:complete',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    expect(db.statements).toHaveLength(0);
  });

  it('rejects every non-ISO timestamp before it can reach a binding', async () => {
    const badTimestamps = [
      'now',
      '2026-08-16 05:00:00',
      '2026-08-16T05:00:00Z',
      '2026-08-16T05:00:00+02:00',
      '2026-02-30T00:00:00.000Z',
      '2026-08-16T24:00:00.000Z',
      '1786856400000',
    ];

    for (const now of badTimestamps) {
      await expect(
        repository.createProject({ id: 'project-2', name: 'Glass Current', now }),
        now,
      ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
      await expect(
        repository.transitionJob('job-1', 'generating', { ...generatingOptions, now }),
        now,
      ).rejects.toThrow(/transition\.now must be an ISO-8601 UTC timestamp/);
      await expect(repository.publishCandidates(publicationInput({ now })), now).rejects.toBeInstanceOf(
        TwiRepositoryValidationError,
      );
      await expect(
        repository.appendCost({
          jobId: 'job-1',
          idempotencyKey: 'provider:request-1',
          category: 'provider',
          provider: null,
          model: null,
          amountUsd: 1,
          quantity: null,
          detailJson: '{}',
          createdAt: now,
        }),
        now,
      ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
      await expect(
        repository.registerAsset({ ...assetInput, createdAt: now }),
        now,
      ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
      await expect(
        repository.saveSpec({
          id: 'spec-1',
          projectId: 'project-1',
          specJson: '{}',
          specSha256: 'sha',
          rightsAssertionVersion: 'v1',
          createdAt: now,
        }),
        now,
      ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
      await expect(
        repository.createEstimatedJob({
          id: 'job-2',
          projectId: 'project-1',
          specId: 'spec-1',
          idempotencyKey: 'submission-2',
          estimateJson: '{}',
          estimateAmountUsd: 1,
          provider: null,
          model: null,
          eventKey: 'job-2:estimated',
          eventDetailJson: '{}',
          costIdempotencyKey: 'job-2:estimate',
          costDetailJson: '{}',
          now,
        }),
        now,
      ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    }

    await expect(
      repository.registerAsset({ ...assetInput, lifecycleState: 'deleted', deletedAt: 'yesterday' }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);

    // Nothing above reached the driver: a bad timestamp can never be bound.
    expect(db.statements).toHaveLength(0);
  });

  it('enforces error, terminal, and retry checkpoint metadata invariants before binding', async () => {
    await expect(
      repository.transitionJob('job-1', 'error', {
        fromStatus: 'generating',
        phase: 'error',
        retryCheckpoint: null,
        now: '2026-08-16T04:00:00.000Z',
        eventKey: 'job-1:error:1',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);

    await expect(
      repository.transitionJob('job-1', 'generating', {
        fromStatus: 'queued',
        phase: 'generating',
        retryCheckpoint: 'generating',
        now: '2026-08-16T04:00:00.000Z',
        eventKey: 'job-1:generating:stale-checkpoint',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(
      repository.saveSpec({
        id: 'spec-infinite',
        projectId: 'project-1',
        specJson: '{"nested":[1e400]}',
        specSha256: 'sha',
        rightsAssertionVersion: 'v1',
        createdAt: '2026-08-16T02:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(
      repository.appendCost({
        jobId: 'job-1',
        idempotencyKey: 'cost-infinite-json',
        category: 'provider',
        provider: null,
        model: null,
        amountUsd: 1,
        quantity: null,
        detailJson: '{"nested":{"bad":1e400}}',
        createdAt: '2026-08-16T04:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    expect(db.statements).toHaveLength(0);

    await expect(
      repository.transitionJob('job-1', 'generating', {
        fromStatus: 'queued',
        phase: 'generating',
        retryCheckpoint: null,
        errorCode: 'unexpected',
        errorMessage: 'unexpected',
        now: '2026-08-16T04:00:00.000Z',
        eventKey: 'job-1:generating:1',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);

    db.firstResults.push(
      { ...jobRow, status: 'generating', phase: 'generating' },
      null,
      {
        ...jobRow,
        status: 'error',
        phase: 'error',
        retry_checkpoint: 'generating',
        error_code: 'provider_failed',
        error_message: 'Provider failed',
        updated_at: '2026-08-16T04:00:00.000Z',
        finished_at: '2026-08-16T04:00:00.000Z',
      },
    );
    db.batchResults.push([changed(1), changed(1), changed(1)]);
    await expect(
      repository.transitionJob('job-1', 'error', {
        fromStatus: 'generating',
        phase: 'error',
        retryCheckpoint: 'generating',
        errorCode: 'provider_failed',
        errorMessage: 'Provider failed',
        now: '2026-08-16T04:00:00.000Z',
        eventKey: 'job-1:error:1',
      }),
    ).resolves.toMatchObject({
      outcome: 'applied',
      job: { status: 'error', retryCheckpoint: 'generating', finishedAt: '2026-08-16T04:00:00.000Z' },
    });

    db.firstResults.push(
      {
        ...jobRow,
        status: 'error',
        phase: 'error',
        retry_checkpoint: 'generating',
        error_code: 'provider_failed',
        error_message: 'Provider failed',
        finished_at: '2026-08-16T04:00:00.000Z',
      },
      null,
      {
        ...jobRow,
        status: 'retrying',
        phase: 'retrying',
        retry_checkpoint: 'generating',
        updated_at: '2026-08-16T04:15:00.000Z',
      },
    );
    db.batchResults.push([changed(1), changed(1), changed(1)]);
    await expect(
      repository.transitionJob('job-1', 'retrying', {
        fromStatus: 'error',
        phase: 'retrying',
        retryCheckpoint: 'generating',
        now: '2026-08-16T04:15:00.000Z',
        eventKey: 'job-1:retrying:1',
      }),
    ).resolves.toMatchObject({
      job: { status: 'retrying', retryCheckpoint: 'generating', finishedAt: null },
    });

    db.firstResults.push(
      { ...jobRow, status: 'retrying', phase: 'retrying', retry_checkpoint: 'generating' },
      null,
      {
        ...jobRow,
        status: 'generating',
        phase: 'generating',
        retry_checkpoint: null,
        updated_at: '2026-08-16T04:30:00.000Z',
      },
    );
    db.batchResults.push([changed(1), changed(1), changed(1)]);
    await expect(
      repository.transitionJob('job-1', 'generating', {
        fromStatus: 'retrying',
        phase: 'generating',
        retryCheckpoint: null,
        now: '2026-08-16T04:30:00.000Z',
        eventKey: 'job-1:resume:1',
      }),
    ).resolves.toMatchObject({ job: { retryCheckpoint: null, finishedAt: null } });
    expect(db.drained()).toBe(true);
  });

  it('separates a stale precondition from a lost guard so operators can tell them apart', async () => {
    db.firstResults.push({ ...jobRow, status: 'ingesting', phase: 'ingesting' }, null);
    await expect(repository.transitionJob('job-1', 'generating', generatingOptions)).rejects.toMatchObject({
      name: 'TwiRepositoryConflictError',
      message: 'job transition precondition failed',
      context: { jobId: 'job-1', expectedFrom: 'queued', observedStatus: 'ingesting', to: 'generating' },
    });
    expect(db.batches).toHaveLength(0);

    db.firstResults.push(jobRow, null, null);
    db.batchResults.push([changed(0), changed(0), changed(0)]);
    await expect(repository.transitionJob('job-1', 'generating', generatingOptions)).rejects.toMatchObject({
      name: 'TwiRepositoryConflictError',
      message: 'job transition conflict',
      context: { jobId: 'job-1', from: 'queued', to: 'generating', changes: [0, 0, 0] },
    });
    expect(db.drained()).toBe(true);
  });

  it('reconciles asset replay and rejects immutable payload or r2-key collisions', async () => {
    db.firstResults.push(assetRow);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual({
      asset: assetInput,
      outcome: 'replayed',
    });
    expect(db.runResults).toHaveLength(0);

    db.firstResults.push(assetRow);
    await expect(repository.registerAsset({ ...assetInput, bytes: 4097 })).rejects.toThrow(
      /^asset idempotency collision on id$/,
    );

    db.firstResults.push(null, assetRow);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual({
      asset: assetInput,
      outcome: 'replayed',
    });

    db.firstResults.push(null, { ...assetRow, id: 'different-asset' });
    await expect(repository.registerAsset(assetInput)).rejects.toThrow(
      /^asset idempotency collision on r2Key$/,
    );
    expect(db.drained()).toBe(true);
  });

  it('reconciles exact cost replay without timestamp mutation and rejects collisions', async () => {
    const costRow = {
      job_id: 'job-1',
      idempotency_key: 'provider:request-1',
      category: 'provider',
      provider: 'google',
      model: 'lyria-3-pro-preview',
      amount_usd: 0.75,
      quantity: 122.5,
      detail_json: '{"requestId":"request-1"}',
      created_at: '2026-08-16T04:00:00.000Z',
    };
    const input = {
      jobId: 'job-1',
      idempotencyKey: 'provider:request-1',
      category: 'provider' as const,
      provider: 'google',
      model: 'lyria-3-pro-preview',
      amountUsd: 0.75,
      quantity: 122.5,
      detailJson: '{"requestId":"request-1"}',
      createdAt: '2026-08-16T05:00:00.000Z',
    };

    db.firstResults.push(costRow);
    await expect(repository.appendCost(input)).resolves.toEqual({ inserted: false });
    expect(db.batches).toHaveLength(0);

    db.firstResults.push(costRow);
    await expect(repository.appendCost({ ...input, amountUsd: 0.8 })).rejects.toThrow(/^cost idempotency collision$/);

    db.firstResults.push(null, costRow);
    db.batchResults.push([changed(0), changed(0)]);
    await expect(repository.appendCost(input)).resolves.toEqual({ inserted: false });
    const aggregate = db.batches[0]![1]!;
    expect(normalized(aggregate.sql)).toContain("category <> 'estimate'");
    expect(normalized(aggregate.sql)).toContain('updated_at = MAX(updated_at, ?)');
    expect(normalized(aggregate.sql)).toContain('changes() = 1');
    expect(db.drained()).toBe(true);
  });

  it('validates cost, asset, lifecycle, and object JSON inputs before D1 binding', async () => {
    await expect(
      repository.appendCost({
        jobId: 'job-1',
        idempotencyKey: 'cost-1',
        category: 'provider',
        provider: null,
        model: null,
        amountUsd: Number.POSITIVE_INFINITY,
        quantity: null,
        detailJson: '{}',
        createdAt: '2026-08-16T04:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(repository.registerAsset({ ...assetInput, bytes: 1.5 })).rejects.toBeInstanceOf(
      TwiRepositoryValidationError,
    );
    await expect(
      repository.registerAsset({ ...assetInput, bytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(
      repository.registerAsset({ ...assetInput, lifecycleState: 'deleted', deletedAt: null }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(
      repository.saveSpec({
        id: 'spec-1',
        projectId: 'project-1',
        specJson: '[]',
        specSha256: 'sha',
        rightsAssertionVersion: 'v1',
        createdAt: '2026-08-16T02:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    expect(db.statements).toHaveLength(0);
  });

  it('requires exactly A and B with eight globally unique publication asset IDs', async () => {
    const missingB = [candidateA] as unknown as PublishCandidatesInput['candidates'];
    await expect(repository.publishCandidates(publicationInput({ candidates: missingB }))).rejects.toBeInstanceOf(
      TwiRepositoryValidationError,
    );
    await expect(
      repository.publishCandidates(
        publicationInput({ candidates: [candidateA, { ...candidateB, rawAssetId: candidateA.rawAssetId }] }),
      ),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(
      repository.publishCandidates(publicationInput({ candidates: [candidateA, { ...candidateB, label: 'A' }] })),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    expect(db.statements).toHaveLength(0);
  });

  it('derives the manifest, binds the observed from-status, and guards all eight pairs', async () => {
    db.firstResults.push({ ...jobRow, status: 'validating', phase: 'validating' }, completeJobRow());
    db.batchResults.push([changed(8), changed(1), changed(1)]);

    const published = await repository.publishCandidates(publicationInput());
    expect(published.outcome).toBe('published');

    const assets = db.batches[0]![0]!;
    const job = db.batches[0]![1]!;
    const event = db.batches[0]![2]!;
    expect(assets.bindings).toEqual(
      expect.arrayContaining([
        'A',
        'B',
        'generation-raw',
        'generation-master',
        'generation-preview',
        'provenance',
      ]),
    );
    expect(normalized(assets.sql)).toContain("lifecycle_state = 'provisional'");
    // The publishing status is bound, not hardcoded, so `cancelling → complete`
    // is served by the same statement.
    expect(normalized(assets.sql)).toContain('AND status = ?');
    expect(assets.bindings).toContain('validating');
    expect(normalized(job.sql)).toContain('changes() = 8');
    expect(normalized(job.sql)).toContain('updated_at = MAX(updated_at, ?)');
    expect(job.bindings.at(-1)).toBe('validating');
    expect(event.bindings[2]).toBe('validating');
    const manifest = JSON.parse(job.bindings[0] as string) as Record<string, unknown>;
    expect(manifest).toEqual({ schemaVersion: 1, candidates: [candidateA, candidateB] });
    expect(event.bindings).toContain(publicationFingerprint());
    expect(db.drained()).toBe(true);
  });

  it('reconciles exact publication replay and rejects a completed-job collision', async () => {
    db.firstResults.push(completeJobRow(), publicationEventRow());
    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({
      outcome: 'replayed',
      job: { status: 'complete' },
    });
    expect(db.batches).toHaveLength(0);

    db.firstResults.push(completeJobRow(), publicationEventRow());
    await expect(
      repository.publishCandidates(
        publicationInput({ candidates: [candidateA, { ...candidateB, previewAssetId: 'different-preview' }] }),
      ),
    ).rejects.toThrow(/^candidate publication collision$/);
    expect(db.drained()).toBe(true);
  });

  it('wraps corrupt stored JSON with record and field context', async () => {
    db.firstResults.push({ ...jobRow, estimate_json: '{broken' });
    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-1',
        idempotencyKey: 'submission-1',
        specSha256: 'spec-sha',
      }),
    ).rejects.toMatchObject({
      name: 'TwiRepositoryCorruptionError',
      message: expect.stringContaining('twi_jobs job-1 estimate_json'),
    });
    expect(db.drained()).toBe(true);
  });

  it('reports every write through the optional event sink without letting it break a write', async () => {
    const events: TwiRepositoryEvent[] = [];
    const observed = new D1TwiRepository(
      { DB: db },
      {
        onEvent: (event) => {
          events.push(event);
          throw new Error('sink exploded');
        },
      },
    );

    db.runResults.push(changed(1));
    await expect(
      observed.createProject({ id: 'project-3', name: 'Sink', now: '2026-08-16T02:00:00.000Z' }),
    ).resolves.toMatchObject({ id: 'project-3' });

    db.firstResults.push(jobRow, null, { ...jobRow, status: 'generating', phase: 'generating' });
    db.batchResults.push([changed(1), changed(1), changed(1)]);
    await observed.transitionJob('job-1', 'generating', generatingOptions);

    expect(events.map(({ op, outcome }) => ({ op, outcome }))).toEqual([
      { op: 'createProject', outcome: 'created' },
      { op: 'transitionJob', outcome: 'applied' },
    ]);
    expect(events[1]).toMatchObject({ jobId: 'job-1', projectId: 'project-1' });
    expect(typeof events[1]!.durationMs).toBe('number');
    expect(db.drained()).toBe(true);
  });
});
