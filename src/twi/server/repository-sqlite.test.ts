// @vitest-environment node
/// <reference types="node" />
//
// Behavioural suite: a real in-memory `node:sqlite` database loading the actual
// Task 3 migration, with deterministic race injection. This is what proves the
// guarded SQL is correct; the scripted suite only proves its shape.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  D1TwiRepository,
  TwiRepositoryValidationError,
  type CandidatePublicationEntry,
  type CreateEstimatedJobInput,
} from './repository';
import { isUnreconciledProviderCall } from './provider-call-types';
import {
  assetInput,
  candidateA,
  candidateB,
  publicationFingerprint,
  publicationInput,
  publicationManifest,
  transitionFingerprint,
} from './repository.fixtures';
import { SqliteD1 } from './repository.harness';

const transitionOptions = {
  fromStatus: 'queued' as const,
  phase: 'generating' as const,
  retryCheckpoint: null,
  now: '2026-08-16T04:00:00.000Z',
  eventKey: 'job-1:generating:1',
  detailJson: '{"attempt":1}',
};

const estimatedJobInput = (overrides: Partial<CreateEstimatedJobInput> = {}): CreateEstimatedJobInput => ({
  id: 'job-created',
  projectId: 'project-1',
  specId: 'spec-1',
  idempotencyKey: 'submission-created',
  estimateJson: '{"total":1}',
  estimateAmountUsd: 1,
  provider: 'google',
  model: 'lyria-3-pro-preview',
  eventKey: 'job-created:estimated',
  eventDetailJson: '{}',
  costIdempotencyKey: 'job-created:estimate',
  costDetailJson: '{}',
  now: '2026-08-16T03:00:00.000Z',
  ...overrides,
});

