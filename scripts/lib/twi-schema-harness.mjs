/**
 * twi-schema-harness.mjs -- the shared node:sqlite fixture the schema behaviour suites run on.
 *
 * WHY IT EXISTS. `scripts/twi-schema-behavior.test.mjs` carried both the fixture and every test.
 * When the provider-call section (migration 002) took that file to 1577 lines against this
 * project's 800-line ceiling, the section moved to `scripts/twi-schema-provider-calls.test.mjs`
 * -- and the fixture had to move with it, because `node --test` runs each file in its own process
 * and one test file importing another would register the other's tests a second time. Copying the
 * fixture instead would give the two suites two databases free to drift apart, which is the one
 * thing a schema fixture must never do.
 *
 * Nothing here is a test. Both suites are run by ONE `node --test` invocation
 * (`npm run test:twi:schema`), so their test counts add into one floor.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrationSql = readFileSync(
  new URL('../../twi-migration-001-creation-core.sql', import.meta.url),
  'utf8',
);

/**
 * Migration 002 — `twi_provider_calls`, the persisted state of ONE billable provider call.
 *
 * Read as its own string rather than concatenated blindly, because the hygiene test in
 * `twi-schema-behavior.test.mjs` asserts the per-file properties (every statement re-runnable, no comment-only chunk, no
 * over-long LIKE pattern, LF-only, ends on its semicolon) over each migration separately —
 * a concatenation would let a file that violates one of them hide inside the other.
 */
const providerCallsMigrationSql = readFileSync(
  new URL('../../twi-migration-002-provider-call-state.sql', import.meta.url),
  'utf8',
);

/** Every TWI migration, in the lexical order the runner applies them. */
const ALL_MIGRATIONS = [
  ['twi-migration-001-creation-core.sql', migrationSql],
  ['twi-migration-002-provider-call-state.sql', providerCallsMigrationSql],
];

/**
 * Fixed-width ISO-8601 UTC timestamps, the only shape the schema accepts.
 * `datetime('now')` deliberately does NOT appear in these suites: the repository
 * layer advances `updated_at` with `MAX(updated_at, ?)`, a BINARY comparison
 * over TEXT, so a single space-separated timestamp would latch the column.
 */
const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T01:00:00.000Z';
const T2 = '2026-08-16T02:00:00.000Z';

/**
 * Every negative assertion in these suites names the exact engine message it
 * expects. A bare `assert.throws` passes on a typo'd column name, an unrelated
 * NOT NULL, or the wrong constraint firing — which is precisely how a widened
 * uniqueness key stays green while the money path double-bills.
 */
function exactly(message) {
  return (error) => {
    assert.equal(error.message, message);
    return true;
  };
}

const checkFailed = (constraintName) => exactly(`CHECK constraint failed: ${constraintName}`);
const uniqueFailed = (...qualifiedColumns) =>
  exactly(`UNIQUE constraint failed: ${qualifiedColumns.join(', ')}`);
const notNullFailed = (qualifiedColumn) => exactly(`NOT NULL constraint failed: ${qualifiedColumn}`);
const foreignKeyFailed = exactly('FOREIGN KEY constraint failed');

function freshDb(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  // Pin it. node:sqlite already defaults foreign_keys on, so the PRAGMA above is
  // a no-op here — but on an engine where it is not (better-sqlite3 defaults
  // off, D1 has defer_foreign_keys) every FK test below would silently become a
  // tautology instead of failing.
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys must be enforced');
  for (const [, sql] of ALL_MIGRATIONS) db.exec(sql);
  return db;
}

function insertProject(db, id, name = `Project ${id}`) {
  return db.prepare(`
    INSERT INTO twi_projects (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, T0, T0);
}

function insertSpec(db, projectId, id, specJson = '{"prompt":"A nocturnal electronic track"}') {
  return db.prepare(`
    INSERT INTO twi_generation_specs (
      id,
      project_id,
      spec_json,
      spec_sha256,
      rights_assertion_version,
      created_at
    ) VALUES (?, ?, ?, 'spec-sha256', '2026-08-16', ?)
  `).run(id, projectId, specJson, T0);
}

function seedProjectAndSpec(db, projectId = 'p1', specId = 's1') {
  insertProject(db, projectId);
  insertSpec(db, projectId, specId);
}

function insertJob(db, id, idempotencyKey, {
  projectId = 'p1',
  specId = 's1',
  kind = 'full-song',
  status = 'queued',
  phase = null,
  actualCostUsd = 0,
  estimateJson = null,
  outputManifestJson = null,
  createdAt = T0,
  updatedAt = T0,
} = {}) {
  return db.prepare(`
    INSERT INTO twi_jobs (
      id,
      project_id,
      spec_id,
      kind,
      status,
      phase,
      idempotency_key,
      actual_cost_usd,
      estimate_json,
      output_manifest_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    specId,
    kind,
    status,
    phase,
    idempotencyKey,
    actualCostUsd,
    estimateJson,
    outputManifestJson,
    createdAt,
    updatedAt,
  );
}

export {
  ALL_MIGRATIONS,
  T0,
  T1,
  T2,
  checkFailed,
  exactly,
  foreignKeyFailed,
  freshDb,
  insertJob,
  insertProject,
  insertSpec,
  notNullFailed,
  seedProjectAndSpec,
  uniqueFailed,
};
