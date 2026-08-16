// @vitest-environment node
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue, StatementSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  D1TwiRepository,
  TwiRepositoryCorruptionError,
  TwiRepositoryValidationError,
  type CandidatePublicationEntry,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type PublishCandidatesInput,
} from './repository';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

interface RecordedStatement {
  sql: string;
  bindings: unknown[];
}

const changed = (changes: number): D1ResultLike<Record<string, unknown>> => ({
  success: true,
  results: [],
  meta: { changes },
});

class ScriptedStatement implements D1PreparedStatementLike {
  constructor(
    private readonly db: ScriptedD1,
    readonly record: RecordedStatement,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.record.bindings = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.firstResults.shift() ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return (this.db.allResults.shift() ?? changed(0)) as D1ResultLike<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return (this.db.runResults.shift() ?? changed(1)) as D1ResultLike<T>;
  }
}

class ScriptedD1 implements D1DatabaseLike {
  readonly statements: RecordedStatement[] = [];
  readonly batches: RecordedStatement[][] = [];
  readonly firstResults: Array<Record<string, unknown> | null> = [];
  readonly allResults: D1ResultLike<Record<string, unknown>>[] = [];
  readonly runResults: D1ResultLike<Record<string, unknown>>[] = [];
  readonly batchResults: D1ResultLike<Record<string, unknown>>[][] = [];

  prepare(sql: string): D1PreparedStatementLike {
    const record = { sql, bindings: [] };
    this.statements.push(record);
    return new ScriptedStatement(this, record);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    this.batches.push(statements.map((statement) => (statement as ScriptedStatement).record));
    return (this.batchResults.shift() ?? []) as D1ResultLike<T>[];
  }
}

class SqliteD1Statement implements D1PreparedStatementLike {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.bindings = values as SQLInputValue[];
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.statement().get(...this.bindings) as T | undefined;
    return row ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const results = this.statement().all(...this.bindings) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    this.owner.runBeforeStandaloneStatement();
    return this.runSync<T>();
  }

  runSync<T = Record<string, unknown>>(): D1ResultLike<T> {
    const result = this.statement().run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.sql);
  }
}

class SqliteD1 implements D1DatabaseLike {
  readonly database: DatabaseSyncType = new DatabaseSync(':memory:');
  beforeNextBatch: (() => void) | null = null;
  beforeNextStandaloneRun: (() => void) | null = null;

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(readFileSync(new URL('../../../twi-migration-001-creation-core.sql', import.meta.url), 'utf8'));
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteD1Statement(this, sql);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.();

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => (statement as SqliteD1Statement).runSync<T>());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string, ...values: SQLInputValue[]): void {
    this.database.prepare(sql).run(...values);
  }

  runBeforeStandaloneStatement(): void {
    const beforeRun = this.beforeNextStandaloneRun;
    this.beforeNextStandaloneRun = null;
    beforeRun?.();
  }

  value<T>(sql: string, ...values: SQLInputValue[]): T {
    const row = this.database.prepare(sql).get(...values) as Record<string, T> | undefined;
    if (!row) throw new Error(`test query returned no row: ${sql}`);
    return Object.values(row)[0] as T;
  }

  close(): void {
    this.database.close();
  }
}

const normalized = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

const transitionFingerprint = (overrides: Record<string, unknown> = {}): string =>
  stableJson({
    schemaVersion: 1,
    eventType: 'job-transition',
    fromStatus: 'queued',
    toStatus: 'generating',
    phase: 'generating',
    retryCheckpoint: null,
    errorCode: null,
    errorMessage: null,
    detail: { attempt: 1, z: 1 },
    ...overrides,
  });

const projectRow = {
  id: 'project-1',
  name: 'Night Signal',
  current_revision_id: 'revision-2',
  lifecycle_state: 'active',
  deleted_at: null,
  created_at: '2026-08-16T00:00:00.000Z',
  updated_at: '2026-08-16T01:00:00.000Z',
};

const jobRow = {
  id: 'job-1',
  project_id: 'project-1',
  spec_id: 'spec-1',
  spec_sha256: 'spec-sha',
  kind: 'full-song',
  status: 'queued',
  phase: 'queued',
  workflow_id: 'workflow-1',
  provider: 'google',
  model: 'lyria-3-pro-preview',
  idempotency_key: 'submission-1',
  estimate_json: '{"total":1.25}',
  actual_cost_usd: 0.75,
  output_manifest_json: null,
  retry_checkpoint: null,
  error_code: null,
  error_message: null,
  created_at: '2026-08-16T00:00:00.000Z',
  updated_at: '2026-08-16T01:00:00.000Z',
  finished_at: null,
};

