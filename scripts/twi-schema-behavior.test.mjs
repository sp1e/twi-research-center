import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrationSql = readFileSync(
  new URL('../twi-migration-001-creation-core.sql', import.meta.url),
  'utf8',
);

function freshDb(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migrationSql);
  return db;
}

function insertProject(db, id, name = `Project ${id}`) {
  return db.prepare(`
    INSERT INTO twi_projects (id, name, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
  `).run(id, name);
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
    ) VALUES (?, ?, ?, 'spec-sha256', '2026-08-16', datetime('now'))
  `).run(id, projectId, specJson);
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
    ) VALUES (?, ?, ?, ?, 'revision-sha256', 'Test revision', datetime('now'))
  `).run(id, projectId, parentRevisionId, `twi/${projectId}/revisions/${id}.json`);
}

function insertJob(db, id, idempotencyKey, {
  projectId = 'p1',
  specId = 's1',
  status = 'queued',
  actualCostUsd = 0,
  estimateJson = null,
  outputManifestJson = null,
} = {}) {
  return db.prepare(`
    INSERT INTO twi_jobs (
      id,
      project_id,
      spec_id,
      kind,
      status,
      idempotency_key,
      actual_cost_usd,
      estimate_json,
      output_manifest_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'full-song', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    projectId,
    specId,
    status,
    idempotencyKey,
    actualCostUsd,
    estimateJson,
    outputManifestJson,
  );
}

function insertJobEvent(db, {
  jobId = 'j1',
  eventKey,
  fromStatus = null,
  toStatus = 'queued',
  detailJson = '{}',
} = {}) {
  return db.prepare(`
    INSERT INTO twi_job_events (
      job_id,
      event_key,
      from_status,
      to_status,
      detail_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(jobId, eventKey, fromStatus, toStatus, detailJson);
}

function insertAsset(db, {
  id,
  projectId = 'p1',
  jobId = null,
  kind = 'image-reference',
  r2Key,
  bytes = 0,
  durationSeconds = null,
  lifecycleState = 'active',
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
    ) VALUES (?, ?, ?, ?, ?, 'audio/wav', ?, ?, 'asset-sha256', ?, datetime('now'), ?)
  `).run(
    id,
    projectId,
    jobId,
    kind,
    r2Key ?? `twi/${projectId}/assets/${id}`,
    bytes,
    durationSeconds,
    lifecycleState,
    deletedAt,
  );
}

function insertCostEvent(db, {
  jobId = 'j1',
  idempotencyKey,
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
    ) VALUES (?, ?, 'provider', ?, ?, ?, datetime('now'))
  `).run(jobId, idempotencyKey, amountUsd, quantity, detailJson);
}

test('job status rejects values outside the TWI state machine', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  assert.throws(() => db.prepare(
    `INSERT INTO twi_jobs (id, project_id, spec_id, kind, status, idempotency_key, created_at, updated_at)
     VALUES ('j1','p1','s1','full-song','unknown','key1',datetime('now'),datetime('now'))`
  ).run());
});

test('idempotency keys are unique', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'same-key');
  assert.throws(() => insertJob(db, 'j2', 'same-key'));
});

