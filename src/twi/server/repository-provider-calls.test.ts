// @vitest-environment node
/// <reference types="node" />
//
// The provider-call ledger against a real `node:sqlite` database loading BOTH migrations, with
// deterministic race injection.
//
// Split out of `repository-sqlite.test.ts` at this project's 800-line ceiling (that file went 654
// -> 970 when this section landed), the same way `jobs-concurrency.test.ts` was split off
// `jobs.test.ts`. The subject is one thing: what the DATABASE says about the money after each
// ledger write. Statement shape is asserted in the same file, against the recording double,
// because binding order is the other half of the same question and neither half is behaviour the
// other can see.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isUnreconciledProviderCall } from './provider-call-types';
import { D1TwiRepository, TwiRepositoryValidationError } from './repository';
import { normalized } from './repository.fixtures';
import { ScriptedD1, SqliteD1, changed, seedProjectSpecJob } from './repository.harness';

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

  /*
   * The `resolved_at IS NULL` half of the resolution's WHERE clause. Its sibling `state = ?` is
   * covered by the test above, and that sibling hides this one from every scenario where the rival
   * resolution CHANGED the state -- the guarded UPDATE then fails on the state and the row survives
   * for the wrong reason. Dropping this conjunct was invisible to the whole suite until this case
   * existed, so the rival here resolves a row whose charge is already KNOWN: `to` must be omitted,
   * the state stays `accepted`, and `resolved_at IS NULL` is the only term left standing between a
   * second resolution and an overwritten audit note.
   */
  it('will not overwrite a resolution that landed between the read and the write, even in the same state', async () => {
    await claim();
    await repository.settleProviderCall({ ...identity(), state: 'accepted', now: SETTLED_AT });

    const rivalAt = '2026-08-16T08:00:00.000Z';
    db.beforeNextStandaloneRun = () => {
      db.exec(
        `UPDATE twi_provider_calls
           SET resolved_at = ?, resolution_note = 'the invoice shows this charge'
         WHERE job_id = 'job-1' AND attempt = 0 AND label = 'A'`,
        rivalAt,
      );
    };

    const mine = await repository.resolveProviderCall({
      ...identity(),
      note: 'my own reading of the invoice',
      now: RESOLVED_AT,
    });

    expect(mine.outcome).toBe('already-resolved');
    expect(mine.call).toMatchObject({ resolvedAt: rivalAt, resolutionNote: 'the invoice shows this charge' });
    // Neither the timestamp nor the note moved, and the state is untouched.
    expect(row()).toMatchObject({
      state: 'accepted',
      charge_certainty: 'charged',
      resolved_at: rivalAt,
      resolution_note: 'the invoice shows this charge',
    });
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

// ── Statement shape (the recording double) ─────────────────────────────
//
// Moved here out of `repository.test.ts` (730 -> 833 lines, over the 800-line ceiling) with their
// bodies untouched. The double records SQL and bindings and returns scripted results, which is the
// only way to assert that `charge_certainty` is BOUND from the one map rather than written into the
// SQL, and that the settlement's WHERE clause still carries `state = 'submitting'`.
describe('D1TwiRepository provider-call statement shape', () => {
  let db: ScriptedD1;
  let repository: D1TwiRepository;

  beforeEach(() => {
    db = new ScriptedD1();
    repository = new D1TwiRepository({ DB: db });
  });

  it('claims a provider call with ON CONFLICT DO NOTHING on its identity, binding state and certainty from the one map', async () => {
    db.runResults.push(changed(1));
    const claimed = await repository.claimProviderCall({
      jobId: 'job-1',
      attempt: 2,
      label: 'B',
      providerMode: 'lyria',
      now: '2026-08-16T04:00:00.000Z',
      detailJson: '{"z":1,"a":2}',
    });
    expect(claimed.outcome).toBe('claimed');
    expect(claimed.call).toMatchObject({ claimKey: 'job-1:2:provider-call:B', state: 'submitting', chargeCertainty: 'unknown' });

    expect(db.statements).toHaveLength(1);
    const [insert] = db.statements;
    expect(normalized(insert!.sql)).toContain('INSERT INTO twi_provider_calls');
    expect(normalized(insert!.sql)).toContain('ON CONFLICT(job_id, attempt, label) DO NOTHING');
    // The detail is canonicalised, and the state/certainty pair is bound rather than hardcoded in SQL.
    expect(insert!.bindings).toEqual([
      'job-1',
      2,
      'B',
      'job-1:2:provider-call:B',
      'submitting',
      'unknown',
      'lyria',
      '{"a":2,"z":1}',
      '2026-08-16T04:00:00.000Z',
    ]);
    expect(db.drained()).toBe(true);
  });

  it('settles through a guarded UPDATE that matches only a submitting row', async () => {
    db.runResults.push(changed(1));
    db.firstResults.push({
      job_id: 'job-1',
      attempt: 0,
      label: 'A',
      claim_key: 'job-1:0:provider-call:A',
      state: 'completed',
      charge_certainty: 'charged',
      provider_mode: 'lyria',
      provider: 'lyria',
      model: 'lyria-3-pro-preview',
      provider_request_id: 'req-1',
      detail_json: '{}',
      claimed_at: '2026-08-16T04:00:00.000Z',
      settled_at: '2026-08-16T04:00:09.000Z',
      resolved_at: null,
      resolution_note: null,
    });
    const settled = await repository.settleProviderCall({
      jobId: 'job-1',
      attempt: 0,
      label: 'A',
      state: 'completed',
      providerRequestId: 'req-1',
      provider: 'lyria',
      model: 'lyria-3-pro-preview',
      now: '2026-08-16T04:00:09.000Z',
    });
    expect(settled.outcome).toBe('settled');
    expect(settled.call).toMatchObject({ state: 'completed', chargeCertainty: 'charged', providerRequestId: 'req-1' });

    const [update, readback] = db.statements;
    expect(normalized(update!.sql)).toMatch(/WHERE job_id = \? AND attempt = \? AND label = \? AND state = 'submitting'$/);
    expect(update!.bindings).toEqual([
      'completed',
      'charged',
      'req-1',
      'lyria',
      'lyria-3-pro-preview',
      null,
      '2026-08-16T04:00:09.000Z',
      'job-1',
      0,
      'A',
    ]);
    expect(normalized(readback!.sql)).toContain('FROM twi_provider_calls WHERE job_id = ? AND attempt = ? AND label = ?');
    expect(db.drained()).toBe(true);
  });

  it('refuses malformed provider-call inputs before anything is bound', async () => {
    const now = '2026-08-16T04:00:00.000Z';
    const base = { jobId: 'job-1', attempt: 0, label: 'A' as const };
    const refused: Array<Promise<unknown>> = [
      repository.claimProviderCall({ ...base, attempt: -1, providerMode: 'fake', now }),
      repository.claimProviderCall({ ...base, attempt: 1.5, providerMode: 'fake', now }),
      repository.claimProviderCall({ ...base, label: 'C' as unknown as 'A', providerMode: 'fake', now }),
      repository.claimProviderCall({ ...base, providerMode: '  ', now }),
      repository.claimProviderCall({ ...base, providerMode: 'fake', now: '2026-08-16 04:00:00' }),
      repository.claimProviderCall({ ...base, providerMode: 'fake', now, detailJson: '[]' }),
      repository.settleProviderCall({ ...base, state: 'submitting' as unknown as 'ambiguous', now }),
      repository.settleProviderCall({ ...base, state: 'completed', now }),
      repository.settleProviderCall({ ...base, state: 'accepted', provider: '', now }),
      repository.resolveProviderCall({ ...base, note: ' ', now }),
      repository.resolveProviderCall({ ...base, to: 'completed' as unknown as 'accepted', note: 'n', now }),
      repository.listProviderCalls(''),
    ];
    for (const call of refused) await expect(call).rejects.toBeInstanceOf(TwiRepositoryValidationError);
    expect(db.statements).toHaveLength(0);
  });
});