function seedProjectSpecJob(
  db: SqliteD1,
  options: { status?: string; phase?: string | null; jobId?: string; idempotencyKey?: string } = {},
): void {
  const jobId = options.jobId ?? 'job-1';
  db.exec(
    `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
     VALUES ('project-1', 'Night Signal', 'active', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
  );
  db.exec(
    `INSERT INTO twi_generation_specs
       (id, project_id, spec_json, spec_sha256, rights_assertion_version, created_at)
     VALUES ('spec-1', 'project-1', '{}', 'spec-sha', 'v1', '2026-08-16T00:00:00.000Z')`,
  );
  db.exec(
    `INSERT INTO twi_jobs
       (id, project_id, spec_id, kind, status, phase, idempotency_key, estimate_json, created_at, updated_at)
     VALUES (?, 'project-1', 'spec-1', 'full-song', ?, ?, ?, '{}',
             '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
    jobId,
    options.status ?? 'queued',
    options.phase ?? options.status ?? 'queued',
    options.idempotencyKey ?? 'submission-1',
  );
}

function seedCandidateAssets(
  db: SqliteD1,
  mutate?: (entry: CandidatePublicationEntry) => CandidatePublicationEntry,
): void {
  const candidates = [candidateA, candidateB].map((entry) => mutate?.(entry) ?? entry);
  const kinds = [
    ['rawAssetId', 'generation-raw'],
    ['masterAssetId', 'generation-master'],
    ['previewAssetId', 'generation-preview'],
    ['provenanceAssetId', 'provenance'],
  ] as const;

  for (const candidate of candidates) {
    for (const [field, kind] of kinds) {
      const id = candidate[field];
      db.exec(
        `INSERT INTO twi_assets
           (id, project_id, job_id, kind, label, r2_key, content_type, bytes, sha256,
            lifecycle_state, created_at)
         VALUES (?, 'project-1', 'job-1', ?, ?, ?, 'application/octet-stream', 1, ?,
                 'provisional', '2026-08-16T01:00:00.000Z')`,
        id,
        kind,
        candidate.label,
        `twi/project-1/job-1/${id}`,
        `sha-${id}`,
      );
    }
  }
}

function commitPublicationWinner(db: SqliteD1, detail: Record<string, unknown> = { candidateCount: 2 }): void {
  db.exec(
    `UPDATE twi_assets
     SET lifecycle_state = 'active'
     WHERE project_id = 'project-1' AND job_id = 'job-1' AND lifecycle_state = 'provisional'`,
  );
  db.exec(
    `UPDATE twi_jobs
     SET status = 'complete', phase = 'complete', output_manifest_json = ?,
         retry_checkpoint = NULL, error_code = NULL, error_message = NULL,
         updated_at = '2026-08-16T05:00:00.000Z', finished_at = '2026-08-16T05:00:00.000Z'
     WHERE id = 'job-1'`,
    JSON.stringify(publicationManifest()),
  );
  db.exec(
    `INSERT INTO twi_job_events
       (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
     VALUES ('job-1', 'job-1:complete', 'validating', 'complete', 'complete', ?,
             '2026-08-16T05:00:00.000Z')`,
    publicationFingerprint(detail),
  );
}

describe('D1TwiRepository SQLite integration', () => {
  let db: SqliteD1;
  let repository: D1TwiRepository;

  beforeEach(() => {
    db = new SqliteD1();
    repository = new D1TwiRepository({ DB: db });
  });

  afterEach(() => db.close());

  it('commits a valid transition, reconciles replay, rejects collision, and leaves no ghost event on a race', async () => {
    seedProjectSpecJob(db);
    await expect(repository.transitionJob('job-1', 'generating', transitionOptions)).resolves.toMatchObject({
      outcome: 'applied',
      job: { status: 'generating' },
    });
    await expect(repository.transitionJob('job-1', 'generating', transitionOptions)).resolves.toMatchObject({
      outcome: 'replayed',
      job: { status: 'generating' },
    });
    await expect(
      repository.transitionJob('job-1', 'generating', { ...transitionOptions, detailJson: '{"attempt":2}' }),
    ).rejects.toThrow(/^transition idempotency collision$/);

    await repository.transitionJob('job-1', 'ingesting', {
      fromStatus: 'generating',
      phase: 'ingesting',
      retryCheckpoint: null,
      now: '2026-08-16T04:10:00.000Z',
      eventKey: 'job-1:ingesting:1',
      detailJson: '{}',
    });
    // A replay returns the job's *current* state, not the state that was asked
    // for. `outcome` is the only honest signal, which is why callers get it.
    await expect(repository.transitionJob('job-1', 'generating', transitionOptions)).resolves.toMatchObject({
      outcome: 'replayed',
      job: { status: 'ingesting' },
    });

    db.exec("UPDATE twi_jobs SET status = 'queued', phase = 'queued' WHERE id = 'job-1'");
    db.beforeNextBatch = () => {
      db.exec(
        `UPDATE twi_jobs
         SET status = 'generating', phase = 'generating', updated_at = '2026-08-16T04:20:00.000Z',
             finished_at = NULL, retry_checkpoint = NULL, error_code = NULL, error_message = NULL
         WHERE id = 'job-1'`,
      );
      db.exec(
        `INSERT INTO twi_job_events
           (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
         VALUES ('job-1', 'job-1:generating:race-exact', 'queued', 'generating', 'generating', ?,
                 '2026-08-16T04:20:00.000Z')`,
        transitionFingerprint({ detail: { attempt: 1 } }),
      );
    };
    await expect(
      repository.transitionJob('job-1', 'generating', {
        ...transitionOptions,
        eventKey: 'job-1:generating:race-exact',
      }),
    ).resolves.toMatchObject({ outcome: 'reconciled', job: { status: 'generating' } });

    db.exec("UPDATE twi_jobs SET status = 'queued', phase = 'queued' WHERE id = 'job-1'");
    db.beforeNextBatch = () => {
      db.exec("UPDATE twi_jobs SET status = 'cancelling', phase = 'cancelling' WHERE id = 'job-1'");
    };
    await expect(
      repository.transitionJob('job-1', 'generating', { ...transitionOptions, eventKey: 'job-1:generating:race' }),
    ).rejects.toThrow(/^job transition conflict$/);
    expect(db.value<number>("SELECT COUNT(*) FROM twi_job_events WHERE event_key = 'job-1:generating:race'")).toBe(0);
  });

  it('rejects a non-ISO timestamp before MAX(updated_at, ?) can latch the column forever', async () => {
    seedProjectSpecJob(db);

    // The hazard, measured rather than asserted: MAX() over TEXT is a BINARY
    // comparison, so any string starting with a letter outranks every ISO date.
    expect(db.value<string>("SELECT MAX('2026-08-16T05:00:00.000Z', 'now')")).toBe('now');
    expect(db.value<string>("SELECT MAX('now', '2027-01-01T00:00:00.000Z')")).toBe('now');

    await expect(
      repository.transitionJob('job-1', 'generating', { ...transitionOptions, now: 'now' }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(
      repository.appendCost({
        jobId: 'job-1',
        idempotencyKey: 'provider:request-1',
        category: 'provider',
        provider: 'google',
        model: 'lyria-3-pro-preview',
        amountUsd: 0.75,
        quantity: 1,
        detailJson: '{}',
        createdAt: 'now',
      }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);

    // Nothing was written, so nothing latched.
    expect(db.value<string>("SELECT updated_at FROM twi_jobs WHERE id = 'job-1'")).toBe(
      '2026-08-16T00:00:00.000Z',
    );
    expect(db.value<number>('SELECT COUNT(*) FROM twi_job_events')).toBe(0);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_cost_events')).toBe(0);

    // And a well-formed timestamp still advances the column normally.
    await repository.transitionJob('job-1', 'generating', transitionOptions);
    expect(db.value<string>("SELECT updated_at FROM twi_jobs WHERE id = 'job-1'")).toBe(
      '2026-08-16T04:00:00.000Z',
    );
  });

  it('preserves and returns a newer cost update committed after transition preflight', async () => {
    seedProjectSpecJob(db);
    db.beforeNextBatch = () => {
      db.exec(
        `INSERT INTO twi_cost_events
           (job_id, idempotency_key, category, provider, model, amount_usd, quantity, detail_json, created_at)
         VALUES ('job-1', 'provider:between-preflight-and-transition', 'provider', 'google',
                 'lyria-3-pro-preview', 2.25, 1, '{}', '2026-08-16T06:00:00.000Z')`,
      );
      db.exec(
        `UPDATE twi_jobs
         SET actual_cost_usd = 2.25, updated_at = '2026-08-16T06:00:00.000Z'
         WHERE id = 'job-1'`,
      );
    };

    const transitioned = await repository.transitionJob('job-1', 'generating', {
      ...transitionOptions,
      eventKey: 'job-1:generating:cost-race',
      detailJson: '{}',
    });

    expect(db.value<number>("SELECT actual_cost_usd FROM twi_jobs WHERE id = 'job-1'")).toBe(2.25);
    expect(db.value<string>("SELECT updated_at FROM twi_jobs WHERE id = 'job-1'")).toBe(
      '2026-08-16T06:00:00.000Z',
    );
    expect(transitioned.job).toMatchObject({
      status: 'generating',
      actualCostUsd: 2.25,
      updatedAt: '2026-08-16T06:00:00.000Z',
    });
  });

  it('reconciles a duplicate idempotency key instead of leaking the UNIQUE violation', async () => {
    seedProjectSpecJob(db);
    db.exec("DELETE FROM twi_jobs WHERE id = 'job-1'");

    const first = await repository.createEstimatedJob(estimatedJobInput());
    expect(first).toMatchObject({ outcome: 'created', job: { id: 'job-created', status: 'estimated' } });

    // Both halves of a double-clicked Submit read `null` from
    // findJobByIdempotencyKey and both call createEstimatedJob. The loser must
    // get the winner's job, not a raw SqliteError / D1 error.
    const second = await repository.createEstimatedJob(estimatedJobInput());
    expect(second).toMatchObject({ outcome: 'replayed', job: { id: 'job-created', status: 'estimated' } });

    expect(db.value<number>('SELECT COUNT(*) FROM twi_jobs')).toBe(1);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_job_events')).toBe(1);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_cost_events')).toBe(1);
  });

  it('rejects a reused idempotency key that carries a different submission', async () => {
    seedProjectSpecJob(db);
    db.exec("DELETE FROM twi_jobs WHERE id = 'job-1'");
    await repository.createEstimatedJob(estimatedJobInput());

    await expect(
      repository.createEstimatedJob(estimatedJobInput({ id: 'job-other', eventKey: 'job-other:estimated' })),
    ).rejects.toThrow(/^estimated job idempotency collision$/);
    await expect(
      repository.createEstimatedJob(estimatedJobInput({ estimateJson: '{"total":9}' })),
    ).rejects.toThrow(/^estimated job idempotency collision$/);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_jobs')).toBe(1);
  });

  it('surfaces a typed error when a cost row targets a job that does not exist', async () => {
    seedProjectSpecJob(db);
    await expect(
      repository.appendCost({
        jobId: 'job-missing',
        idempotencyKey: 'provider:request-1',
        category: 'provider',
        provider: 'google',
        model: 'lyria-3-pro-preview',
        amountUsd: 0.75,
        quantity: 1,
        detailJson: '{}',
        createdAt: '2026-08-16T05:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      name: 'TwiRepositoryConflictError',
      message: 'cost job not found',
      context: { jobId: 'job-missing', idempotencyKey: 'provider:request-1' },
    });
    expect(db.value<number>('SELECT COUNT(*) FROM twi_cost_events')).toBe(0);
  });

  it('publishes exactly eight valid candidate assets and reconciles exact completion replay', async () => {
    seedProjectSpecJob(db, { status: 'validating', phase: 'validating' });
    seedCandidateAssets(db);

    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({
      outcome: 'published',
    });
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'active'")).toBe(8);
    expect(db.value<string>("SELECT status FROM twi_jobs WHERE id = 'job-1'")).toBe('complete');
    const manifest = JSON.parse(db.value<string>("SELECT output_manifest_json FROM twi_jobs WHERE id = 'job-1'"));
    expect(manifest).toEqual({ schemaVersion: 1, candidates: [candidateA, candidateB] });
    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({
      outcome: 'replayed',
      job: { status: 'complete' },
    });
    await expect(
      repository.publishCandidates(
        publicationInput({ candidates: [candidateA, { ...candidateB, rawAssetId: 'other-b-raw' }] }),
      ),
    ).rejects.toThrow(/^candidate publication collision$/);
  });

  it('serves the modelled cancelling -> complete edge, manifest and all', async () => {
    seedProjectSpecJob(db, { status: 'cancelling', phase: 'cancelling' });
    seedCandidateAssets(db);

    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({
      outcome: 'published',
      job: { status: 'complete', phase: 'complete' },
    });
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'active'")).toBe(8);
    expect(
      db.value<string>("SELECT from_status FROM twi_job_events WHERE event_key = 'job-1:complete'"),
    ).toBe('cancelling');
    const manifest = JSON.parse(db.value<string>("SELECT output_manifest_json FROM twi_jobs WHERE id = 'job-1'"));
    expect(manifest).toEqual({ schemaVersion: 1, candidates: [candidateA, candidateB] });
  });

  it('refuses to publish from a status the state machine cannot complete from', async () => {
    seedProjectSpecJob(db, { status: 'queued', phase: 'queued' });
    seedCandidateAssets(db);

    await expect(repository.publishCandidates(publicationInput())).rejects.toThrow(
      /illegal TWI job transition: queued → complete/,
    );
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'active'")).toBe(0);
    expect(db.value<string>("SELECT status FROM twi_jobs WHERE id = 'job-1'")).toBe('queued');
  });

  it('reconciles an identical publication winner after a guarded loser and collides on a different fingerprint', async () => {
    seedProjectSpecJob(db, { status: 'validating', phase: 'validating' });
    seedCandidateAssets(db);
    db.beforeNextBatch = () => commitPublicationWinner(db);

    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({
      outcome: 'reconciled',
      job: { status: 'complete' },
    });
    expect(db.value<number>("SELECT COUNT(*) FROM twi_job_events WHERE event_key = 'job-1:complete'")).toBe(1);

    await expect(
      repository.publishCandidates(publicationInput({ eventDetailJson: '{"candidateCount":3}' })),
    ).rejects.toThrow(/^candidate publication collision$/);
  });

  it('reports a publication collision when a concurrent winner used the same key with a different fingerprint', async () => {
    seedProjectSpecJob(db, { status: 'validating', phase: 'validating' });
    seedCandidateAssets(db);
    db.beforeNextBatch = () => commitPublicationWinner(db, { winner: 'different-request' });

    await expect(repository.publishCandidates(publicationInput())).rejects.toThrow(
      /^candidate publication collision$/,
    );
  });

  it('does not activate or complete when B is missing or a selected asset has the wrong kind', async () => {
    seedProjectSpecJob(db, { status: 'validating', phase: 'validating' });
    seedCandidateAssets(db);
    db.exec("DELETE FROM twi_assets WHERE label = 'B'");
    await expect(repository.publishCandidates(publicationInput())).rejects.toThrow(/^candidate publication conflict$/);
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'active'")).toBe(0);
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'provisional'")).toBe(4);
    expect(db.value<string>("SELECT status FROM twi_jobs WHERE id = 'job-1'")).toBe('validating');

    db.exec('DELETE FROM twi_assets');
    seedCandidateAssets(db);
    db.exec("UPDATE twi_assets SET kind = 'generation-master' WHERE id = 'a-preview'");
    await expect(repository.publishCandidates(publicationInput())).rejects.toThrow(/^candidate publication conflict$/);
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'active'")).toBe(0);
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'provisional'")).toBe(8);
    expect(db.value<string>("SELECT status FROM twi_jobs WHERE id = 'job-1'")).toBe('validating');
  });

  it('names the unmatched label/kind pairs instead of blaming concurrency', async () => {
    seedProjectSpecJob(db, { status: 'validating', phase: 'validating' });
    seedCandidateAssets(db);
    // The realistic mistake: assets registered as 'Candidate A' rather than 'A'.
    db.exec("UPDATE twi_assets SET label = 'Candidate A' WHERE label = 'A'");

    await expect(repository.publishCandidates(publicationInput())).rejects.toMatchObject({
      name: 'TwiRepositoryConflictError',
      message: 'candidate publication conflict',
      context: {
        fromStatus: 'validating',
        unmatchedPairs: expect.arrayContaining([
          { id: 'a-raw', label: 'A', kind: 'generation-raw' },
          { id: 'a-master', label: 'A', kind: 'generation-master' },
          { id: 'a-preview', label: 'A', kind: 'generation-preview' },
          { id: 'a-provenance', label: 'A', kind: 'provenance' },
        ]),
      },
    });
  });

  it('reconciles asset insert replay and rejects an immutable mismatch', async () => {
    seedProjectSpecJob(db);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual({
      asset: assetInput,
      outcome: 'inserted',
    });
    await expect(repository.registerAsset(assetInput)).resolves.toEqual({
      asset: assetInput,
      outcome: 'replayed',
    });
    await expect(repository.registerAsset({ ...assetInput, sha256: 'different' })).rejects.toThrow(
      /^asset idempotency collision on id$/,
    );
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE id = 'asset-a'")).toBe(1);
  });

  it('reports its outcome alongside the asset for the insert, replay, and reconciled paths', async () => {
    seedProjectSpecJob(db);

    await expect(repository.registerAsset(assetInput)).resolves.toEqual({
      asset: assetInput,
      outcome: 'inserted',
    });
    await expect(repository.registerAsset(assetInput)).resolves.toEqual({
      asset: assetInput,
      outcome: 'replayed',
    });

    const racedInput = {
      ...assetInput,
      id: 'asset-race-outcome',
      r2Key: 'twi/project-1/jobs/job-1/race-outcome/master.wav',
    };
    db.beforeNextStandaloneRun = () => {
      db.exec(
        `INSERT INTO twi_assets
           (id, project_id, job_id, kind, label, r2_key, content_type, bytes, duration_seconds,
            sha256, provenance_key, lifecycle_state, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        racedInput.id,
        racedInput.projectId,
        racedInput.jobId,
        racedInput.kind,
        racedInput.label,
        racedInput.r2Key,
        racedInput.contentType,
        racedInput.bytes,
        racedInput.durationSeconds,
        racedInput.sha256,
        racedInput.provenanceKey,
        racedInput.lifecycleState,
        racedInput.createdAt,
        racedInput.deletedAt,
      );
    };
    await expect(repository.registerAsset(racedInput)).resolves.toEqual({
      asset: racedInput,
      outcome: 'reconciled',
    });
  });

  it('returns the authoritative stored spec hash after estimated-job creation', async () => {
    seedProjectSpecJob(db);
    db.exec("DELETE FROM twi_jobs WHERE id = 'job-1'");

    const created = await repository.createEstimatedJob(estimatedJobInput());
    expect(created.job).toMatchObject({ id: 'job-created', specSha256: 'spec-sha', status: 'estimated' });
  });

  it('reconciles a concurrent exact asset insert and rejects a raced r2-key mismatch', async () => {
    seedProjectSpecJob(db);
    db.beforeNextStandaloneRun = () => {
      db.exec(
        `INSERT INTO twi_assets
           (id, project_id, job_id, kind, label, r2_key, content_type, bytes, duration_seconds,
            sha256, provenance_key, lifecycle_state, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        assetInput.id,
        assetInput.projectId,
        assetInput.jobId,
        assetInput.kind,
        assetInput.label,
        assetInput.r2Key,
        assetInput.contentType,
        assetInput.bytes,
        assetInput.durationSeconds,
        assetInput.sha256,
        assetInput.provenanceKey,
        assetInput.lifecycleState,
        assetInput.createdAt,
        assetInput.deletedAt,
      );
    };
    await expect(repository.registerAsset(assetInput)).resolves.toEqual({
      asset: assetInput,
      outcome: 'reconciled',
    });

    const racedInput = {
      ...assetInput,
      id: 'asset-race',
      r2Key: 'twi/project-1/jobs/job-1/raced/master.wav',
    };
    db.beforeNextStandaloneRun = () => {
      db.exec(
        `INSERT INTO twi_assets
           (id, project_id, job_id, kind, label, r2_key, content_type, bytes, duration_seconds,
            sha256, provenance_key, lifecycle_state, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'different-asset',
        racedInput.projectId,
        racedInput.jobId,
        racedInput.kind,
        racedInput.label,
        racedInput.r2Key,
        racedInput.contentType,
        racedInput.bytes,
        racedInput.durationSeconds,
        racedInput.sha256,
        racedInput.provenanceKey,
        racedInput.lifecycleState,
        racedInput.createdAt,
        racedInput.deletedAt,
      );
    };
    await expect(repository.registerAsset(racedInput)).rejects.toThrow(
      /^asset idempotency collision after race$/,
    );
  });

  it('reconciles cost replay and race-style insert-zero without double charge or timestamp regression', async () => {
    seedProjectSpecJob(db);
    const input = {
      jobId: 'job-1',
      idempotencyKey: 'provider:request-1',
      category: 'provider' as const,
      provider: 'google',
      model: 'lyria-3-pro-preview',
      amountUsd: 0.75,
      quantity: 1,
      detailJson: '{"requestId":"request-1"}',
      createdAt: '2026-08-16T05:00:00.000Z',
    };
    await expect(repository.appendCost(input)).resolves.toEqual({ inserted: true });
    await expect(repository.appendCost({ ...input, createdAt: '2026-08-16T04:00:00.000Z' })).resolves.toEqual({
      inserted: false,
    });
    await expect(repository.appendCost({ ...input, amountUsd: 0.8 })).rejects.toThrow(/^cost idempotency collision$/);
    expect(db.value<number>("SELECT COUNT(*) FROM twi_cost_events WHERE job_id = 'job-1'")).toBe(1);
    expect(db.value<number>("SELECT actual_cost_usd FROM twi_jobs WHERE id = 'job-1'")).toBe(0.75);
    expect(db.value<string>("SELECT updated_at FROM twi_jobs WHERE id = 'job-1'")).toBe('2026-08-16T05:00:00.000Z');

    const raced = { ...input, idempotencyKey: 'provider:request-2', amountUsd: 0.25 };
    db.beforeNextBatch = () => {
      db.exec(
        `INSERT INTO twi_cost_events
           (job_id, idempotency_key, category, provider, model, amount_usd, quantity, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        raced.jobId,
        raced.idempotencyKey,
        raced.category,
        raced.provider,
        raced.model,
        raced.amountUsd,
        raced.quantity,
        raced.detailJson,
        raced.createdAt,
      );
      db.exec(
        `UPDATE twi_jobs SET actual_cost_usd = 1.0, updated_at = '2026-08-16T06:00:00.000Z' WHERE id = 'job-1'`,
      );
    };
    await expect(repository.appendCost(raced)).resolves.toEqual({ inserted: false });
    expect(db.value<number>("SELECT COUNT(*) FROM twi_cost_events WHERE job_id = 'job-1'")).toBe(2);
    expect(db.value<number>("SELECT actual_cost_usd FROM twi_jobs WHERE id = 'job-1'")).toBe(1);
    expect(db.value<string>("SELECT updated_at FROM twi_jobs WHERE id = 'job-1'")).toBe('2026-08-16T06:00:00.000Z');
  });
});

// ── The provider-call ledger (research P0) ─────────────────────────────────────
//
// One row per billable provider call, written BEFORE the call. Every assertion here is a
// SELECT against the real schema (migration 002 loaded by the harness), because the property
// under test is what the DATABASE says about the money after each write — not what a double
// was told. The race cases use the harness's injection so the guarded statements are shown
// losing a race, not merely running alone.
describe('D1TwiRepository provider-call ledger', () => {
  let db: SqliteD1;
  let repository: D1TwiRepository;

  const CLAIMED_AT = '2026-08-16T04:00:00.000Z';
  const SETTLED_AT = '2026-08-16T04:00:30.000Z';
  const RESOLVED_AT = '2026-08-16T09:00:00.000Z';
  const identity = (attempt = 0, label: 'A' | 'B' = 'A') => ({ jobId: 'job-1', attempt, label });
  const claim = (attempt = 0, label: 'A' | 'B' = 'A') =>
    repository.claimProviderCall({ ...identity(attempt, label), providerMode: 'fake', now: CLAIMED_AT });
  const row = (attempt = 0, label: 'A' | 'B' = 'A') =>
    db.database
      .prepare(
        `SELECT state, charge_certainty, provider_request_id, provider, model, settled_at, resolved_at, resolution_note, claimed_at
         FROM twi_provider_calls WHERE job_id = 'job-1' AND attempt = ? AND label = ?`,
      )
      .get(attempt, label) as Record<string, unknown> | undefined;

  beforeEach(() => {
    db = new SqliteD1();
    repository = new D1TwiRepository({ DB: db });
    seedProjectSpecJob(db);
  });

  afterEach(() => db.close());

  it('claims a submitting row with an unknown charge, and a second claim of the same identity is refused without touching it', async () => {
    expect(db.value<number>('SELECT COUNT(*) FROM twi_provider_calls')).toBe(0);

    const first = await claim();
    expect(first.outcome).toBe('claimed');
    expect(first.call).toMatchObject({
      jobId: 'job-1',
      attempt: 0,
      label: 'A',
      claimKey: 'job-1:0:provider-call:A',
      state: 'submitting',
      chargeCertainty: 'unknown',
      providerMode: 'fake',
      providerRequestId: null,
      claimedAt: CLAIMED_AT,
      settledAt: null,
      resolvedAt: null,
    });
    expect(row()).toMatchObject({ state: 'submitting', charge_certainty: 'unknown', claimed_at: CLAIMED_AT });

    // The row has since moved on; the replayed claim must return THAT row, unchanged.
    await repository.settleProviderCall({ ...identity(), state: 'ambiguous', now: SETTLED_AT });
    const replay = await repository.claimProviderCall({
      ...identity(),
      providerMode: 'lyria',
      now: '2026-08-16T05:00:00.000Z',
      detailJson: '{"replayed":true}',
    });
    expect(replay.outcome).toBe('already-claimed');
    expect(replay.call).toMatchObject({ state: 'ambiguous', providerMode: 'fake', claimedAt: CLAIMED_AT, detail: {} });
    expect(row()).toMatchObject({ state: 'ambiguous', claimed_at: CLAIMED_AT });
    expect(db.value<number>('SELECT COUNT(*) FROM twi_provider_calls')).toBe(1);
  });

  it('yields exactly one `claimed` when two claims of one identity race', async () => {
    // A concurrent writer lands its claim between this call's validation and its INSERT.
    db.beforeNextStandaloneRun = () => {
      db.exec(
        `INSERT INTO twi_provider_calls
           (job_id, attempt, label, claim_key, state, charge_certainty, provider_mode, detail_json, claimed_at)
         VALUES ('job-1', 0, 'A', 'job-1:0:provider-call:A', 'submitting', 'unknown', 'fake', '{"winner":true}', ?)`,
        '2026-08-16T03:59:59.000Z',
      );
    };
    const loser = await claim();
    expect(loser.outcome).toBe('already-claimed');
    expect(loser.call).toMatchObject({ detail: { winner: true }, claimedAt: '2026-08-16T03:59:59.000Z' });
    expect(db.value<number>('SELECT COUNT(*) FROM twi_provider_calls')).toBe(1);
  });

  it('refuses a claim against a job that does not exist, by name rather than as a driver error', async () => {
    await expect(
      repository.claimProviderCall({ jobId: 'no-such-job', attempt: 0, label: 'A', providerMode: 'fake', now: CLAIMED_AT }),
    ).rejects.toMatchObject({ name: 'TwiRepositoryConflictError', message: 'provider call job not found' });
    expect(db.value<number>('SELECT COUNT(*) FROM twi_provider_calls')).toBe(0);
  });

  it('settles into each state with the certainty derived from the state, and completed records the request id', async () => {
    const expected = [
      ['completed', 'charged'],
      ['accepted', 'charged'],
      ['ambiguous', 'unknown'],
      ['abandoned', 'not_charged'],
    ] as const;
    for (const [index, [state, certainty]] of expected.entries()) {
      await claim(index);
      const settled = await repository.settleProviderCall({
        ...identity(index),
        state,
        providerRequestId: state === 'completed' ? `req-${index}` : undefined,
        provider: 'fake',
        model: 'deterministic-sine-v1',
        now: SETTLED_AT,
      });
      expect(settled.outcome).toBe('settled');
      expect(settled.call).toMatchObject({ state, chargeCertainty: certainty, settledAt: SETTLED_AT, provider: 'fake' });
      expect(row(index)).toMatchObject({
        state,
        charge_certainty: certainty,
        settled_at: SETTLED_AT,
        provider_request_id: state === 'completed' ? `req-${index}` : null,
      });
    }
  });

  it('refuses to settle completed without a request id — at the boundary, and by the schema when the boundary is bypassed', async () => {
    await claim();
    await expect(
      repository.settleProviderCall({ ...identity(), state: 'completed', now: SETTLED_AT }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    await expect(
      repository.settleProviderCall({ ...identity(), state: 'completed', providerRequestId: '   ', now: SETTLED_AT }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    expect(row()).toMatchObject({ state: 'submitting' });
    // The second line of defence: raw SQL, no TypeScript in the way.
    expect(() =>
      db.exec(
        `UPDATE twi_provider_calls SET state = 'completed', charge_certainty = 'charged', settled_at = ?
         WHERE job_id = 'job-1' AND attempt = 0 AND label = 'A'`,
        SETTLED_AT,
      ),
    ).toThrow(/CHECK constraint failed: twi_provider_calls_completed_has_request_id/);
    expect(row()).toMatchObject({ state: 'submitting' });
  });

  it('settles a row once: every later settlement is already-settled and leaves the row exactly as it was', async () => {
    const states = ['completed', 'accepted', 'ambiguous', 'abandoned'] as const;
    for (const [index, state] of states.entries()) {
      await claim(index);
      await repository.settleProviderCall({
        ...identity(index),
        state,
        providerRequestId: state === 'completed' ? `req-${index}` : undefined,
        now: SETTLED_AT,
      });
      const before = row(index);
      for (const again of states) {
        const replay = await repository.settleProviderCall({
          ...identity(index),
          state: again,
          providerRequestId: 'req-later',
          provider: 'someone-else',
          now: '2026-08-16T06:00:00.000Z',
        });
        expect(replay.outcome).toBe('already-settled');
        expect(replay.call).toMatchObject({ state, settledAt: SETTLED_AT });
      }
      expect(row(index)).toEqual(before);
    }
  });

  it('answers not-claimed, and writes nothing, when the identity was never claimed', async () => {
    const result = await repository.settleProviderCall({ ...identity(3, 'B'), state: 'ambiguous', now: SETTLED_AT });
    expect(result).toEqual({ outcome: 'not-claimed', call: null });
    expect(db.value<number>('SELECT COUNT(*) FROM twi_provider_calls')).toBe(0);
  });

  it('resolves an unknown charge only when told what it became, and fills settled_at for a row that never settled', async () => {
    await claim(0);
    await claim(1);
    await repository.settleProviderCall({ ...identity(1), state: 'ambiguous', now: SETTLED_AT });

    for (const attempt of [0, 1]) {
      await expect(
        repository.resolveProviderCall({ ...identity(attempt), note: 'looked at the invoice', now: RESOLVED_AT }),
      ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
      expect(row(attempt)).toMatchObject({ resolved_at: null });
    }

    const stillSubmitting = await repository.resolveProviderCall({
      ...identity(0),
      to: 'accepted',
      note: 'provider invoice shows the render',
      now: RESOLVED_AT,
    });
    expect(stillSubmitting.outcome).toBe('resolved');
    expect(stillSubmitting.call).toMatchObject({
      state: 'accepted',
      chargeCertainty: 'charged',
      settledAt: RESOLVED_AT,
      resolvedAt: RESOLVED_AT,
      resolutionNote: 'provider invoice shows the render',
    });
    expect(row(0)).toMatchObject({ state: 'accepted', charge_certainty: 'charged', settled_at: RESOLVED_AT });

    const wasAmbiguous = await repository.resolveProviderCall({
      ...identity(1),
      to: 'abandoned',
      note: 'no charge on the account for this request',
      now: RESOLVED_AT,
    });
    expect(wasAmbiguous.outcome).toBe('resolved');
    expect(wasAmbiguous.call).toMatchObject({ state: 'abandoned', chargeCertainty: 'not_charged', settledAt: SETTLED_AT });
    expect(row(1)).toMatchObject({ state: 'abandoned', charge_certainty: 'not_charged', settled_at: SETTLED_AT });
  });

  it('acknowledges a known charge without rewriting it, refuses a blank note, and resolves only once', async () => {
    await claim();
    await repository.settleProviderCall({ ...identity(), state: 'completed', providerRequestId: 'req-1', now: SETTLED_AT });

    // A known charge cannot be relabelled through the reconciliation seam.
    await expect(
      repository.resolveProviderCall({ ...identity(), to: 'abandoned', note: 'wishful thinking', now: RESOLVED_AT }),
    ).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    for (const note of ['', '   ']) {
      await expect(repository.resolveProviderCall({ ...identity(), note, now: RESOLVED_AT })).rejects.toBeInstanceOf(
        TwiRepositoryValidationError,
      );
    }
    expect(row()).toMatchObject({ state: 'completed', resolved_at: null, resolution_note: null });

    const first = await repository.resolveProviderCall({ ...identity(), note: 'charge matched to invoice line 4', now: RESOLVED_AT });
    expect(first.outcome).toBe('resolved');
    expect(first.call).toMatchObject({ state: 'completed', chargeCertainty: 'charged', resolvedAt: RESOLVED_AT });

    const again = await repository.resolveProviderCall({
      ...identity(),
      note: 'a different note',
      now: '2026-08-17T09:00:00.000Z',
    });
    expect(again.outcome).toBe('already-resolved');
    expect(again.call).toMatchObject({ resolvedAt: RESOLVED_AT, resolutionNote: 'charge matched to invoice line 4' });
    expect(row()).toMatchObject({ resolved_at: RESOLVED_AT, resolution_note: 'charge matched to invoice line 4' });

    expect(
      await repository.resolveProviderCall({ ...identity(5, 'B'), to: 'abandoned', note: 'nothing here', now: RESOLVED_AT }),
    ).toEqual({ outcome: 'not-found', call: null });
  });

  it('lists a job’s calls in (attempt, label) order, and only that job’s', async () => {
    db.exec(
      `INSERT INTO twi_jobs
         (id, project_id, spec_id, kind, status, phase, idempotency_key, estimate_json, created_at, updated_at)
       VALUES ('job-2', 'project-1', 'spec-1', 'full-song', 'queued', 'queued', 'submission-2', '{}',
               '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
    );
    await claim(1, 'B');
    await claim(0, 'B');
    await claim(1, 'A');
    await claim(0, 'A');
    await repository.claimProviderCall({ jobId: 'job-2', attempt: 0, label: 'A', providerMode: 'fake', now: CLAIMED_AT });

    const calls = await repository.listProviderCalls('job-1');
    expect(calls.map(({ attempt, label }) => `${attempt}${label}`)).toEqual(['0A', '0B', '1A', '1B']);
    expect(await repository.listProviderCalls('job-2')).toHaveLength(1);
    expect(await repository.listProviderCalls('job-nobody')).toEqual([]);
  });

  it('counts the unreconciled calls estate-wide, and agrees with the TypeScript predicate the retry gate uses', async () => {
    db.exec(
      `INSERT INTO twi_jobs
         (id, project_id, spec_id, kind, status, phase, idempotency_key, estimate_json, created_at, updated_at)
       VALUES ('job-2', 'project-1', 'spec-1', 'full-song', 'queued', 'queued', 'submission-2', '{}',
               '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
    );
    // job-1: attempt 0 A submitting (counts), B completed (counts), attempt 1 A ambiguous (counts),
    // B abandoned (does not), attempt 2 A accepted then resolved (does not).
    await claim(0, 'A');
    await claim(0, 'B');
    await repository.settleProviderCall({ ...identity(0, 'B'), state: 'completed', providerRequestId: 'r', now: SETTLED_AT });
    await claim(1, 'A');
    await repository.settleProviderCall({ ...identity(1, 'A'), state: 'ambiguous', now: SETTLED_AT });
    await claim(1, 'B');
    await repository.settleProviderCall({ ...identity(1, 'B'), state: 'abandoned', now: SETTLED_AT });
    await claim(2, 'A');
    await repository.settleProviderCall({ ...identity(2, 'A'), state: 'accepted', now: SETTLED_AT });
    await repository.resolveProviderCall({ ...identity(2, 'A'), note: 'acknowledged', now: RESOLVED_AT });
    // job-2: one ambiguous call (counts).
    await repository.claimProviderCall({ jobId: 'job-2', attempt: 0, label: 'A', providerMode: 'fake', now: CLAIMED_AT });
    await repository.settleProviderCall({ jobId: 'job-2', attempt: 0, label: 'A', state: 'ambiguous', now: SETTLED_AT });

    expect(await repository.countUnreconciledProviderCalls()).toBe(4);
    const viaPredicate = [...(await repository.listProviderCalls('job-1')), ...(await repository.listProviderCalls('job-2'))]
      .filter(isUnreconciledProviderCall).length;
    expect(viaPredicate).toBe(4);

    // Resolving the two unknown charges on job-1 removes exactly those two.
    await repository.resolveProviderCall({ ...identity(0, 'A'), to: 'abandoned', note: 'never sent', now: RESOLVED_AT });
    await repository.resolveProviderCall({ ...identity(1, 'A'), to: 'accepted', note: 'billed', now: RESOLVED_AT });
    expect(await repository.countUnreconciledProviderCalls()).toBe(2);
  });

  it('reports every ledger write through the event sink with its outcome', async () => {
    const events: string[] = [];
    const observed = new D1TwiRepository({ DB: db }, { onEvent: (event) => events.push(`${event.op}:${event.outcome}`) });
    await observed.claimProviderCall({ ...identity(), providerMode: 'fake', now: CLAIMED_AT });
    await observed.claimProviderCall({ ...identity(), providerMode: 'fake', now: CLAIMED_AT });
    await observed.settleProviderCall({ ...identity(), state: 'ambiguous', now: SETTLED_AT });
    await observed.settleProviderCall({ ...identity(), state: 'ambiguous', now: SETTLED_AT });
    await observed.resolveProviderCall({ ...identity(), to: 'abandoned', note: 'n', now: RESOLVED_AT });
    await observed.listProviderCalls('job-1');
    await observed.countUnreconciledProviderCalls();
    expect(events).toEqual([
      'claimProviderCall:claimed',
      'claimProviderCall:already-claimed',
      'settleProviderCall:settled',
      'settleProviderCall:already-settled',
      'resolveProviderCall:resolved',
    ]);
  });
});

// The harness is not the subject under test, but a broken harness would make the
// suite above meaningless. Kept in its own block so it cannot be mistaken for
// D1TwiRepository coverage.
describe('SqliteD1 harness', () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = new SqliteD1();
  });

  afterEach(() => db.close());

  it('rolls back the whole adapter batch when a later statement fails', async () => {
    const first = db
      .prepare(
        `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      )
      .bind('project-rollback', 'Rollback', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');
    const duplicate = db
      .prepare(
        `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      )
      .bind('project-rollback', 'Duplicate', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');

    await expect(db.batch([first, duplicate])).rejects.toThrow();
    expect(db.value<number>("SELECT COUNT(*) FROM twi_projects WHERE id = 'project-rollback'")).toBe(0);
  });
});