const assetInput = {
  id: 'asset-a',
  projectId: 'project-1',
  jobId: 'job-1',
  kind: 'generation-master' as const,
  label: 'A',
  r2Key: 'twi/project-1/jobs/job-1/a/master.wav',
  contentType: 'audio/wav',
  bytes: 4096,
  durationSeconds: 122.5,
  sha256: 'abc123',
  provenanceKey: 'twi/project-1/jobs/job-1/a/provenance.json',
  lifecycleState: 'provisional' as const,
  createdAt: '2026-08-16T01:00:00.000Z',
  deletedAt: null,
};

const assetRow = {
  id: assetInput.id,
  project_id: assetInput.projectId,
  job_id: assetInput.jobId,
  kind: assetInput.kind,
  label: assetInput.label,
  r2_key: assetInput.r2Key,
  content_type: assetInput.contentType,
  bytes: assetInput.bytes,
  duration_seconds: assetInput.durationSeconds,
  sha256: assetInput.sha256,
  provenance_key: assetInput.provenanceKey,
  lifecycle_state: assetInput.lifecycleState,
  created_at: assetInput.createdAt,
  deleted_at: assetInput.deletedAt,
};

const candidateA: CandidatePublicationEntry = {
  label: 'A',
  rawAssetId: 'a-raw',
  masterAssetId: 'a-master',
  previewAssetId: 'a-preview',
  provenanceAssetId: 'a-provenance',
};

const candidateB: CandidatePublicationEntry = {
  label: 'B',
  rawAssetId: 'b-raw',
  masterAssetId: 'b-master',
  previewAssetId: 'b-preview',
  provenanceAssetId: 'b-provenance',
};

const publicationManifest = () => ({ schemaVersion: 1, candidates: [candidateA, candidateB] });

const publicationFingerprint = (detail: Record<string, unknown> = { candidateCount: 2 }): string =>
  stableJson({
    schemaVersion: 1,
    eventType: 'candidate-publication',
    manifest: publicationManifest(),
    detail,
  });

const publicationInput = (overrides: Partial<PublishCandidatesInput> = {}): PublishCandidatesInput => ({
  projectId: 'project-1',
  jobId: 'job-1',
  candidates: [candidateA, candidateB],
  eventKey: 'job-1:complete',
  eventDetailJson: '{"candidateCount":2}',
  now: '2026-08-16T05:00:00.000Z',
  ...overrides,
});

const completeJobRow = () => ({
  ...jobRow,
  status: 'complete',
  phase: 'complete',
  output_manifest_json: JSON.stringify(publicationManifest()),
  finished_at: '2026-08-16T05:00:00.000Z',
});