test('revisions form parent-linked branches without deleting siblings', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  db.exec(`INSERT INTO twi_project_revisions (id,project_id,parent_revision_id,snapshot_key,snapshot_sha256,summary,created_at)
           VALUES ('r1','p1',NULL,'twi/p1/revisions/r1.json','a','root',datetime('now')),
                  ('r2','p1','r1','twi/p1/revisions/r2.json','b','A',datetime('now')),
                  ('r3','p1','r1','twi/p1/revisions/r3.json','c','B',datetime('now'));`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_project_revisions WHERE parent_revision_id='r1'`).get().n, 2);
});

test('revision parents cannot cross projects or point to themselves', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  seedProjectAndSpec(db, 'p2', 's2');
  insertRevision(db, { id: 'r1' });

  assert.throws(() => insertRevision(db, {
    id: 'r2',
    projectId: 'p2',
    parentRevisionId: 'r1',
  }));
  assert.throws(() => insertRevision(db, {
    id: 'self',
    parentRevisionId: 'self',
  }));
});

test('spec, job, and asset ownership links cannot cross projects', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  seedProjectAndSpec(db, 'p2', 's2');
  insertJob(db, 'j1', 'job-key');

  assert.throws(() => insertSpec(db, 'missing-project', 's3'));
  assert.throws(() => insertJob(db, 'j2', 'job-key-2', {
    projectId: 'p2',
    specId: 's1',
  }));
  assert.throws(() => insertAsset(db, {
    id: 'a1',
    projectId: 'p2',
    jobId: 'j1',
    kind: 'generation-raw',
  }));

  insertAsset(db, { id: 'a2', projectId: 'p2' });
  assert.equal(db.prepare(`SELECT job_id FROM twi_assets WHERE id='a2'`).get().job_id, null);
});

test('current revisions must exist in the same project', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  seedProjectAndSpec(db, 'p2', 's2');
  insertRevision(db, { id: 'r1' });
  insertRevision(db, { id: 'r2', projectId: 'p2' });

  assert.throws(() => db.prepare(
    `UPDATE twi_projects SET current_revision_id='missing' WHERE id='p1'`
  ).run());
  assert.throws(() => db.prepare(
    `UPDATE twi_projects SET current_revision_id='r2' WHERE id='p1'`
  ).run());
  db.prepare(`UPDATE twi_projects SET current_revision_id='r1' WHERE id='p1'`).run();
  assert.equal(db.prepare(`SELECT current_revision_id FROM twi_projects WHERE id='p1'`).get().current_revision_id, 'r1');
});

test('a referenced current revision is restricted while whole-project deletion cascades', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertRevision(db, { id: 'r1' });
  db.prepare(`UPDATE twi_projects SET current_revision_id='r1' WHERE id='p1'`).run();

  assert.throws(() => db.prepare(`DELETE FROM twi_project_revisions WHERE id='r1'`).run());
  db.exec(`BEGIN; DELETE FROM twi_projects WHERE id='p1'; COMMIT;`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_projects`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_project_revisions`).get().n, 0);
});

test('job event keys make logical event replay idempotent', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  insertJobEvent(db, { eventKey: 'queued:1' });
  assert.throws(() => insertJobEvent(db, { eventKey: 'queued:1' }));
  insertJobEvent(db, { eventKey: 'generating:1', fromStatus: 'queued', toStatus: 'generating' });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_job_events`).get().n, 2);
});

