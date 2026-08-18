/// <reference types="node" />
//
// Test doubles and a real-database world for the creation-job use cases.
//
// Kept out of the `**/*.test.ts` glob (the same reason `repository.fixtures.ts` and
// `repository.harness.ts` are) so `jobs.test.ts` and `jobs-lifecycle.test.ts` build
// from one starting point instead of two that can drift.
//
// TWO instruments, and the split is deliberate — it is the difference between proving
// behaviour and proving that a call was made:
//
//   * {@link jobsWorld} — a real `node:sqlite` database loading the actual migration,
//     with a real `D1TwiRepository` over it. Every money-path assertion (how many
//     jobs, how many cost rows, which event keys) is a SELECT against that database
//     rather than a spy on a double. A double cannot tell you that a second
//     submission was never charged; `SELECT COUNT(*) FROM twi_cost_events` can.
//   * {@link RecordingOrchestrator} — the service binding, recorded. It is the only
//     way to count DISPATCHES, which is the fact the brief's `starts: 1` names, and
//     the only way to make one fail on demand. It fails two ways, because a binding
//     that ANSWERS 503 and a binding that THROWS are different code paths.
//
// The clock is fixed and the ids are sequential, so an event key can be asserted by
// value. That matters more here than anywhere else in this feature: the retry loop's
// correctness IS the attempt ordinal inside `twi_job_events.event_key`, and a random
// UUID would make the assertion unwritable.

import type { AssetKind } from '../domain/types';

import type { OrchestratorRequestInit, TwiOrchestratorBinding } from './orchestrator-types';
import type { ProjectIdentityClock } from './projects';
import { D1TwiRepository } from './repository';
import type { AssetLifecycleState, AssetRecord, JobRecord, TwiRepository } from './repository-types';
import { SqliteD1 } from './repository.harness';

export const OWNER_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
/** A well-formed uuid no project row carries, for the 404 paths. */
export const UNKNOWN_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
/** A well-formed uuid no job row carries. */
export const UNKNOWN_JOB_ID = '88888888-8888-4888-8888-888888888888';

/** One fixed instant, in the only shape the schema accepts. */
export const FIXED_NOW = '2026-08-18T09:00:00.000Z';

export interface RecordedDispatch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The Workflow service binding, recorded.
 *
 * `status` and `failWith` make both failure modes producible without a network. They
 * are separate on purpose: `jobs.ts` reaches the same job state from a non-2xx answer
 * and from a rejected promise, and a suite that only drove one of them would leave
 * the other free to answer 201 for a job nobody started.
 */
export class RecordingOrchestrator implements TwiOrchestratorBinding {
  readonly calls: RecordedDispatch[] = [];
  status = 202;
  failWith: Error | null = null;

  async fetch(url: string, init: OrchestratorRequestInit): Promise<Response> {
    this.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (this.failWith) throw this.failWith;
    return new Response(JSON.stringify({ accepted: this.status < 400 }), { status: this.status });
  }

  get starts(): number {
    return this.calls.filter((call) => call.url.endsWith('/start')).length;
  }

  get cancels(): number {
    return this.calls.filter((call) => call.url.includes('/cancel/')).length;
  }

  /** Fails loudly rather than returning `undefined` under `noUncheckedIndexedAccess`. */
  call(index = 0): RecordedDispatch {
    const recorded = this.calls[index];
    if (!recorded) throw new Error(`no dispatch was recorded at index ${index} (${this.calls.length} total)`);
    return recorded;
  }

  payload(index = 0): Record<string, unknown> {
    return JSON.parse(this.call(index).body) as Record<string, unknown>;
  }
}

/**
 * Sequential ids and a frozen clock.
 *
 * `newId()` returns real UUIDs rather than `spec-1`/`job-1`: `twi_jobs.id` carries no
 * format CHECK, but the object-key guard in `assets.ts` and the wizard both treat
 * these as UUIDs, and a test that passes only because the id was short proves less.
 */
export class SequentialClock implements ProjectIdentityClock {
  private issued = 0;

  constructor(private readonly instant: string = FIXED_NOW) {}

  newId(): string {
    this.issued += 1;
    return `44444444-4444-4444-8444-${this.issued.toString(16).padStart(12, '0')}`;
  }

  now(): string {
    return this.instant;
  }
}

