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
    await expect(repository.registerAsset(assetInput)).resolves.toEqual(assetInput);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual(assetInput);
    await expect(repository.registerAsset({ ...assetInput, sha256: 'different' })).rejects.toThrow(
      /^asset idempotency collision on id$/,
    );
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE id = 'asset-a'")).toBe(1);
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
    await expect(repository.registerAsset(assetInput)).resolves.toEqual(assetInput);

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