test('cost event keys make logical charge replay idempotent', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  insertCostEvent(db, { idempotencyKey: 'provider:1', amountUsd: 1.25 });
  assert.throws(() => insertCostEvent(db, { idempotencyKey: 'provider:1', amountUsd: 1.25 }));
  insertCostEvent(db, { idempotencyKey: 'storage:1', amountUsd: 0 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_cost_events`).get().n, 2);
});

test('structured JSON columns reject malformed documents and accept null boundaries', (t) => {
  const db = freshDb(t);
  insertProject(db, 'p1');
  assert.throws(() => insertSpec(db, 'p1', 'bad-spec', '{invalid'));
  insertSpec(db, 'p1', 's1');

  assert.throws(() => insertJob(db, 'j1', 'job-key-1', { estimateJson: '{invalid' }));
  assert.throws(() => insertJob(db, 'j2', 'job-key-2', { outputManifestJson: '{invalid' }));
  insertJob(db, 'j3', 'job-key-3');

  assert.throws(() => insertJobEvent(db, { jobId: 'j3', eventKey: 'event-bad-json', detailJson: '{invalid' }));
  assert.throws(() => insertCostEvent(db, { jobId: 'j3', idempotencyKey: 'cost-bad-json', detailJson: '{invalid' }));
});

test('numeric measures reject negatives and noninteger asset bytes', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  assert.throws(() => insertJob(db, 'j-negative', 'job-negative', { actualCostUsd: -0.01 }));
  insertJob(db, 'j1', 'job-key');

  assert.throws(() => insertAsset(db, { id: 'a-negative-bytes', bytes: -1 }));
  assert.throws(() => insertAsset(db, { id: 'a-real-bytes', bytes: 1.5 }));
  assert.throws(() => insertAsset(db, { id: 'a-negative-duration', durationSeconds: -0.01 }));
  insertAsset(db, { id: 'a-zero', bytes: 0, durationSeconds: 0 });

  assert.throws(() => insertCostEvent(db, { idempotencyKey: 'negative-cost', amountUsd: -0.01 }));
  assert.throws(() => insertCostEvent(db, { idempotencyKey: 'negative-quantity', quantity: -0.01 }));
  insertCostEvent(db, { idempotencyKey: 'zero-cost', amountUsd: 0, quantity: 0 });
});

test('job actual cost accepts finite numbers and rejects text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  assert.throws(() => insertJob(db, 'j-text', 'job-text', { actualCostUsd: 'garbage' }));
  assert.throws(() => insertJob(db, 'j-infinity', 'job-infinity', { actualCostUsd: Infinity }));
  insertJob(db, 'j-zero', 'job-zero', { actualCostUsd: 0 });
  insertJob(db, 'j-positive', 'job-positive', { actualCostUsd: 1.25 });
});

test('asset duration accepts null and finite numbers but rejects text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);

  assert.throws(() => insertAsset(db, { id: 'a-text', durationSeconds: 'garbage' }));
  assert.throws(() => insertAsset(db, { id: 'a-infinity', durationSeconds: Infinity }));
  insertAsset(db, { id: 'a-null', durationSeconds: null });
  insertAsset(db, { id: 'a-zero-duration', durationSeconds: 0 });
  insertAsset(db, { id: 'a-positive-duration', durationSeconds: 185.5 });
});

test('cost amounts accept finite numbers and reject text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  assert.throws(() => insertCostEvent(db, { idempotencyKey: 'amount-text', amountUsd: 'garbage' }));
  assert.throws(() => insertCostEvent(db, { idempotencyKey: 'amount-infinity', amountUsd: Infinity }));
  insertCostEvent(db, { idempotencyKey: 'amount-zero', amountUsd: 0 });
  insertCostEvent(db, { idempotencyKey: 'amount-positive', amountUsd: 2.75 });
});

test('cost quantities accept null and finite numbers but reject text or infinity', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  assert.throws(() => insertCostEvent(db, { idempotencyKey: 'quantity-text', quantity: 'garbage' }));
  assert.throws(() => insertCostEvent(db, { idempotencyKey: 'quantity-infinity', quantity: Infinity }));
  insertCostEvent(db, { idempotencyKey: 'quantity-null', quantity: null });
  insertCostEvent(db, { idempotencyKey: 'quantity-zero', quantity: 0 });
  insertCostEvent(db, { idempotencyKey: 'quantity-positive', quantity: 4.5 });
});

test('job event states use the same state machine as jobs', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  insertJob(db, 'j1', 'job-key');

  assert.throws(() => insertJobEvent(db, {
    eventKey: 'bad-from',
    fromStatus: 'unknown',
    toStatus: 'queued',
  }));
  assert.throws(() => insertJobEvent(db, {
    eventKey: 'bad-to',
    toStatus: 'unknown',
  }));
  insertJobEvent(db, { eventKey: 'valid-null-from' });
});

test('project lifecycle timestamps stay consistent', (t) => {
  const db = freshDb(t);
  assert.throws(() => db.prepare(`
    INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
    VALUES ('active-deleted','Invalid','active',datetime('now'),datetime('now'),datetime('now'))
  `).run());
  assert.throws(() => db.prepare(`
    INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
    VALUES ('deleted-live','Invalid','deleted',NULL,datetime('now'),datetime('now'))
  `).run());
  db.prepare(`
    INSERT INTO twi_projects (id,name,lifecycle_state,deleted_at,created_at,updated_at)
    VALUES ('deleted-valid','Valid','deleted',datetime('now'),datetime('now'),datetime('now'))
  `).run();
});

test('asset lifecycle timestamps stay consistent', (t) => {
  const db = freshDb(t);
  seedProjectAndSpec(db);
  assert.throws(() => insertAsset(db, {
    id: 'active-deleted',
    deletedAt: '2026-08-16T00:00:00Z',
  }));
  assert.throws(() => insertAsset(db, {
    id: 'deleted-live',
    lifecycleState: 'deleted',
  }));
  insertAsset(db, {
    id: 'deleted-valid',
    lifecycleState: 'deleted',
    deletedAt: '2026-08-16T00:00:00Z',
  });
});

test('migration can execute twice without losing existing project data', (t) => {
  const db = freshDb(t);
  insertProject(db, 'p1');
  db.exec(migrationSql);
  assert.equal(db.prepare(`SELECT name FROM twi_projects WHERE id='p1'`).get().name, 'Project p1');
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
  assert.throws(() => db.prepare(`DELETE FROM twi_jobs WHERE id='j2'`).run());
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
