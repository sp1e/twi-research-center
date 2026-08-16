import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrationSql = readFileSync(
  new URL('../twi-migration-001-creation-core.sql', import.meta.url),
  'utf8',
);

/**
 * Fixed-width ISO-8601 UTC timestamps, the only shape the schema accepts.
 * `datetime('now')` deliberately does NOT appear in this file: the repository
 * layer advances `updated_at` with `MAX(updated_at, ?)`, a BINARY comparison
 * over TEXT, so a single space-separated timestamp would latch the column.
 */
const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T01:00:00.000Z';
const T2 = '2026-08-16T02:00:00.000Z';

/** Mirrors `JobStatus` in src/twi/domain/types.ts:1. */
const JOB_STATUSES = [
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

/** Mirrors `JobPhase` in src/twi/domain/types.ts:2 — `Exclude<JobStatus,'draft'|'estimated'>`. */
const JOB_PHASES = JOB_STATUSES.filter((status) => status !== 'draft' && status !== 'estimated');

const ASSET_KINDS = [
  'image-reference',
  'generation-raw',
  'generation-master',
  'generation-preview',
  'provenance',
];
const ASSET_LIFECYCLES = ['provisional', 'active', 'hidden', 'deleted'];
const COST_CATEGORIES = ['estimate', 'provider', 'finishing', 'storage'];
const JOB_KINDS = ['full-song', 'finish'];

const EXPECTED_INDEXES = [
  'idx_twi_projects_updated',
  'idx_twi_revisions_project',
  'idx_twi_revisions_parent',
  'idx_twi_jobs_project',
  'idx_twi_jobs_status',
  'idx_twi_job_events_job',
  'idx_twi_assets_project',
  'idx_twi_assets_job',
  'idx_twi_cost_events_job',
];

/**
 * Every negative assertion in this file names the exact engine message it
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
  db.exec(migrationSql);
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

function insertRevision(db, { id, projectId = 'p1', parentRevisionId = null } = {}) {
  return db.prepare(`
    INSERT INTO twi_project_revisions (
      id,
      project_id,
      parent_revision_id,
      snapshot_key,
      snapshot_sha256,
      summary,
      created_at
    ) VALUES (?, ?, ?, ?, 'revision-sha256', 'Test revision', ?)
  `).run(id, projectId, parentRevisionId, `twi/${projectId}/revisions/${id}.json`, T0);
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

function insertJobEvent(db, {
  jobId = 'j1',
  eventKey,
  fromStatus = null,
  toStatus = 'queued',
  phase = null,
  detailJson = '{}',
} = {}) {
  return db.prepare(`
    INSERT INTO twi_job_events (
      job_id,
      event_key,
      from_status,
      to_status,
      phase,
      detail_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, eventKey, fromStatus, toStatus, phase, detailJson, T0);
}

function insertAsset(db, {
  id,
  projectId = 'p1',
  jobId = null,
  kind = 'image-reference',
  r2Key,
  contentType = 'audio/wav',
  bytes = 0,
  durationSeconds = null,
  sha256 = 'asset-sha256',
  lifecycleState = 'active',
  createdAt = T0,
  deletedAt = null,
} = {}) {
  return db.prepare(`
    INSERT INTO twi_assets (
      id,
      project_id,
      job_id,
      kind,
      r2_key,
      content_type,
      bytes,
      duration_seconds,
      sha256,
      lifecycle_state,
      created_at,
      deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    jobId,
    kind,
    r2Key ?? `twi/${projectId}/assets/${id}`,
    contentType,
    bytes,
    durationSeconds,
    sha256,
    lifecycleState,
    createdAt,
    deletedAt,
  );
}

function insertCostEvent(db, {
  jobId = 'j1',
  idempotencyKey,
  category = 'provider',
  amountUsd = 0,
  quantity = null,
  detailJson = '{}',
} = {}) {
  return db.prepare(`
    INSERT INTO twi_cost_events (
      job_id,
      idempotency_key,
      category,
      amount_usd,
      quantity,
      detail_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, idempotencyKey, category, amountUsd, quantity, detailJson, T0);
}

// ---------------------------------------------------------------------------
// State machine enums
// ---------------------------------------------------------------------------

test('job status accepts every modelled state and rejects everything else', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  JOB_STATUSES.forEach((status, index) => {
    insertJob(db, `j-${index}`, `key-${index}`, { status });
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_jobs`).get().n, JOB_STATUSES.length);

  assert.throws(
    () => insertJob(db, 'j-unknown', 'key-unknown', { status: 'unknown' }),
    checkFailed('twi_jobs_status_enum'),
  );
});

test('job kind accepts only the two modelled kinds', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  JOB_KINDS.forEach((kind, index) => {
    insertJob(db, `j-kind-${index}`, `kind-key-${index}`, { kind });
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_jobs`).get().n, JOB_KINDS.length);

  assert.throws(
    () => insertJob(db, 'j-bad-kind', 'kind-key-bad', { kind: 'remix' }),
    checkFailed('twi_jobs_kind_enum'),
  );
});

test('job phase accepts exactly the JobPhase set and rejects draft, estimated, and garbage', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  insertJob(db, 'j-null-phase', 'phase-key-null', { phase: null });
  JOB_PHASES.forEach((phase, index) => {
    insertJob(db, `j-phase-${index}`, `phase-key-${index}`, { status: phase, phase });
  });
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM twi_jobs WHERE phase IS NOT NULL`).get().n,
    JOB_PHASES.length,
  );

  // 'draft' and 'estimated' are valid *statuses* but are excluded from JobPhase,
  // so a widened enum that merely reuses the status list must fail here.
  for (const rejected of ['draft', 'estimated', 'not-a-phase', '']) {
    assert.throws(
      () => insertJob(db, `j-bad-${rejected}`, `phase-bad-${rejected}`, { phase: rejected }),
      checkFailed('twi_jobs_phase_enum'),
      `phase ${JSON.stringify(rejected)} must be rejected`,
    );
  }
});

test('job event states use the same state machine as jobs', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  assert.throws(
    () => insertJobEvent(db, { eventKey: 'bad-from', fromStatus: 'unknown', toStatus: 'queued' }),
    checkFailed('twi_job_events_from_status_enum'),
  );
  assert.throws(
    () => insertJobEvent(db, { eventKey: 'bad-to', toStatus: 'unknown' }),
    checkFailed('twi_job_events_to_status_enum'),
  );
  insertJobEvent(db, { eventKey: 'valid-null-from' });
});

test('job event phase accepts exactly the JobPhase set', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  insertJobEvent(db, { eventKey: 'phase-null', phase: null });
  JOB_PHASES.forEach((phase, index) => {
    insertJobEvent(db, { eventKey: `phase-${index}`, toStatus: phase, phase });
  });
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM twi_job_events WHERE phase IS NOT NULL`).get().n,
    JOB_PHASES.length,
  );

  for (const rejected of ['draft', 'estimated', 'not-a-phase', '']) {
    assert.throws(
      () => insertJobEvent(db, { eventKey: `phase-bad-${rejected}`, phase: rejected }),
      checkFailed('twi_job_events_phase_enum'),
      `event phase ${JSON.stringify(rejected)} must be rejected`,
    );
  }
});

test('asset kind and lifecycle accept only modelled values', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  ASSET_KINDS.forEach((kind, index) => {
    insertAsset(db, { id: `a-kind-${index}`, kind });
  });
  assert.throws(
    () => insertAsset(db, { id: 'a-bad-kind', kind: 'stem' }),
    checkFailed('twi_assets_kind_enum'),
  );

  for (const lifecycleState of ASSET_LIFECYCLES) {
    insertAsset(db, {
      id: `a-life-${lifecycleState}`,
      lifecycleState,
      deletedAt: lifecycleState === 'deleted' ? T1 : null,
    });
  }
  assert.throws(
    () => insertAsset(db, { id: 'a-bad-life', lifecycleState: 'archived' }),
    checkFailed('twi_assets_lifecycle_enum'),
  );
});

test('cost event category accepts only modelled categories', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  COST_CATEGORIES.forEach((category, index) => {
    insertCostEvent(db, { idempotencyKey: `cat-${index}`, category });
  });
  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: 'cat-bad', category: 'refund' }),
    checkFailed('twi_cost_events_category_enum'),
  );
});

test('project lifecycle accepts only modelled states', (t) => {
  const db = freshDb(t);
  assert.throws(
    () => db.prepare(`
      INSERT INTO twi_projects (id,name,lifecycle_state,created_at,updated_at)
      VALUES ('p-bad','Invalid','archived',?,?)
    `).run(T0, T0),
    checkFailed('twi_projects_lifecycle_enum'),
  );
});

// ---------------------------------------------------------------------------
// Uniqueness keys — the replay boundary
// ---------------------------------------------------------------------------

test('idempotency keys are unique', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'same-key');
  assert.throws(
    () => insertJob(db, 'j2', 'same-key'),
    uniqueFailed('twi_jobs.idempotency_key'),
  );
});

test('job event replay collides on (job_id, event_key) alone, whatever the payload', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');
  insertJob(db, 'j2', 'job-key-2');

  insertJobEvent(db, { eventKey: 'queued:1', toStatus: 'queued', phase: 'queued', detailJson: '{}' });

  // Same key, DIFFERENT payload in every other column. A replay test that
  // re-inserts an identical row still collides under a widened key such as
  // UNIQUE (job_id, event_key, to_status) — this one does not.
  assert.throws(
    () => insertJobEvent(db, {
      eventKey: 'queued:1',
      fromStatus: 'queued',
      toStatus: 'generating',
      phase: 'generating',
      detailJson: '{"attempt":2}',
    }),
    uniqueFailed('twi_job_events.job_id', 'twi_job_events.event_key'),
  );

  // The key is scoped to the job, not global.
  insertJobEvent(db, { jobId: 'j2', eventKey: 'queued:1' });
  insertJobEvent(db, { eventKey: 'generating:1', fromStatus: 'queued', toStatus: 'generating' });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_job_events`).get().n, 3);
});

test('cost event replay collides on (job_id, idempotency_key) alone, whatever the charge', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');
  insertJob(db, 'j2', 'job-key-2');

  insertCostEvent(db, { idempotencyKey: 'provider:1', category: 'provider', amountUsd: 1.25 });

  // The same logical charge re-recorded under a different category and amount.
  // If the key were widened to include either column this would insert a second
  // row and double-bill; the suite must fail loudly when that happens.
  assert.throws(
    () => insertCostEvent(db, {
      idempotencyKey: 'provider:1',
      category: 'finishing',
      amountUsd: 99.5,
      quantity: 3,
      detailJson: '{"attempt":2}',
    }),
    uniqueFailed('twi_cost_events.job_id', 'twi_cost_events.idempotency_key'),
  );

  insertCostEvent(db, { jobId: 'j2', idempotencyKey: 'provider:1', amountUsd: 7 });
  insertCostEvent(db, { idempotencyKey: 'storage:1', category: 'storage', amountUsd: 0 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_cost_events`).get().n, 3);
  assert.equal(
    db.prepare(`SELECT SUM(amount_usd) AS total FROM twi_cost_events WHERE job_id='j1'`).get().total,
    1.25,
  );
});

test('r2 keys are globally unique so two assets cannot claim one object', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  seedProjectAndSpec(db, 'p2', 's2');
  insertAsset(db, { id: 'a1', r2Key: 'twi/shared/object.wav' });

  assert.throws(
    () => insertAsset(db, { id: 'a2', r2Key: 'twi/shared/object.wav' }),
    uniqueFailed('twi_assets.r2_key'),
  );
  assert.throws(
    () => insertAsset(db, { id: 'a3', projectId: 'p2', r2Key: 'twi/shared/object.wav' }),
    uniqueFailed('twi_assets.r2_key'),
  );
});

// ---------------------------------------------------------------------------
// Ownership and referential integrity
// ---------------------------------------------------------------------------

test('revisions form parent-linked branches without deleting siblings', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  db.prepare(`INSERT INTO twi_project_revisions (id,project_id,parent_revision_id,snapshot_key,snapshot_sha256,summary,created_at)
              VALUES ('r1','p1',NULL,'twi/p1/revisions/r1.json','a','root',?),
                     ('r2','p1','r1','twi/p1/revisions/r2.json','b','A',?),
                     ('r3','p1','r1','twi/p1/revisions/r3.json','c','B',?)`).run(T0, T1, T1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_project_revisions WHERE parent_revision_id='r1'`).get().n, 2);
});

test('revision parents cannot cross projects or point to themselves', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  seedProjectAndSpec(db, 'p2', 's2');
  insertRevision(db, { id: 'r1' });

  assert.throws(
    () => insertRevision(db, { id: 'r2', projectId: 'p2', parentRevisionId: 'r1' }),
    foreignKeyFailed,
  );
  assert.throws(
    () => insertRevision(db, { id: 'self', parentRevisionId: 'self' }),
    checkFailed('twi_project_revisions_parent_not_self'),
  );
});

test('spec, job, and asset ownership links cannot cross projects', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  seedProjectAndSpec(db, 'p2', 's2');
  insertJob(db, 'j1', 'job-key');

  assert.throws(() => insertSpec(db, 'missing-project', 's3'), foreignKeyFailed);
  assert.throws(
    () => insertJob(db, 'j2', 'job-key-2', { projectId: 'p2', specId: 's1' }),
    foreignKeyFailed,
  );
  assert.throws(
    () => insertAsset(db, { id: 'a1', projectId: 'p2', jobId: 'j1', kind: 'generation-raw' }),
    foreignKeyFailed,
  );

  insertAsset(db, { id: 'a2', projectId: 'p2' });
  assert.equal(db.prepare(`SELECT job_id FROM twi_assets WHERE id='a2'`).get().job_id, null);
});

test('current revisions must exist in the same project', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  seedProjectAndSpec(db, 'p2', 's2');
  insertRevision(db, { id: 'r1' });
  insertRevision(db, { id: 'r2', projectId: 'p2' });

  assert.throws(
    () => db.prepare(`UPDATE twi_projects SET current_revision_id='missing' WHERE id='p1'`).run(),
    foreignKeyFailed,
  );
  assert.throws(
    () => db.prepare(`UPDATE twi_projects SET current_revision_id='r2' WHERE id='p1'`).run(),
    foreignKeyFailed,
  );
  db.prepare(`UPDATE twi_projects SET current_revision_id='r1' WHERE id='p1'`).run();
  assert.equal(db.prepare(`SELECT current_revision_id FROM twi_projects WHERE id='p1'`).get().current_revision_id, 'r1');
});

test('a referenced current revision is restricted while whole-project deletion cascades', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertRevision(db, { id: 'r1' });
  db.prepare(`UPDATE twi_projects SET current_revision_id='r1' WHERE id='p1'`).run();

  assert.throws(
    () => db.prepare(`DELETE FROM twi_project_revisions WHERE id='r1'`).run(),
    foreignKeyFailed,
  );
  db.exec(`BEGIN; DELETE FROM twi_projects WHERE id='p1'; COMMIT;`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_projects`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_project_revisions`).get().n, 0);
});

test('a project can be created together with its first revision inside one transaction', (t) => {
  const db = freshDb(t);
  // Only DEFERRABLE INITIALLY DEFERRED makes this order legal. Without it the
  // project insert fails immediately on a revision that does not exist yet, and
  // the repository's create-project-with-first-revision path must use batch().
  db.exec('BEGIN');
  db.prepare(`INSERT INTO twi_projects (id,name,current_revision_id,created_at,updated_at)
              VALUES ('p1','Night Signal','r1',?,?)`).run(T0, T0);
  insertRevision(db, { id: 'r1' });
  db.exec('COMMIT');

  assert.equal(db.prepare(`SELECT current_revision_id FROM twi_projects WHERE id='p1'`).get().current_revision_id, 'r1');
});

test('job deletion cascades events and costs but restricts referenced assets', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');
  insertJobEvent(db, { eventKey: 'queued:1' });
  insertCostEvent(db, { idempotencyKey: 'provider:1' });

  db.prepare(`DELETE FROM twi_jobs WHERE id='j1'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_job_events`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_cost_events`).get().n, 0);

  insertJob(db, 'j2', 'job-key-2');
  insertAsset(db, { id: 'a1', jobId: 'j2', kind: 'generation-raw' });
  assert.throws(() => db.prepare(`DELETE FROM twi_jobs WHERE id='j2'`).run(), foreignKeyFailed);
});

test('whole-project deletion cascades every Creation Core child row', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertRevision(db, { id: 'r1' });
  insertJob(db, 'j1', 'job-key');
  insertJobEvent(db, { eventKey: 'queued:1' });
  insertCostEvent(db, { idempotencyKey: 'provider:1' });
  insertAsset(db, { id: 'a1', jobId: 'j1', kind: 'generation-raw' });
  db.prepare(`UPDATE twi_projects SET current_revision_id='r1' WHERE id='p1'`).run();

  db.exec(`BEGIN; DELETE FROM twi_projects WHERE id='p1'; COMMIT;`);
  for (const table of [
    'twi_projects',
    'twi_project_revisions',
    'twi_generation_specs',
    'twi_jobs',
    'twi_job_events',
    'twi_assets',
    'twi_cost_events',
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

test('structured JSON columns require objects, not merely valid JSON', (t) => {
  const db = freshDb(t);
  insertProject(db, 'p1');

  // json_valid() alone accepts every one of these. They are read back as
  // JSON.parse(...).someField, so a stored scalar or array is a latent crash.
  const notObjects = ['123', 'null', 'true', '"hello"', '[]', '[{"a":1}]'];

  for (const value of notObjects) {
    assert.throws(
      () => insertSpec(db, 'p1', `spec-${value}`, value),
      checkFailed('twi_generation_specs_spec_json_object'),
      `spec_json ${value} must be rejected`,
    );
  }
  assert.throws(
    () => insertSpec(db, 'p1', 'bad-spec', '{invalid'),
    checkFailed('twi_generation_specs_spec_json_object'),
  );
  insertSpec(db, 'p1', 's1');

  for (const value of [...notObjects, '{invalid']) {
    assert.throws(
      () => insertJob(db, `j-est-${value}`, `est-${value}`, { estimateJson: value }),
      checkFailed('twi_jobs_estimate_json_object'),
      `estimate_json ${value} must be rejected`,
    );
    assert.throws(
      () => insertJob(db, `j-man-${value}`, `man-${value}`, { outputManifestJson: value }),
      checkFailed('twi_jobs_output_manifest_json_object'),
      `output_manifest_json ${value} must be rejected`,
    );
  }
  insertJob(db, 'j3', 'job-key-3', { estimateJson: '{"total":1}', outputManifestJson: '{"candidates":[]}' });

  for (const value of [...notObjects, '{invalid']) {
    assert.throws(
      () => insertJobEvent(db, { jobId: 'j3', eventKey: `ev-${value}`, detailJson: value }),
      checkFailed('twi_job_events_detail_json_object'),
      `detail_json ${value} must be rejected on job events`,
    );
    assert.throws(
      () => insertCostEvent(db, { jobId: 'j3', idempotencyKey: `cost-${value}`, detailJson: value }),
      checkFailed('twi_cost_events_detail_json_object'),
      `detail_json ${value} must be rejected on cost events`,
    );
  }

  // Nullable JSON columns still accept NULL.
  insertJob(db, 'j4', 'job-key-4', { estimateJson: null, outputManifestJson: null });
  assert.equal(db.prepare(`SELECT estimate_json FROM twi_jobs WHERE id='j4'`).get().estimate_json, null);
});

// ---------------------------------------------------------------------------
// Numeric measures
// ---------------------------------------------------------------------------

test('numeric measures reject negatives and noninteger asset bytes', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  assert.throws(
    () => insertJob(db, 'j-negative', 'job-negative', { actualCostUsd: -0.01 }),
    checkFailed('twi_jobs_actual_cost_usd_finite'),
  );
  insertJob(db, 'j1', 'job-key');

  assert.throws(
    () => insertAsset(db, { id: 'a-negative-bytes', bytes: -1 }),
    checkFailed('twi_assets_bytes_integer'),
  );
  assert.throws(
    () => insertAsset(db, { id: 'a-real-bytes', bytes: 1.5 }),
    checkFailed('twi_assets_bytes_integer'),
  );
  assert.throws(
    () => insertAsset(db, { id: 'a-negative-duration', durationSeconds: -0.01 }),
    checkFailed('twi_assets_duration_seconds_finite'),
  );
  insertAsset(db, { id: 'a-zero', bytes: 0, durationSeconds: 0 });

  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: 'negative-cost', amountUsd: -0.01 }),
    checkFailed('twi_cost_events_amount_usd_finite'),
  );
  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: 'negative-quantity', quantity: -0.01 }),
    checkFailed('twi_cost_events_quantity_finite'),
  );
  insertCostEvent(db, { idempotencyKey: 'zero-cost', amountUsd: 0, quantity: 0 });
});

test('job actual cost accepts finite numbers and rejects text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  assert.throws(
    () => insertJob(db, 'j-text', 'job-text', { actualCostUsd: 'garbage' }),
    checkFailed('twi_jobs_actual_cost_usd_finite'),
  );
  assert.throws(
    () => insertJob(db, 'j-infinity', 'job-infinity', { actualCostUsd: Infinity }),
    checkFailed('twi_jobs_actual_cost_usd_finite'),
  );
  insertJob(db, 'j-zero', 'job-zero', { actualCostUsd: 0 });
  insertJob(db, 'j-positive', 'job-positive', { actualCostUsd: 1.25 });
});

test('asset duration accepts null and finite numbers but rejects text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  assert.throws(
    () => insertAsset(db, { id: 'a-text', durationSeconds: 'garbage' }),
    checkFailed('twi_assets_duration_seconds_finite'),
  );
  assert.throws(
    () => insertAsset(db, { id: 'a-infinity', durationSeconds: Infinity }),
    checkFailed('twi_assets_duration_seconds_finite'),
  );
  insertAsset(db, { id: 'a-null', durationSeconds: null });
  insertAsset(db, { id: 'a-zero-duration', durationSeconds: 0 });
  insertAsset(db, { id: 'a-positive-duration', durationSeconds: 185.5 });
});

test('cost amounts accept finite numbers and reject text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: 'amount-text', amountUsd: 'garbage' }),
    checkFailed('twi_cost_events_amount_usd_finite'),
  );
  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: 'amount-infinity', amountUsd: Infinity }),
    checkFailed('twi_cost_events_amount_usd_finite'),
  );
  insertCostEvent(db, { idempotencyKey: 'amount-zero', amountUsd: 0 });
  insertCostEvent(db, { idempotencyKey: 'amount-positive', amountUsd: 2.75 });
});

test('cost quantities accept null and finite numbers but reject text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: 'quantity-text', quantity: 'garbage' }),
    checkFailed('twi_cost_events_quantity_finite'),
  );
  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: 'quantity-infinity', quantity: Infinity }),
    checkFailed('twi_cost_events_quantity_finite'),
  );
  insertCostEvent(db, { idempotencyKey: 'quantity-null', quantity: null });
  insertCostEvent(db, { idempotencyKey: 'quantity-zero', quantity: 0 });
  insertCostEvent(db, { idempotencyKey: 'quantity-positive', quantity: 4.5 });
});

// ---------------------------------------------------------------------------
// Identity columns
// ---------------------------------------------------------------------------

test('text primary keys reject empty strings and non-text storage classes', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('','Empty',?,?)`).run(T0, T0),
    checkFailed('twi_projects_id_identity'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES (?,'Blob',?,?)`)
      .run(Buffer.from('p9'), T0, T0),
    checkFailed('twi_projects_id_identity'),
  );
  assert.throws(() => insertRevision(db, { id: '' }), checkFailed('twi_project_revisions_id_identity'));
  assert.throws(() => insertSpec(db, 'p1', ''), checkFailed('twi_generation_specs_id_identity'));
  assert.throws(() => insertJob(db, '', 'empty-id-key'), checkFailed('twi_jobs_id_identity'));
  assert.throws(() => insertAsset(db, { id: '', r2Key: 'twi/p1/assets/empty' }), checkFailed('twi_assets_id_identity'));
});

test('an empty idempotency key is rejected rather than turned into a collision', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  // A missing Idempotency-Key header must not become a cross-request duplicate
  // detection on a paid path: '' would collide with the previous '' submission.
  assert.throws(() => insertJob(db, 'j-empty-key', ''), checkFailed('twi_jobs_idempotency_key_identity'));
  insertJob(db, 'j1', 'job-key');
  assert.throws(
    () => insertCostEvent(db, { idempotencyKey: '' }),
    checkFailed('twi_cost_events_idempotency_key_identity'),
  );
  assert.throws(
    () => insertJobEvent(db, { eventKey: '' }),
    checkFailed('twi_job_events_event_key_identity'),
  );
});

test('project names must be nonblank text, not a blob and not whitespace', (t) => {
  const db = freshDb(t);

  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-blob',?,?,?)`)
      .run(Buffer.from('Night Signal'), T0, T0),
    checkFailed('twi_projects_name_text'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-blank','   ',?,?)`).run(T0, T0),
    checkFailed('twi_projects_name_text'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-null',NULL,?,?)`).run(T0, T0),
    notNullFailed('twi_projects.name'),
  );
  insertProject(db, 'p1', 'Night Signal');
});

test('asset and revision content keys must be nonblank', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  assert.throws(() => insertAsset(db, { id: 'a-empty-r2', r2Key: '' }), checkFailed('twi_assets_r2_key_identity'));
  assert.throws(() => insertAsset(db, { id: 'a-empty-sha', sha256: '' }), checkFailed('twi_assets_sha256_identity'));
  assert.throws(
    () => insertAsset(db, { id: 'a-empty-type', contentType: '' }),
    checkFailed('twi_assets_content_type_identity'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_project_revisions (id,project_id,parent_revision_id,snapshot_key,snapshot_sha256,summary,created_at)
                      VALUES ('r-empty','p1',NULL,'','sha','summary',?)`).run(T0),
    checkFailed('twi_project_revisions_snapshot_key_identity'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_project_revisions (id,project_id,parent_revision_id,snapshot_key,snapshot_sha256,summary,created_at)
                      VALUES ('r-empty-sha','p1',NULL,'twi/p1/revisions/r.json','','summary',?)`).run(T0),
    checkFailed('twi_project_revisions_snapshot_sha256_identity'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_generation_specs (id,project_id,spec_json,spec_sha256,rights_assertion_version,created_at)
                      VALUES ('s-empty','p1','{}','','v1',?)`).run(T0),
    checkFailed('twi_generation_specs_spec_sha256_identity'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_generation_specs (id,project_id,spec_json,spec_sha256,rights_assertion_version,created_at)
                      VALUES ('s-empty-rights','p1','{}','sha','',?)`).run(T0),
    checkFailed('twi_generation_specs_rights_version_identity'),
  );
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test('timestamp columns require fixed-width ISO-8601 UTC milliseconds', (t) => {
  const db = freshDb(t);

  // Everything SQLite would otherwise store happily in a TEXT column, including
  // the shapes that break MAX(updated_at, ?) ordering and the impossible
  // calendar dates a shape-only pattern would wave through.
  const rejected = [
    'not a date',
    '',
    '2026-08-16',
    '2026-08-16 00:00:00',
    '2026-08-16T00:00:00Z',
    '2026-08-16T00:00:00.000',
    '2026-08-16T00:00:00.0000Z',
    '2026-08-16T00:00:00.000+02:00',
    '2026-08-16t00:00:00.000z',
    '2026-8-16T00:00:00.000Z',
    'xxxx-xx-xxTxx:xx:xx.xxxZ',
    '2026-13-16T00:00:00.000Z',
    '2026-08-32T00:00:00.000Z',
  ];
  for (const value of rejected) {
    assert.throws(
      () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES (?,'P',?,?)`)
        .run(`p-${value}`, value, value),
      checkFailed('twi_projects_created_at_iso'),
      `created_at ${JSON.stringify(value)} must be rejected`,
    );
  }
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-int','P',?,?)`)
      .run(20260816, T0),
    checkFailed('twi_projects_created_at_iso'),
  );
  // The single most dangerous value for MAX(updated_at, ?) — 'n' outranks every
  // digit, so one such write latches the column forever. SQLite refuses to even
  // evaluate it, which is a rejection of a different and stricter kind.
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-now','P',?,?)`)
      .run('now', 'now'),
    exactly('non-deterministic use of strftime() in a CHECK constraint'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-bad-updated','P',?,?)`)
      .run(T0, '2026-08-16 01:00:00'),
    checkFailed('twi_projects_updated_at_iso'),
  );

  insertProject(db, 'p1');
  insertSpec(db, 'p1', 's1');
  assert.throws(
    () => insertJob(db, 'j-bad-created', 'bad-created', { createdAt: 'not a date', updatedAt: T0 }),
    checkFailed('twi_jobs_created_at_iso'),
  );
  // 'zzzz' sorts *after* any ISO timestamp, so the updated_at >= created_at
  // ordering guard would wave it through — only the shape guard catches it, and
  // it is exactly the value that would latch MAX(updated_at, ?) forever.
  assert.throws(
    () => insertJob(db, 'j-bad-updated', 'bad-updated', { createdAt: T0, updatedAt: 'zzzz' }),
    checkFailed('twi_jobs_updated_at_iso'),
  );
  insertJob(db, 'j1', 'job-key');
  assert.throws(
    () => db.prepare(`UPDATE twi_jobs SET updated_at='2026-08-16 09:00:00' WHERE id='j1'`).run(),
    checkFailed('twi_jobs_updated_at_iso'),
  );
  assert.throws(
    () => db.prepare(`UPDATE twi_jobs SET finished_at='soon' WHERE id='j1'`).run(),
    checkFailed('twi_jobs_finished_at_iso'),
  );
  db.prepare(`UPDATE twi_jobs SET finished_at=? WHERE id='j1'`).run(T1);

  assert.throws(
    () => db.prepare(`INSERT INTO twi_job_events (job_id,event_key,to_status,created_at)
                      VALUES ('j1','bad-ts','queued','2026-08-16')`).run(),
    checkFailed('twi_job_events_created_at_iso'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_cost_events (job_id,idempotency_key,category,amount_usd,created_at)
                      VALUES ('j1','bad-ts','provider',1.0,'2026-08-16')`).run(),
    checkFailed('twi_cost_events_created_at_iso'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_project_revisions (id,project_id,parent_revision_id,snapshot_key,snapshot_sha256,summary,created_at)
                      VALUES ('r-bad-ts','p1',NULL,'twi/p1/revisions/r.json','sha','summary','2026-08-16')`).run(),
    checkFailed('twi_project_revisions_created_at_iso'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_generation_specs (id,project_id,spec_json,spec_sha256,rights_assertion_version,created_at)
                      VALUES ('s-bad-ts','p1','{}','sha','v1','2026-08-16')`).run(),
    checkFailed('twi_generation_specs_created_at_iso'),
  );
  assert.throws(
    () => insertAsset(db, { id: 'a-bad-ts', createdAt: '2026-08-16' }),
    checkFailed('twi_assets_created_at_iso'),
  );
});

test('soft-delete timestamps must be ISO too, not just non-null', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
                      VALUES ('p-xxx','P','deleted','xxx',?,?)`).run(T0, T0),
    checkFailed('twi_projects_deleted_at_iso'),
  );
  assert.throws(
    () => insertAsset(db, { id: 'a-xxx', lifecycleState: 'deleted', deletedAt: 'xxx' }),
    checkFailed('twi_assets_deleted_at_iso'),
  );
  insertAsset(db, { id: 'a-deleted', lifecycleState: 'deleted', deletedAt: T1 });
});

test('updated_at can never predate created_at, and stays legal under MAX() advancement', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,created_at,updated_at) VALUES ('p-back','P',?,?)`)
      .run(T1, T0),
    checkFailed('twi_projects_updated_not_before_created'),
  );
  assert.throws(
    () => insertJob(db, 'j-back', 'back-key', { createdAt: T1, updatedAt: T0 }),
    checkFailed('twi_jobs_updated_not_before_created'),
  );

  // The guard must not fight the repository. Task 4 advances the column with
  // MAX(updated_at, ?) to stay monotonic against concurrent cost writes; an
  // older `now` is absorbed, a newer one moves the column forward, and neither
  // may trip the CHECK.
  insertJob(db, 'j1', 'job-key', { createdAt: T1, updatedAt: T1 });
  db.prepare(`UPDATE twi_jobs SET updated_at = MAX(updated_at, ?) WHERE id='j1'`).run(T0);
  assert.equal(db.prepare(`SELECT updated_at FROM twi_jobs WHERE id='j1'`).get().updated_at, T1);
  db.prepare(`UPDATE twi_jobs SET updated_at = MAX(updated_at, ?) WHERE id='j1'`).run(T2);
  assert.equal(db.prepare(`SELECT updated_at FROM twi_jobs WHERE id='j1'`).get().updated_at, T2);
});

// ---------------------------------------------------------------------------
// Lifecycle consistency
// ---------------------------------------------------------------------------

test('project lifecycle timestamps stay consistent', (t) => {
  const db = freshDb(t);
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
                      VALUES ('active-deleted','Invalid','active',?,?,?)`).run(T0, T0, T0),
    checkFailed('twi_projects_lifecycle_deleted_at'),
  );
  assert.throws(
    () => db.prepare(`INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
                      VALUES ('deleted-live','Invalid','deleted',NULL,?,?)`).run(T0, T0),
    checkFailed('twi_projects_lifecycle_deleted_at'),
  );
  db.prepare(`INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
              VALUES ('deleted-valid','Valid','deleted',?,?,?)`).run(T0, T0, T0);
});

test('asset lifecycle timestamps stay consistent', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  assert.throws(
    () => insertAsset(db, { id: 'active-deleted', deletedAt: T0 }),
    checkFailed('twi_assets_lifecycle_deleted_at'),
  );
  assert.throws(
    () => insertAsset(db, { id: 'deleted-live', lifecycleState: 'deleted' }),
    checkFailed('twi_assets_lifecycle_deleted_at'),
  );
  insertAsset(db, { id: 'deleted-valid', lifecycleState: 'deleted', deletedAt: T0 });
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

test('every declared index exists after the migration', (t) => {
  const db = freshDb(t);
  const found = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND name LIKE 'idx_twi_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(found, [...EXPECTED_INDEXES].sort());
});

test('the hot Creation Core reads use an index instead of scanning', (t) => {
  const db = freshDb(t);
  const planFor = (sql, ...bindings) =>
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => row.detail).join(' | ');

  const indexedReads = [
    ["active projects, newest first", `SELECT id FROM twi_projects WHERE lifecycle_state='active' ORDER BY updated_at DESC`, 'idx_twi_projects_updated'],
    ["jobs of a project, newest first", `SELECT id FROM twi_jobs WHERE project_id=? ORDER BY created_at DESC`, 'idx_twi_jobs_project'],
    ["jobs by status for a poller", `SELECT id FROM twi_jobs WHERE status='queued'`, 'idx_twi_jobs_status'],
    ["job events in insertion order", `SELECT event_key FROM twi_job_events WHERE job_id=? ORDER BY id`, 'idx_twi_job_events_job'],
    ["spend per job", `SELECT amount_usd FROM twi_cost_events WHERE job_id=? ORDER BY id`, 'idx_twi_cost_events_job'],
    ["active assets of a project", `SELECT id FROM twi_assets WHERE project_id=? AND lifecycle_state='active' ORDER BY created_at DESC`, 'idx_twi_assets_project'],
    ["assets of a job", `SELECT id FROM twi_assets WHERE job_id=? AND lifecycle_state='provisional' ORDER BY created_at DESC`, 'idx_twi_assets_job'],
    ["revisions of a project", `SELECT id FROM twi_project_revisions WHERE project_id=? ORDER BY created_at DESC`, 'idx_twi_revisions_project'],
    ["children of a revision", `SELECT id FROM twi_project_revisions WHERE project_id=? AND parent_revision_id=? ORDER BY created_at DESC`, 'idx_twi_revisions_parent'],
  ];

  for (const [label, sql, expectedIndex] of indexedReads) {
    const bindings = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x');
    const plan = planFor(sql, ...bindings);
    assert.match(plan, new RegExp(`USING (COVERING )?INDEX ${expectedIndex}`), `${label}: ${plan}`);
    assert.doesNotMatch(plan, /\bSCAN twi_/, `${label} must not scan: ${plan}`);
  }

  // The uniqueness keys are indexes too, and the replay lookups ride them.
  assert.match(
    planFor(`SELECT id FROM twi_jobs WHERE idempotency_key=?`, 'k'),
    /USING (COVERING )?INDEX sqlite_autoindex_twi_jobs_/,
  );
  assert.match(
    planFor(`SELECT id FROM twi_assets WHERE r2_key=?`, 'k'),
    /USING (COVERING )?INDEX sqlite_autoindex_twi_assets_/,
  );
});

// ---------------------------------------------------------------------------
// Idempotent re-application
// ---------------------------------------------------------------------------

test('migration can execute twice without losing existing project data', (t) => {
  const db = freshDb(t);
  insertProject(db, 'p1');
  db.exec(migrationSql);
  assert.equal(db.prepare(`SELECT name FROM twi_projects WHERE id='p1'`).get().name, 'Project p1');
  const found = db.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_twi_%'
  `).get().n;
  assert.equal(found, EXPECTED_INDEXES.length);
});

test('every statement in the migration is re-runnable and the file ends cleanly', () => {
  // The runner applies and records in two separate wrangler calls, so a partial
  // re-run must be safe: every DDL statement carries IF NOT EXISTS.
  const statements = migrationSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  assert.ok(statements.length >= 16, `expected the full DDL, found ${statements.length} statements`);
  for (const statement of statements) {
    assert.match(statement, /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS /, statement.slice(0, 80));
  }
  // The D1 boot path in src/twi/server/repository-d1.test.ts splits this file on
  // ';' and runs each trimmed chunk. A semicolon inside a comment produces a
  // comment-only chunk, which D1 rejects with "SQL code did not contain a
  // statement" — so every chunk must carry real DDL.
  for (const chunk of migrationSql.split(';').map((part) => part.trim()).filter(Boolean)) {
    const code = chunk
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    assert.notEqual(code, '', `comment-only chunk would break the D1 loader: ${chunk.slice(0, 80)}`);
  }

  // D1 caps LIKE/GLOB patterns at 50 characters and fails at *write* time with
  // "LIKE or GLOB pattern too complex". node:sqlite has no such cap, so a long
  // pattern would leave this suite green and break every insert on D1.
  for (const [, pattern] of migrationSql.matchAll(/(?:LIKE|GLOB)\s+'((?:[^']|'')*)'/gi)) {
    assert.ok(pattern.length <= 50, `D1 rejects LIKE/GLOB patterns over 50 chars: ${pattern}`);
  }

  assert.equal(migrationSql.includes('\r'), false, 'migration must be LF-only');
  assert.equal(migrationSql.charCodeAt(0) === 0xfeff, false, 'migration must not start with a BOM');
  assert.equal(migrationSql.trimEnd().endsWith(';'), true, 'migration must end on its final semicolon');
});
