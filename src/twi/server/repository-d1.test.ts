// @vitest-environment node
/// <reference types="node" />
//
// The one property the other two suites cannot prove.
//
// Three of the five write paths are correct only if, inside `D1Database.batch()`,
// statement N observes statement N-1's `changes()`. Cloudflare documents that a
// batch runs sequentially inside an implicit transaction; it does *not* document
// `changes()` visibility across batch entries. The node:sqlite harness models a
// batch as sequential `.run()` calls on one connection, which makes the chaining
// true by construction — it assumes exactly the thing under test.
//
// This suite runs the real statements against a workerd-backed D1 binding via
// miniflare (already on disk as a wrangler dependency), so the assumption
// becomes a checked fact.

import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { D1TwiRepository, type D1DatabaseLike } from './repository';
import { readMigrationSql } from './repository.harness';

const BOOT_TIMEOUT_MS = 60_000;

const transitionOptions = {
  fromStatus: 'queued' as const,
  phase: 'generating' as const,
  retryCheckpoint: null,
  now: '2026-08-16T04:00:00.000Z',
  eventKey: 'job-1:generating:1',
  detailJson: '{"attempt":1}',
};

let miniflare: Miniflare;
// Assignment (not a cast) is the compile-time half of the proof: a real
// D1Database satisfies the structural shim the repository is written against.
let binding: D1DatabaseLike;
let repository: D1TwiRepository;

const run = (sql: string, ...values: unknown[]): Promise<unknown> =>
  binding.prepare(sql).bind(...values).run();

const count = async (sql: string): Promise<number> => {
  const row = await binding.prepare(sql).first<{ value: number }>();
  return row?.value ?? -1;
};

const text = async (sql: string): Promise<string | null> => {
  const row = await binding.prepare(sql).first<{ value: string }>();
  return row?.value ?? null;
};

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response("twi-test") };',
    compatibilityDate: '2026-08-16',
    d1Databases: { DB: 'twi-creation-core' },
  });
  binding = await miniflare.getD1Database('DB');
  repository = new D1TwiRepository({ DB: binding });

  for (const statement of readMigrationSql().split(';')) {
    const sql = statement.trim();
    if (sql.length > 0) await binding.prepare(sql).run();
  }
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await miniflare?.dispose();
});

beforeEach(async () => {
  for (const table of ['twi_cost_events', 'twi_job_events', 'twi_assets', 'twi_jobs', 'twi_generation_specs', 'twi_projects']) {
    await binding.prepare(`DELETE FROM ${table}`).run();
  }
  await run(
    `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
     VALUES ('project-1', 'Night Signal', 'active', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
  );
  await run(
    `INSERT INTO twi_generation_specs
       (id, project_id, spec_json, spec_sha256, rights_assertion_version, created_at)
     VALUES ('spec-1', 'project-1', '{}', 'spec-sha', 'v1', '2026-08-16T00:00:00.000Z')`,
  );
  await run(
    `INSERT INTO twi_jobs
       (id, project_id, spec_id, kind, status, phase, idempotency_key, estimate_json, created_at, updated_at)
     VALUES ('job-1', 'project-1', 'spec-1', 'full-song', 'queued', 'queued', 'submission-1', '{}',
             '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
  );
});

describe('D1 batch() semantics the repository depends on', () => {
  it('propagates changes() from one batch statement to the next', async () => {
    const winning = await binding.batch([
      binding
        .prepare(`UPDATE twi_jobs SET status = 'generating' WHERE id = ? AND status = ?`)
        .bind('job-1', 'queued'),
      binding.prepare(`UPDATE twi_jobs SET phase = 'generating' WHERE id = ? AND changes() = 1`).bind('job-1'),
      binding
        .prepare(
          `INSERT INTO twi_job_events (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
           SELECT ?, ?, 'queued', 'generating', 'generating', '{}', '2026-08-16T04:00:00.000Z'
           WHERE changes() = 1`,
        )
        .bind('job-1', 'chain-win'),
    ]);
    expect(winning.map((result) => result.meta.changes)).toEqual([1, 1, 1]);
    expect(await count(`SELECT COUNT(*) AS value FROM twi_job_events WHERE event_key = 'chain-win'`)).toBe(1);
  });

  it('does not fire dependent statements when the guarding statement matched no row', async () => {
    const losing = await binding.batch([
      // 'queued' is no longer the status a concurrent writer left behind.
      binding
        .prepare(`UPDATE twi_jobs SET status = 'ingesting' WHERE id = ? AND status = ?`)
        .bind('job-1', 'finishing'),
      binding.prepare(`UPDATE twi_jobs SET phase = 'ingesting' WHERE id = ? AND changes() = 1`).bind('job-1'),
      binding
        .prepare(
          `INSERT INTO twi_job_events (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
           SELECT ?, ?, 'queued', 'ingesting', 'ingesting', '{}', '2026-08-16T04:00:00.000Z'
           WHERE changes() = 1`,
        )
        .bind('job-1', 'chain-lose'),
    ]);
    expect(losing.map((result) => result.meta.changes)).toEqual([0, 0, 0]);
    expect(await count(`SELECT COUNT(*) AS value FROM twi_job_events WHERE event_key = 'chain-lose'`)).toBe(0);
    expect(await text(`SELECT phase AS value FROM twi_jobs WHERE id = 'job-1'`)).toBe('queued');
  });
});

describe('D1TwiRepository against a workerd D1 binding', () => {
  it('applies a guarded transition and writes exactly one audit event', async () => {
    const applied = await repository.transitionJob('job-1', 'generating', transitionOptions);

    expect(applied.outcome).toBe('applied');
    expect(applied.job).toMatchObject({ status: 'generating', phase: 'generating', finishedAt: null });
    expect(await text(`SELECT updated_at AS value FROM twi_jobs WHERE id = 'job-1'`)).toBe(
      '2026-08-16T04:00:00.000Z',
    );
    expect(await count(`SELECT COUNT(*) AS value FROM twi_job_events WHERE event_key = 'job-1:generating:1'`)).toBe(1);
  });

  it('fails the whole transition, ghost event included, when the guard loses', async () => {
    await run(`UPDATE twi_jobs SET status = 'cancelling', phase = 'cancelling' WHERE id = 'job-1'`);

    await expect(
      repository.transitionJob('job-1', 'generating', { ...transitionOptions, fromStatus: 'queued' }),
    ).rejects.toMatchObject({ name: 'TwiRepositoryConflictError' });
    expect(await count(`SELECT COUNT(*) AS value FROM twi_job_events`)).toBe(0);
    expect(await text(`SELECT status AS value FROM twi_jobs WHERE id = 'job-1'`)).toBe('cancelling');
  });

  it('keeps updated_at monotonic through MAX() when a newer cost row lands first', async () => {
    await run(
      `INSERT INTO twi_cost_events
         (job_id, idempotency_key, category, provider, model, amount_usd, quantity, detail_json, created_at)
       VALUES ('job-1', 'provider:late', 'provider', 'google', 'lyria-3-pro-preview', 2.25, 1, '{}',
               '2026-08-16T06:00:00.000Z')`,
    );
    await run(
      `UPDATE twi_jobs SET actual_cost_usd = 2.25, updated_at = '2026-08-16T06:00:00.000Z' WHERE id = 'job-1'`,
    );

    const applied = await repository.transitionJob('job-1', 'generating', transitionOptions);

    expect(applied.outcome).toBe('applied');
    expect(await text(`SELECT updated_at AS value FROM twi_jobs WHERE id = 'job-1'`)).toBe(
      '2026-08-16T06:00:00.000Z',
    );
  });
});