/**
 * A repository with some methods replaced.
 *
 * Written as explicit delegation rather than `{ ...repo, override }` because
 * `D1TwiRepository`'s methods live on its PROTOTYPE: the spread form compiles, runs,
 * and produces an object whose every method is `undefined`. That is the shape of
 * silent-pass a test double must not have.
 */
export function repoWith(base: TwiRepository, overrides: Partial<TwiRepository>): TwiRepository {
  return {
    listProjects: () => base.listProjects(),
    createProject: (input) => base.createProject(input),
    getProject: (projectId) => base.getProject(projectId),
    saveSpec: (input) => base.saveSpec(input),
    findJobByIdempotencyKey: (input) => base.findJobByIdempotencyKey(input),
    findAssetById: (assetId) => base.findAssetById(assetId),
    findJobById: (jobId) => base.findJobById(jobId),
    listJobs: (input) => base.listJobs(input),
    countProjectAssets: (input) => base.countProjectAssets(input),
    countJobEvents: (input) => base.countJobEvents(input),
    createEstimatedJob: (input) => base.createEstimatedJob(input),
    transitionJob: (jobId, to, options) => base.transitionJob(jobId, to, options),
    appendCost: (input) => base.appendCost(input),
    registerAsset: (input) => base.registerAsset(input),
    publishCandidates: (input) => base.publishCandidates(input),
    ...overrides,
  };
}

export interface AssetSeed {
  id: string;
  projectId?: string;
  kind?: AssetKind;
  lifecycleState?: AssetLifecycleState;
}

export interface JobsWorld {
  db: SqliteD1;
  repo: TwiRepository;
  orchestrator: RecordingOrchestrator;
  clock: SequentialClock;
  asset(seed: AssetSeed): Promise<AssetRecord>;
  jobCount(): number;
  specCount(): number;
  costCount(): number;
  costCategories(): string[];
  eventKeys(): string[];
  job(jobId: string): Promise<JobRecord | null>;
  close(): void;
}

const column = (db: SqliteD1, sql: string): string[] =>
  db.database
    .prepare(sql)
    .all()
    .map((row) => String(Object.values(row as Record<string, unknown>)[0]));

export async function jobsWorld(): Promise<JobsWorld> {
  const db = new SqliteD1();
  const repo = new D1TwiRepository({ DB: db });
  const clock = new SequentialClock();
  const orchestrator = new RecordingOrchestrator();

  for (const [id, name] of [
    [OWNER_PROJECT_ID, 'Nocturne'],
    [OTHER_PROJECT_ID, 'Someone else'],
  ] as const) {
    await repo.createProject({ id, name, now: FIXED_NOW });
  }

  let assets = 0;
  return {
    db,
    repo,
    orchestrator,
    clock,
    async asset({ id, projectId = OWNER_PROJECT_ID, kind = 'image-reference', lifecycleState = 'active' }) {
      assets += 1;
      const { asset } = await repo.registerAsset({
        id,
        projectId,
        jobId: null,
        kind,
        label: null,
        r2Key: `twi/${projectId}/assets/${id}/source.bin`,
        contentType: kind === 'image-reference' ? 'image/jpeg' : 'audio/wav',
        bytes: 4,
        durationSeconds: null,
        sha256: assets.toString(16).padStart(64, '0'),
        provenanceKey: null,
        lifecycleState,
        createdAt: FIXED_NOW,
        deletedAt: lifecycleState === 'deleted' ? FIXED_NOW : null,
      });
      return asset;
    },
    jobCount: () => db.value<number>('SELECT COUNT(*) FROM twi_jobs'),
    specCount: () => db.value<number>('SELECT COUNT(*) FROM twi_generation_specs'),
    costCount: () => db.value<number>('SELECT COUNT(*) FROM twi_cost_events'),
    costCategories: () => column(db, 'SELECT category FROM twi_cost_events ORDER BY id'),
    eventKeys: () => column(db, 'SELECT event_key FROM twi_job_events ORDER BY id'),
    job: (jobId) => repo.findJobById(jobId),
    close: () => db.close(),
  };
}

/** A JSON POST, the shape every mutation in this API arrives as. */
export const jsonRequest = (url: string, body: unknown): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://sp1e.se' },
    body: JSON.stringify(body),
  });

export const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

/** A uuid that is valid to the schema and obviously not a stored asset until seeded. */
export const missingAssetId = (suffix: string): string =>
  `55555555-5555-4555-8555-5555555555${suffix.padStart(2, '5')}`;
