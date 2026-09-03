import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T0,
  T1,
  T2,
  checkFailed,
  exactly,
  foreignKeyFailed,
  freshDb,
  insertJob,
  notNullFailed,
  seedProjectAndSpec,
  uniqueFailed,
} from './lib/twi-schema-harness.mjs';

/*
 * Split out of scripts/twi-schema-behavior.test.mjs, which this section had taken to 1577 lines
 * against the project's 800-line ceiling. Same `node --test` invocation (npm run test:twi:schema),
 * so the two files' counts add into one floor, and the same fixture
 * (scripts/lib/twi-schema-harness.mjs), so they cannot end up with two databases that disagree.
 *
 * TEN of the twelve tests below moved here with their bodies untouched. The other two were added by
 * the same fix round, because a verifier reached past the ten with raw SQL: `an abandoned call
 * carries no request id` (a completed/charged row laundered to not_charged in ONE update, still
 * carrying the request id of the charge it denied) and `the partial index carries exactly the
 * predicate the inventory query spells` (widening that predicate is invisible to every EXPLAIN
 * QUERY PLAN assertion). The whitespace cases in the request-id and resolution-note tests were
 * added for the same reason.
 */

const PROVIDER_CALL_STATES = ['submitting', 'accepted', 'completed', 'ambiguous', 'abandoned'];
const CHARGE_CERTAINTIES = ['unknown', 'charged', 'not_charged'];

// ---------------------------------------------------------------------------
// Provider-call state (migration 002)
//
// One row per billable provider call, written BEFORE the call. The tests here drive the
// table with RAW SQL on purpose: the repository derives charge_certainty from state in one
// place, so a TypeScript caller can never produce an illegal pairing — which is exactly why
// the schema has to be shown refusing one on its own. The table CHECK is the second line of
// defence and the only one that stands when the writer is a console, a script or a bug.
// ---------------------------------------------------------------------------

/** The test's own transcription of the pairing, independent of the repository's map. */
const CERTAINTY_BY_STATE = {
  submitting: 'unknown',
  ambiguous: 'unknown',
  completed: 'charged',
  accepted: 'charged',
  abandoned: 'not_charged',
};