describe('D1TwiRepository fast behavior', () => {
  let db: ScriptedD1;
  let repository: D1TwiRepository;

  beforeEach(() => {
    db = new ScriptedD1();
    repository = new D1TwiRepository({ DB: db });
  });

  it('maps project rows and keeps active newest-first query semantics', async () => {
    db.allResults.push({ success: true, results: [projectRow], meta: { changes: 0 } });
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
  });

  it('creates, gets, and saves validated records with canonical object JSON', async () => {
    db.runResults.push(changed(1), changed(1));
    await expect(
      repository.createProject({ id: 'project-2', name: 'Glass Current', now: '2026-08-16T02:00:00.000Z' }),
    ).resolves.toMatchObject({ id: 'project-2', lifecycleState: 'active' });

    db.firstResults.push(projectRow);
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
  });

  it('scopes idempotency lookup to project and spec hash and maps the hash', async () => {
    db.firstResults.push(jobRow);
    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-1',
        idempotencyKey: 'submission-1',
        specSha256: 'spec-sha',
      }),
    ).resolves.toMatchObject({ projectId: 'project-1', specSha256: 'spec-sha' });
    expect(normalized(db.statements[0]!.sql)).toContain('JOIN twi_generation_specs');

    db.firstResults.push(jobRow);
    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-2',
        idempotencyKey: 'submission-1',
        specSha256: 'spec-sha',
      }),
    ).rejects.toThrow(/^job idempotency collision$/);

    db.firstResults.push(jobRow);
    await expect(
      repository.findJobByIdempotencyKey({
        projectId: 'project-1',
        idempotencyKey: 'submission-1',
        specSha256: 'different-sha',
      }),
    ).rejects.toThrow(/^job idempotency collision$/);
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
      provider: 'google',
      model: 'lyria-3-pro-preview',
      created_at: '2026-08-16T03:00:00.000Z',
      updated_at: '2026-08-16T03:00:00.000Z',
    });
    const job = await repository.createEstimatedJob({
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

    expect(job).toMatchObject({ status: 'estimated', specSha256: 'spec-sha', estimate: { total: 2.5 } });
    expect(db.statements.at(-1)!.sql).toContain('JOIN twi_generation_specs');
    expect(db.batches[0]).toHaveLength(3);
    expect(db.batches[0]![1]!.bindings).toContain('job-2:estimated');
    expect(db.batches[0]![1]!.bindings).toContain('{"a":2,"z":1}');
    expect(db.batches[0]![2]!.bindings).toContain('job-2:estimate');
  });

  it('preserves the exact first transition update and chains metadata/event guards', async () => {
    db.firstResults.push(
      jobRow,
      null,
      { ...jobRow, status: 'generating', phase: 'generating', updated_at: '2026-08-16T04:00:00.000Z' },
    );
    db.batchResults.push([changed(1), changed(1), changed(1)]);

    const transitioned = await repository.transitionJob('job-1', 'generating', {
      fromStatus: 'queued',
      phase: 'generating',
      retryCheckpoint: null,
      now: '2026-08-16T04:00:00.000Z',
      eventKey: 'job-1:generating:1',
      detailJson: '{"z":1,"attempt":1}',
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
    expect(transitioned).toMatchObject({ status: 'generating', finishedAt: null, retryCheckpoint: null });
  });

  it('reconciles a lost transition response and rejects a stable-key collision', async () => {
    const current = { ...jobRow, status: 'ingesting', phase: 'ingesting' };
    const event = {
      event_key: 'job-1:generating:1',
      from_status: 'queued',
      to_status: 'generating',
      phase: 'generating',
      detail_json: transitionFingerprint(),
      created_at: '2026-08-16T04:00:00.000Z',
    };
    db.firstResults.push(current, event, current);

    await expect(
      repository.transitionJob('job-1', 'generating', {
        fromStatus: 'queued',
        phase: 'generating',
        retryCheckpoint: null,
        now: '2026-08-16T04:30:00.000Z',
        eventKey: 'job-1:generating:1',
        detailJson: '{"z":1,"attempt":1}',
      }),
    ).resolves.toMatchObject({ status: 'ingesting' });
    expect(db.batches).toHaveLength(0);

    db.firstResults.push(current, event);
    await expect(
      repository.transitionJob('job-1', 'generating', {
        fromStatus: 'queued',
        phase: 'generating',
        retryCheckpoint: null,
        now: '2026-08-16T04:30:00.000Z',
        eventKey: 'job-1:generating:1',
        detailJson: '{"attempt":2}',
      }),
    ).rejects.toThrow(/^transition idempotency collision$/);

    db.firstResults.push(current, event);
    await expect(
      repository.transitionJob('job-1', 'generating', {
        fromStatus: 'estimated',
        phase: 'generating',
        retryCheckpoint: null,
        now: '2026-08-16T04:30:00.000Z',
        eventKey: 'job-1:generating:1',
        detailJson: '{"attempt":1,"z":1}',
      }),
    ).rejects.toThrow(/^transition idempotency collision$/);
  });

  it('re-reads latest state when an exact event appears after the initial job read', async () => {
    const event = {
      event_key: 'job-1:generating:1',
      from_status: 'queued',
      to_status: 'generating',
      phase: 'generating',
      detail_json: transitionFingerprint(),
      created_at: '2026-08-16T04:00:00.000Z',
    };
    const latest = { ...jobRow, status: 'generating', phase: 'generating' };
    db.firstResults.push(jobRow, event, latest);

    await expect(
      repository.transitionJob('job-1', 'generating', {
        fromStatus: 'queued',
        phase: 'generating',
        retryCheckpoint: null,
        now: '2026-08-16T04:30:00.000Z',
        eventKey: 'job-1:generating:1',
        detailJson: '{"attempt":1,"z":1}',
      }),
    ).resolves.toMatchObject({ status: 'generating' });
    expect(db.batches).toHaveLength(0);
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
        createdAt: 'now',
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
        createdAt: 'now',
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
      status: 'error',
      retryCheckpoint: 'generating',
      finishedAt: '2026-08-16T04:00:00.000Z',
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
    ).resolves.toMatchObject({ status: 'retrying', retryCheckpoint: 'generating', finishedAt: null });

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
    ).resolves.toMatchObject({ retryCheckpoint: null, finishedAt: null });
  });

  it('reconciles asset replay and rejects immutable payload or r2-key collisions', async () => {
    db.firstResults.push(assetRow);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual(assetInput);
    expect(db.runResults).toHaveLength(0);

    db.firstResults.push(assetRow);
    await expect(repository.registerAsset({ ...assetInput, bytes: 4097 })).rejects.toThrow(
      /^asset idempotency collision$/,
    );

    db.firstResults.push(null, assetRow);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual(assetInput);

    db.firstResults.push(null, { ...assetRow, id: 'different-asset' });
    await expect(repository.registerAsset(assetInput)).rejects.toThrow(/^asset idempotency collision$/);
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

    db.firstResults.push(null);
    db.batchResults.push([changed(0), changed(0)]);
    db.firstResults.push(costRow);
    await expect(repository.appendCost(input)).resolves.toEqual({ inserted: false });
    const aggregate = db.batches[0]![1]!;
    expect(normalized(aggregate.sql)).toContain("category <> 'estimate'");
    expect(normalized(aggregate.sql)).toContain('updated_at = MAX(updated_at, ?)');
    expect(normalized(aggregate.sql)).toContain('changes() = 1');
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
        createdAt: 'now',
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
        createdAt: 'now',
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

  it('derives the manifest and guards all eight required label/kind pairs', async () => {
    db.firstResults.push({ ...jobRow, status: 'validating', phase: 'validating' }, completeJobRow());
    db.batchResults.push([changed(8), changed(1), changed(1)]);

    await repository.publishCandidates(publicationInput());

    const assets = db.batches[0]![0]!;
    const job = db.batches[0]![1]!;
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
    expect(normalized(assets.sql)).toContain("status = 'validating'");
    expect(normalized(job.sql)).toContain('changes() = 8');
    expect(normalized(job.sql)).toContain('updated_at = MAX(updated_at, ?)');
    const manifest = JSON.parse(job.bindings[0] as string) as Record<string, unknown>;
    expect(manifest).toEqual({ schemaVersion: 1, candidates: [candidateA, candidateB] });
    expect(db.batches[0]![2]!.bindings).toContain(publicationFingerprint());
  });

  it('reconciles exact publication replay and rejects a completed-job collision', async () => {
    const complete = completeJobRow();
    const event = {
      event_key: 'job-1:complete',
      from_status: 'validating',
      to_status: 'complete',
      phase: 'complete',
      detail_json: publicationFingerprint(),
      created_at: '2026-08-16T05:00:00.000Z',
    };
    db.firstResults.push(complete, event);
    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({ status: 'complete' });
    expect(db.batches).toHaveLength(0);

    db.firstResults.push(complete, event);
    await expect(
      repository.publishCandidates(
        publicationInput({ candidates: [candidateA, { ...candidateB, previewAssetId: 'different-preview' }] }),
      ),
    ).rejects.toThrow(/^candidate publication collision$/);
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
    await expect(Promise.reject(new TwiRepositoryCorruptionError('context'))).rejects.toBeInstanceOf(
      TwiRepositoryCorruptionError,
    );
  });
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

function seedCandidateAssets(db: SqliteD1, mutate?: (entry: CandidatePublicationEntry) => CandidatePublicationEntry): void {
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
    const options = {
      fromStatus: 'queued' as const,
      phase: 'generating' as const,
      retryCheckpoint: null,
      now: '2026-08-16T04:00:00.000Z',
      eventKey: 'job-1:generating:1',
      detailJson: '{"attempt":1}',
    };
    await repository.transitionJob('job-1', 'generating', options);
    await expect(repository.transitionJob('job-1', 'generating', options)).resolves.toMatchObject({ status: 'generating' });
    await expect(
      repository.transitionJob('job-1', 'generating', { ...options, detailJson: '{"attempt":2}' }),
    ).rejects.toThrow(/^transition idempotency collision$/);

    await repository.transitionJob('job-1', 'ingesting', {
      fromStatus: 'generating',
      phase: 'ingesting',
      retryCheckpoint: null,
      now: '2026-08-16T04:10:00.000Z',
      eventKey: 'job-1:ingesting:1',
      detailJson: '{}',
    });
    await expect(repository.transitionJob('job-1', 'generating', options)).resolves.toMatchObject({ status: 'ingesting' });

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
        ...options,
        eventKey: 'job-1:generating:race-exact',
      }),
    ).resolves.toMatchObject({ status: 'generating' });

    db.exec("UPDATE twi_jobs SET status = 'queued', phase = 'queued' WHERE id = 'job-1'");
    db.beforeNextBatch = () => {
      db.exec("UPDATE twi_jobs SET status = 'cancelling', phase = 'cancelling' WHERE id = 'job-1'");
    };
    await expect(
      repository.transitionJob('job-1', 'generating', { ...options, eventKey: 'job-1:generating:race' }),
    ).rejects.toThrow(/^job transition conflict$/);
    expect(db.value<number>("SELECT COUNT(*) FROM twi_job_events WHERE event_key = 'job-1:generating:race'")).toBe(0);
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
      fromStatus: 'queued',
      phase: 'generating',
      retryCheckpoint: null,
      now: '2026-08-16T04:00:00.000Z',
      eventKey: 'job-1:generating:cost-race',
      detailJson: '{}',
    });

    expect(db.value<number>("SELECT actual_cost_usd FROM twi_jobs WHERE id = 'job-1'")).toBe(2.25);
    expect(db.value<string>("SELECT updated_at FROM twi_jobs WHERE id = 'job-1'")).toBe(
      '2026-08-16T06:00:00.000Z',
    );
    expect(transitioned).toMatchObject({
      status: 'generating',
      actualCostUsd: 2.25,
      updatedAt: '2026-08-16T06:00:00.000Z',
    });
  });

  it('publishes exactly eight valid candidate assets and reconciles exact completion replay', async () => {
    seedProjectSpecJob(db, { status: 'validating', phase: 'validating' });
    seedCandidateAssets(db);

    await repository.publishCandidates(publicationInput());
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE lifecycle_state = 'active'")).toBe(8);
    expect(db.value<string>("SELECT status FROM twi_jobs WHERE id = 'job-1'")).toBe('complete');
    const manifest = JSON.parse(db.value<string>("SELECT output_manifest_json FROM twi_jobs WHERE id = 'job-1'"));
    expect(manifest).toEqual({ schemaVersion: 1, candidates: [candidateA, candidateB] });
    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({ status: 'complete' });
    await expect(
      repository.publishCandidates(
        publicationInput({ candidates: [candidateA, { ...candidateB, rawAssetId: 'other-b-raw' }] }),
      ),
    ).rejects.toThrow(/^candidate publication collision$/);
  });

  it('reconciles an identical publication winner after a guarded loser and collides on a different fingerprint', async () => {
    seedProjectSpecJob(db, { status: 'validating', phase: 'validating' });
    seedCandidateAssets(db);
    db.beforeNextBatch = () => commitPublicationWinner(db);

    await expect(repository.publishCandidates(publicationInput())).resolves.toMatchObject({ status: 'complete' });
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

  it('reconciles asset insert replay and rejects an immutable mismatch', async () => {
    seedProjectSpecJob(db);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual(assetInput);
    await expect(repository.registerAsset(assetInput)).resolves.toEqual(assetInput);
    await expect(repository.registerAsset({ ...assetInput, sha256: 'different' })).rejects.toThrow(
      /^asset idempotency collision$/,
    );
    expect(db.value<number>("SELECT COUNT(*) FROM twi_assets WHERE id = 'asset-a'")).toBe(1);
  });

  it('returns the authoritative stored spec hash after estimated-job creation', async () => {
    seedProjectSpecJob(db);
    db.exec("DELETE FROM twi_jobs WHERE id = 'job-1'");

    const job = await repository.createEstimatedJob({
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
    });

    expect(job).toMatchObject({ id: 'job-created', specSha256: 'spec-sha', status: 'estimated' });
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
    await expect(repository.registerAsset(racedInput)).rejects.toThrow(/^asset idempotency collision$/);
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

  it('rolls back the whole adapter batch when a later statement fails', async () => {
    const first = db.prepare(
      `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    ).bind('project-rollback', 'Rollback', 'now', 'now');
    const duplicate = db.prepare(
      `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    ).bind('project-rollback', 'Duplicate', 'now', 'now');

    await expect(db.batch([first, duplicate])).rejects.toThrow();
    expect(db.value<number>("SELECT COUNT(*) FROM twi_projects WHERE id = 'project-rollback'")).toBe(0);
  });
});