function insertProviderCall(db, {
  jobId = 'j1',
  attempt = 0,
  label = 'A',
  claimKey,
  state = 'submitting',
  chargeCertainty,
  providerMode = 'fake',
  provider = null,
  model = null,
  providerRequestId,
  detailJson = '{}',
  claimedAt = T0,
  settledAt,
  resolvedAt = null,
  resolutionNote = null,
} = {}) {
  // Defaults keep every OTHER constraint satisfied, so a refusal names the rule under test.
  const certainty = chargeCertainty === undefined ? CERTAINTY_BY_STATE[state] : chargeCertainty;
  const settled = settledAt === undefined ? (state === 'submitting' ? null : claimedAt) : settledAt;
  const requestId = providerRequestId === undefined ? (state === 'completed' ? `req-${label}` : null) : providerRequestId;
  return db.prepare(`
    INSERT INTO twi_provider_calls (
      job_id, attempt, label, claim_key, state, charge_certainty, provider_mode, provider, model,
      provider_request_id, detail_json, claimed_at, settled_at, resolved_at, resolution_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    attempt,
    label,
    claimKey ?? `${jobId}:${attempt}:provider-call:${label}`,
    state,
    certainty,
    providerMode,
    provider,
    model,
    requestId,
    detailJson,
    claimedAt,
    settled,
    resolvedAt,
    resolutionNote,
  );
}

function seedJobForProviderCalls(db, jobId = 'j1') {
  seedProjectAndSpec(db);
  insertJob(db, jobId, `${jobId}-key`);
}

test('provider-call state and charge certainty are paired by the table, and every other pairing is refused', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  let attempt = 0;
  let stored = 0;
  for (const state of PROVIDER_CALL_STATES) {
    for (const certainty of CHARGE_CERTAINTIES) {
      const current = attempt;
      attempt += 1;
      if (CERTAINTY_BY_STATE[state] === certainty) {
        insertProviderCall(db, { attempt: current, state, chargeCertainty: certainty });
        stored += 1;
        continue;
      }
      // The laundering shapes: an ambiguous or submitting call declared not_charged, an
      // abandoned call declared charged, a completed call declared unknown. Every one of the
      // ten illegal pairs is refused BY NAME, whatever the writer.
      assert.throws(
        () => insertProviderCall(db, { attempt: current, state, chargeCertainty: certainty }),
        checkFailed('twi_provider_calls_state_certainty'),
        `${state} paired with ${certainty} must be refused`,
      );
    }
  }
  assert.equal(stored, PROVIDER_CALL_STATES.length, 'exactly one legal certainty per state');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, stored);

  // 'not_submitted' is a READER's word for the absence of a row. It is never a stored state,
  // and neither is anything else outside the five.
  assert.throws(
    () => insertProviderCall(db, { attempt: 100, state: 'not_submitted', chargeCertainty: 'unknown' }),
    checkFailed('twi_provider_calls_state_enum'),
  );
  assert.throws(
    () => insertProviderCall(db, { attempt: 101, state: 'submitting', chargeCertainty: 'maybe' }),
    checkFailed('twi_provider_calls_charge_certainty_enum'),
  );
});

test('a completed provider call must carry its provider request id', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  // A single space and a tab are here because `length(x) > 0` admits them while the column's own
  // comment calls the value "non-blank text" and the sibling resolution CHECK uses
  // length(trim(...)). A whitespace request id reconciles nothing: it is a charge on the account
  // with an invisible string to match it against.
  for (const [index, providerRequestId] of [null, '', ' ', '\t\n', '   ', Buffer.from('req')].entries()) {
    assert.throws(
      () => insertProviderCall(db, { attempt: index, state: 'completed', providerRequestId }),
      checkFailed('twi_provider_calls_completed_has_request_id'),
      `completed without a text request id (${JSON.stringify(String(providerRequestId))}) must be refused`,
    );
  }
  insertProviderCall(db, { attempt: 10, state: 'completed', providerRequestId: 'lyria-request-1' });
  // Only `completed` proves the provider answered with an id. A call the provider certainly
  // billed but returned nothing usable for has none to record.
  insertProviderCall(db, { attempt: 11, state: 'accepted', providerRequestId: null });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 2);
});

test('an abandoned call carries no request id, so a charged row cannot be laundered into one', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  // The state/certainty CHECK constrains ONE ROW'S PAIR. It says nothing about a TRANSITION, so a
  // single UPDATE that moves both columns together turns a completed/charged call into
  // not_charged -- still carrying the request id of the charge it now denies -- and the row stops
  // blocking a retry. The repository refuses that transition in its guarded WHERE clauses, but a
  // console, a script or a migration is outside those. This CHECK is what stands there.
  insertProviderCall(db, { attempt: 0, label: 'A', state: 'completed', providerRequestId: 'req-1' });
  assert.throws(
    () => db.prepare(`
      UPDATE twi_provider_calls SET state = 'abandoned', charge_certainty = 'not_charged'
      WHERE job_id = 'j1' AND attempt = 0 AND label = 'A'
    `).run(),
    checkFailed('twi_provider_calls_abandoned_has_no_request_id'),
  );
  assert.equal(
    db.prepare(`SELECT state, charge_certainty, provider_request_id FROM twi_provider_calls WHERE attempt = 0`).get().state,
    'completed',
    'the laundering UPDATE must leave the row exactly as it was',
  );

  // The same refusal at INSERT time, and the legal shapes beside it: an abandoned row has no id,
  // and an accepted row (certainly charged, nothing usable returned) may have none either.
  assert.throws(
    () => insertProviderCall(db, { attempt: 1, state: 'abandoned', providerRequestId: 'req-2' }),
    checkFailed('twi_provider_calls_abandoned_has_no_request_id'),
  );
  insertProviderCall(db, { attempt: 2, state: 'abandoned', providerRequestId: null });
  insertProviderCall(db, { attempt: 3, state: 'accepted', providerRequestId: 'req-3' });
  // A resolution to abandoned is the one legal way a row reaches not_charged after the fact, and
  // it is only reachable while the charge was UNKNOWN -- which is a state with no request id.
  insertProviderCall(db, { attempt: 4, state: 'ambiguous' });
  db.prepare(`
    UPDATE twi_provider_calls
       SET state = 'abandoned', charge_certainty = 'not_charged', resolved_at = ?, resolution_note = 'the provider never billed it'
     WHERE job_id = 'j1' AND attempt = 4 AND label = 'A'
  `).run(T2);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 4);
});

test('settled_at is present exactly when a provider call has left submitting, and never before it was claimed', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  assert.throws(
    () => insertProviderCall(db, { attempt: 0, state: 'submitting', settledAt: T0 }),
    checkFailed('twi_provider_calls_settled_iff_not_submitting'),
    'a submitting call has not settled',
  );
  for (const [index, state] of ['accepted', 'completed', 'ambiguous', 'abandoned'].entries()) {
    assert.throws(
      () => insertProviderCall(db, { attempt: index + 1, state, settledAt: null }),
      checkFailed('twi_provider_calls_settled_iff_not_submitting'),
      `${state} without settled_at must be refused`,
    );
  }
  assert.throws(
    () => insertProviderCall(db, { attempt: 10, state: 'accepted', claimedAt: T1, settledAt: T0 }),
    checkFailed('twi_provider_calls_settled_not_before_claimed'),
  );
  insertProviderCall(db, { attempt: 11, state: 'accepted', claimedAt: T0, settledAt: T1 });
  insertProviderCall(db, { attempt: 12, state: 'accepted', claimedAt: T1, settledAt: T1 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 2);
});

test('a resolution is a timestamp and a nonblank note together, never one without the other', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  const refused = [
    ['a timestamp with no note', { resolvedAt: T1, resolutionNote: null }],
    ['a note with no timestamp', { resolvedAt: null, resolutionNote: 'refunded by the provider' }],
    ['a whitespace note', { resolvedAt: T1, resolutionNote: '   ' }],
    ['a tab-and-newline note, which SQLite’s one-argument trim() would admit', { resolvedAt: T1, resolutionNote: '\t\n' }],
    ['an empty note', { resolvedAt: T1, resolutionNote: '' }],
    ['a non-text note', { resolvedAt: T1, resolutionNote: Buffer.from('note') }],
  ];
  for (const [index, [why, overrides]] of refused.entries()) {
    assert.throws(
      () => insertProviderCall(db, { attempt: index, state: 'ambiguous', ...overrides }),
      checkFailed('twi_provider_calls_resolution_pair'),
      `${why} must be refused`,
    );
  }
  assert.throws(
    () => insertProviderCall(db, {
      attempt: 20,
      state: 'accepted',
      claimedAt: T1,
      settledAt: T1,
      resolvedAt: T0,
      resolutionNote: 'resolved before it was claimed',
    }),
    checkFailed('twi_provider_calls_resolved_not_before_claimed'),
  );
  insertProviderCall(db, {
    attempt: 21,
    state: 'accepted',
    resolvedAt: T2,
    resolutionNote: 'charge confirmed on the provider invoice',
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 1);
});

test('a provider call is identified by (job_id, attempt, label), and the claim key is unique within a job', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);
  insertJob(db, 'j2', 'j2-key');

  insertProviderCall(db, { attempt: 0, label: 'A' });

  // The same identity with a DIFFERENT payload in every other column still collides: this is
  // the property the claim insert's ON CONFLICT DO NOTHING rests on.
  assert.throws(
    () => insertProviderCall(db, {
      attempt: 0,
      label: 'A',
      claimKey: 'some-other-key',
      state: 'completed',
      providerMode: 'lyria',
      detailJson: '{"attempt":0}',
    }),
    uniqueFailed('twi_provider_calls.job_id', 'twi_provider_calls.attempt', 'twi_provider_calls.label'),
  );
  // Two labels cannot share one claim key inside a job.
  assert.throws(
    () => insertProviderCall(db, { attempt: 0, label: 'B', claimKey: 'j1:0:provider-call:A' }),
    uniqueFailed('twi_provider_calls.job_id', 'twi_provider_calls.claim_key'),
  );
  // Both keys are scoped to the job, not global.
  insertProviderCall(db, { jobId: 'j2', attempt: 0, label: 'A', claimKey: 'j1:0:provider-call:A' });
  insertProviderCall(db, { attempt: 0, label: 'B' });
  insertProviderCall(db, { attempt: 1, label: 'A' });

  // The idempotent claim, exactly as the repository issues it: a second claim of the same
  // identity changes NOTHING and reports zero changes, leaving the first row as it was.
  db.prepare(`UPDATE twi_provider_calls SET state = 'ambiguous', settled_at = ? WHERE job_id = 'j1' AND attempt = 1 AND label = 'A'`).run(T1);
  const replay = db.prepare(`
    INSERT INTO twi_provider_calls
      (job_id, attempt, label, claim_key, state, charge_certainty, provider_mode, detail_json, claimed_at)
    VALUES ('j1', 1, 'A', 'j1:1:provider-call:A', 'submitting', 'unknown', 'fake', '{}', ?)
    ON CONFLICT(job_id, attempt, label) DO NOTHING
  `).run(T2);
  assert.equal(replay.changes, 0);
  const kept = db.prepare(`SELECT state, claimed_at FROM twi_provider_calls WHERE job_id = 'j1' AND attempt = 1 AND label = 'A'`).get();
  assert.equal(kept.state, 'ambiguous', 'the replayed claim must not reset the state');
  assert.equal(kept.claimed_at, T0, 'the replayed claim must not touch the original claim time');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 4);
});

test('provider-call attempt is a stored nonnegative integer and label is exactly A or B', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  // SQLite would store the string '0' in an INTEGER column with type affinity converting it,
  // but '0.5', 'x' and a blob would land as-is. The typeof clause refuses every non-integer.
  for (const attempt of [-1, 0.5, 'x', Buffer.from('0')]) {
    assert.throws(
      () => insertProviderCall(db, { attempt }),
      checkFailed('twi_provider_calls_attempt_integer'),
      `attempt ${JSON.stringify(String(attempt))} must be refused`,
    );
  }
  for (const label of ['C', 'a', 'AB', '']) {
    assert.throws(
      () => insertProviderCall(db, { attempt: 0, label }),
      checkFailed('twi_provider_calls_label_enum'),
      `label ${JSON.stringify(label)} must be refused`,
    );
  }
  insertProviderCall(db, { attempt: 0, label: 'A' });
  insertProviderCall(db, { attempt: 0, label: 'B' });
  insertProviderCall(db, { attempt: 7, label: 'A' });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 3);
});

test('provider-call timestamps require the fixed-width ISO shape, hour 24 included', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  const rejected = ['2026-08-16 00:00:00', '2026-08-16T00:00:00Z', '2026-08-16T24:30:00.000Z', ''];
  for (const [index, value] of rejected.entries()) {
    assert.throws(
      () => insertProviderCall(db, { attempt: index, claimedAt: value }),
      checkFailed('twi_provider_calls_claimed_at_iso'),
      `claimed_at ${JSON.stringify(value)} must be rejected`,
    );
    assert.throws(
      () => insertProviderCall(db, { attempt: index, state: 'accepted', settledAt: value }),
      checkFailed('twi_provider_calls_settled_at_iso'),
      `settled_at ${JSON.stringify(value)} must be rejected`,
    );
    assert.throws(
      () => insertProviderCall(db, { attempt: index, state: 'accepted', resolvedAt: value, resolutionNote: 'note' }),
      checkFailed('twi_provider_calls_resolved_at_iso'),
      `resolved_at ${JSON.stringify(value)} must be rejected`,
    );
  }
  assert.throws(
    () => insertProviderCall(db, { attempt: 50, claimedAt: 20260816 }),
    checkFailed('twi_provider_calls_claimed_at_iso'),
  );
  // 'now' is refused by SQLite before the CHECK can even evaluate — the same stricter kind of
  // rejection the migration 001 timestamp test records. It never reaches the column.
  assert.throws(
    () => insertProviderCall(db, { attempt: 51, claimedAt: 'now' }),
    exactly('non-deterministic use of strftime() in a CHECK constraint'),
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 0);
});

test('provider-call identity text, provider mode and detail are guarded like the rest of the schema', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  assert.throws(() => insertProviderCall(db, { claimKey: '' }), checkFailed('twi_provider_calls_claim_key_identity'));
  assert.throws(
    () => insertProviderCall(db, { claimKey: Buffer.from('key') }),
    checkFailed('twi_provider_calls_claim_key_identity'),
  );
  assert.throws(() => insertProviderCall(db, { providerMode: '' }), checkFailed('twi_provider_calls_provider_mode_identity'));
  assert.throws(
    () => insertProviderCall(db, { providerMode: null }),
    notNullFailed('twi_provider_calls.provider_mode'),
  );
  for (const detailJson of ['[]', 'null', '"text"', '12', 'not json']) {
    assert.throws(
      () => insertProviderCall(db, { detailJson }),
      checkFailed('twi_provider_calls_detail_json_object'),
      `detail_json ${detailJson} must be refused`,
    );
  }
  insertProviderCall(db, { detailJson: '{"schemaVersion":1}' });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 1);
});

test('provider calls belong to their job: an unknown job is refused and deletion cascades', (t) => {
  const db = freshDb(t);
  seedJobForProviderCalls(db);

  assert.throws(() => insertProviderCall(db, { jobId: 'no-such-job' }), foreignKeyFailed);
  insertProviderCall(db, { attempt: 0, label: 'A' });
  insertProviderCall(db, { attempt: 0, label: 'B', state: 'completed' });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 2);

  db.prepare(`DELETE FROM twi_jobs WHERE id = 'j1'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM twi_provider_calls`).get().n, 0);
});

test('the partial index carries exactly the predicate the inventory query spells', (t) => {
  const db = freshDb(t);
  // The PLAN is not enough on its own. WIDENING the index's predicate (say to `WHERE resolved_at
  // IS NULL`) leaves both plans naming this index and both suites green -- SQLite only requires
  // the index's predicate to be IMPLIED BY the query's -- while the index stops being the exact
  // reconciliation inventory it is documented as, and every unresolved not_charged row starts
  // riding it. Narrowing it costs the read its index and IS caught by the plan test below. So the
  // exact text is pinned from the engine's own catalogue, in one place, beside the query it mirrors.
  const sql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_twi_provider_calls_unresolved'`)
    .get().sql;
  assert.equal(
    sql.replace(/\s+/g, ' ').trim(),
    'CREATE INDEX idx_twi_provider_calls_unresolved ON twi_provider_calls(job_id, attempt, label) '
      + "WHERE charge_certainty <> 'not_charged' AND resolved_at IS NULL",
  );
  // The named per-job index has no predicate at all: it must serve every read of one job's calls,
  // including the ones a future reconciliation route makes over resolved rows.
  const byJobSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_twi_provider_calls_job'`)
    .get().sql;
  assert.doesNotMatch(byJobSql, /WHERE/i, byJobSql);
});

test('the provider-call reads use their indexes instead of scanning the table', (t) => {
  const db = freshDb(t);
  const planFor = (sql, ...bindings) =>
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map((row) => row.detail).join(' | ');

  // The retry gate: every call of one job, in (attempt, label) order. The primary key's
  // automatic index could serve this too, but it has no stable name to pin — so the named
  // index is created beside it and the planner is shown preferring it.
  const byJob = planFor(`SELECT * FROM twi_provider_calls WHERE job_id = ? ORDER BY attempt, label`, 'j');
  assert.match(byJob, /USING (COVERING )?INDEX idx_twi_provider_calls_job/, byJob);
  assert.doesNotMatch(byJob, /\bSCAN twi_/, byJob);
  assert.doesNotMatch(byJob, /USE TEMP B-TREE FOR ORDER BY/, byJob);

  // The reconciliation inventory: an estate-wide count over the PARTIAL index. A "SCAN" of that
  // index is the intended access path — it holds only the unreconciled rows — so the assertion
  // is that the partial index is what gets scanned, never the table.
  const unresolved = planFor(
    `SELECT COUNT(*) AS total FROM twi_provider_calls WHERE charge_certainty <> 'not_charged' AND resolved_at IS NULL`,
  );
  assert.match(unresolved, /USING (COVERING )?INDEX idx_twi_provider_calls_unresolved/, unresolved);
  assert.doesNotMatch(unresolved, /\bSCAN twi_provider_calls\s*$/, unresolved);
  assert.doesNotMatch(unresolved, /\bSCAN twi_provider_calls \|/, unresolved);

  // The same predicate narrowed to one job rides the same partial index.
  const blocking = planFor(
    `SELECT attempt, label, state FROM twi_provider_calls WHERE job_id = ? AND charge_certainty <> 'not_charged' AND resolved_at IS NULL`,
    'j',
  );
  assert.match(blocking, /SEARCH twi_provider_calls USING (COVERING )?INDEX idx_twi_provider_calls_unresolved/, blocking);
});
