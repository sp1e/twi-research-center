// @vitest-environment node
/// <reference types="node" />
//
// TWO SUBMITS AT ONCE — the money guarantee the rest of the suite is structurally blind to.
//
// Every other test of this route is single-writer, and that is exactly why the suite could not
// see either defect this file covers. Both follow from two requests holding the SAME idempotency
// key and DIFFERENT freshly-minted ids: `estimatedJobMatchesInput` (validation.ts) requires
// `job.id === input.id` AND `job.specId === input.specId`, and `submitJob` mints both per
// request, so the repository's own reconciliation can never match a concurrent sibling. The loser
// raised a `TwiRepositoryCollisionError`, which is not an `HttpError`, so it reached the route's
// catch as 500 `internal_error` — and `outcome === 'replayed'`, the branch the module header
// calls contract 3, was therefore UNREACHABLE in production. Its only test SUPPLIED the outcome
// through a `repoWith` override, which is precisely what hid the defect, so nothing here fakes
// one.
//
// One real repository, one real SQLite loading the actual migration, both calls started
// together. The only injected behaviour is a BARRIER on the replay lookup: it runs the REAL
// lookup and then holds until every racing caller has also missed. Two requests started together
// do overlap, but WHERE they overlap depends on how many ticks each spends in `parseJson`, the
// digest and the reference check — the race needs both past the lookup before either insert, so
// the barrier makes the real condition reproducible instead of hoping the scheduler supplies it.
// Same instrument and same reasoning as `asset-ingestion.test.ts`.
//
// It lives in its own file rather than at the end of `jobs.test.ts` because that file reached the
// 800-line ceiling, and because "two writers at once" is one subject.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draft } from '../domain/spec.fixture';

import { HttpError } from './http';
import { submitJob, type JobDeps } from './jobs';
import { OWNER_PROJECT_ID, jobsWorld, jsonRequest, readJson, repoWith, type JobsWorld } from './jobs.harness';
import type { JobRecord } from './repository-types';

const IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222';
const SUBMIT_URL = 'https://sp1e.se/api/twi/jobs';

let world: JobsWorld;

const deps = (overrides: Partial<JobDeps> = {}): JobDeps => ({
  repo: world.repo,
  orchestrator: world.orchestrator,
  clock: world.clock,
  ...overrides,
});

const submit = (overrides: Record<string, unknown> = {}, extra: Partial<JobDeps> = {}): Promise<Response> =>
  submitJob(
    jsonRequest(SUBMIT_URL, { projectId: OWNER_PROJECT_ID, idempotencyKey: IDEMPOTENCY_KEY, spec: draft, ...overrides }),
    deps(extra),
  );

interface SubmitBody {
  job: JobRecord;
  outcome: string;
  transition: string | null;
}

const rejection = async (call: Promise<Response>): Promise<HttpError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with an HttpError');
};

beforeEach(async () => {
  world = await jobsWorld();
});

afterEach(() => {
  world.close();
  vi.restoreAllMocks();
});

describe('POST /api/twi/jobs — two genuinely concurrent submits of one idempotency key', () => {
  /** Holds every arriving caller until `parties` have arrived, then opens permanently. */
  const barrier = (parties: number) => {
    let arrived = 0;
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return async (): Promise<void> => {
      arrived += 1;
      if (arrived >= parties) open();
      await gate;
    };
  };

  /** The REAL replay lookup, delayed until every racing request has also missed. */
  const racingRepo = (parties = 2) => {
    const bothPastTheLookup = barrier(parties);
    let misses = 0;
    const repo = repoWith(world.repo, {
      findJobByIdempotencyKey: async (input) => {
        const row = await world.repo.findJobByIdempotencyKey(input);
        if (row === null) misses += 1;
        await bothPastTheLookup();
        return row;
      },
    });
    return { repo, missed: () => misses };
  };

  /**
   * The test's OWN count of orphaned specs, kept as an independent oracle.
   *
   * `repo.countOrphanedSpecs()` is the production inventory and asks the same question, but a
   * test that only ever compares a query against itself cannot detect that query being wrong.
   * So both are asserted, and they are asserted to AGREE: this one is a deliberately naive
   * `NOT IN`, the production one a `NOT EXISTS` over the composite `(project_id, spec_id)` key.
   * On the fixtures here the two must give the same answer, and `counts a REAL orphan` below
   * drives them both against a row that genuinely exists.
   */
  const orphanSpecs = (): number =>
    world.db.value<number>(
      'SELECT COUNT(*) FROM twi_generation_specs WHERE id NOT IN (SELECT spec_id FROM twi_jobs)',
    );

  it('answers the loser with a REPLAY of the winner, not a 500 — one job, one charge, one start', async () => {
    const { repo, missed } = racingRepo();

    const settled = await Promise.allSettled([submit({}, { repo }), submit({}, { repo })]);

    // Both really reached the insert with the same key and neither saw the other's row —
    // otherwise this test would be asserting something else entirely.
    expect(missed()).toBe(2);
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const responses = settled.map((result) => (result as PromiseFulfilledResult<Response>).value);
    const bodies = await Promise.all(responses.map((response) => readJson<SubmitBody>(response)));

    // Which request wins is the scheduler's business, so nothing here depends on it.
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(bodies.map((body) => body.outcome).sort()).toEqual(['created', 'replayed']);
    // Both answers describe ONE job, which is the whole guarantee.
    expect(bodies[0]?.job.id).toBe(bodies[1]?.job.id);

    expect(world.jobCount()).toBe(1);
    expect(world.costCount()).toBe(1);
    expect(world.costCategories()).toEqual(['estimate']);
    expect(world.orchestrator.starts).toBe(1);
  });

  it('leaves no orphan specification row behind — the loser reaps the copy of the lyrics it wrote', async () => {
    const { repo, missed } = racingRepo();

    await Promise.allSettled([submit({}, { repo }), submit({}, { repo })]);

    // The race instrument, asserted here too. Without it this test passes just as happily on
    // the ORDINARY SEQUENTIAL replay path — the winner commits, the loser FINDS the row and
    // never writes a spec at all — so `specCount() === 1` would hold for a reason that has
    // nothing to do with the compensation this test is named after. Two misses is what makes
    // it a race, and a race is the only condition under which a spec row is orphaned.
    expect(missed()).toBe(2);

    // `saveSpec` runs BEFORE the insert that establishes uniqueness, because
    // twi_jobs(project_id, spec_id) is a FOREIGN KEY into twi_generation_specs and the
    // row has to exist first. Measured before the compensation: specs = 2, jobs = 1 — a
    // full copy of the owner's lyrics in a row no code path would ever read again.
    expect(world.specCount()).toBe(1);
    expect(orphanSpecs()).toBe(0);
    // The production inventory agrees with the test's own oracle, and both are executed.
    expect(await world.repo.countOrphanedSpecs()).toBe(0);
  });

  it('refuses the loser 409 when the two racing submits carry DIFFERENT specs, and still reaps its spec row', async () => {
    const { repo, missed } = racingRepo();

    const settled = await Promise.allSettled([
      submit({}, { repo }),
      submit({ spec: { ...draft, sound: { ...draft.sound, novelty: 3 } } }, { repo }),
    ]);

    // As above, and it discriminates more here than anywhere: the SEQUENTIAL different-spec
    // path also answers 409 `idempotency_key_reused`, from `findReplayableJob` at the top of
    // `submitJob` rather than from `replayLostRace` after a lost insert. Both give this test
    // the status and the code it asserts, so without this line it cannot tell which of the two
    // code paths it exercised — and only one of them is the concurrent one it exists for.
    expect(missed()).toBe(2);

    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<Response>).value.status).toBe(201);
    // The key WAS reused for a materially different specification, so this is the caller's
    // mistake and not a server fault — the same 409 the sequential path already gives.
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: 'idempotency_key_reused',
    });

    expect(world.jobCount()).toBe(1);
    expect(world.costCount()).toBe(1);
    expect(world.orchestrator.starts).toBe(1);
    expect(world.specCount()).toBe(1);
    expect(orphanSpecs()).toBe(0);
    // The production inventory agrees with the test's own oracle, and both are executed.
    expect(await world.repo.countOrphanedSpecs()).toBe(0);
  });

  it('never removes a specification row a job DOES reference, even asked directly', async () => {
    // The retention rule for this feature is that nothing a retained revision, job, export or
    // profile references may be collected. The compensation is therefore written so it CANNOT
    // collect a referenced row — the guard is in the SQL, not in the caller's diligence — and
    // this drives it the only way that proves it: by asking it to.
    const body = await readJson<SubmitBody>(await submit());

    const removed = await world.repo.discardUnreferencedSpec({ projectId: OWNER_PROJECT_ID, id: body.job.specId });

    expect(removed).toBe(false);
    expect(world.specCount()).toBe(1);
    expect((await world.job(body.job.id))?.specId).toBe(body.job.specId);
  });

  it('reaps the specification row when the stored digest disagrees, rather than leaving the lyrics behind', async () => {
    // The insert is REAL here — only the returned digest is the injected fault — so the
    // row genuinely exists to be reaped. The sibling test above (`refuses to continue if
    // the stored digest disagrees`) fabricates the record without inserting, so it cannot
    // see this at all.
    const lying = repoWith(world.repo, {
      saveSpec: async (input) => ({ ...(await world.repo.saveSpec(input)), specSha256: 'f'.repeat(64) }),
    });

    const failure = await rejection(submit({}, { repo: lying }));

    expect(failure.status).toBe(500);
    expect(failure.code).toBe('spec_digest_mismatch');
    expect(world.jobCount()).toBe(0);
    expect(world.specCount()).toBe(0);
    expect(world.orchestrator.starts).toBe(0);
  });

  /**
   * The reap's RESIDUAL, counted rather than described.
   *
   * Every test above asserts the residual is ZERO, and all of them would keep passing against a
   * `countOrphanedSpecs` that returned zero unconditionally — the vacuous pass an absence-shaped
   * assertion always admits. This one produces a REAL orphan and requires the count to see it.
   *
   * The orphan is produced the way a deployed database actually acquires one, not by INSERTing a
   * loose row: the reap is best-effort, so a database that refuses the compensating delete leaves
   * the specification behind. Here the digest-mismatch path runs with a genuine `saveSpec` insert
   * and a `discardUnreferencedSpec` that fails, which is the shape of a D1 outage arriving during
   * the compensation. The submission still reports its own diagnosis rather than the cleanup's —
   * that is the whole reason the failure is swallowed — and the row that survives holds
   * `spec_json`, a full copy of the lyrics the owner typed.
   */
  it('counts a REAL orphan the reap failed to collect, so the residual is a number and not a hope', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outage = repoWith(world.repo, {
      saveSpec: async (input) => ({ ...(await world.repo.saveSpec(input)), specSha256: 'f'.repeat(64) }),
      discardUnreferencedSpec: async () => {
        throw new Error('D1_ERROR: database is unavailable');
      },
    });

    const failure = await rejection(submit({}, { repo: outage }));

    // The caller still gets the reason the submission was refused, not the reason the cleanup was.
    expect(failure.status).toBe(500);
    expect(failure.code).toBe('spec_digest_mismatch');
    expect(world.jobCount()).toBe(0);

    // And the row is still there, which is the residual this test exists to measure.
    expect(world.specCount()).toBe(1);
    expect(orphanSpecs()).toBe(1);
    expect(await world.repo.countOrphanedSpecs()).toBe(1);

    // Best-effort, but never silent: the swallow logs, so an operator has something to correlate
    // the counted residual against.
    expect(logged).toHaveBeenCalledWith(
      '[twi] orphaned generation spec after a refused submission',
      expect.objectContaining({ error: 'Error' }),
    );
  });

  /**
   * The inventory refuses to count a row a job DOES reference — the exact complement of
   * `never removes a specification row a job DOES reference`. Both halves of the pair are needed:
   * a count that saw every spec as an orphan would also pass the `toBe(1)` above on a tree with
   * one spec, and would then report a healthy production database as entirely orphaned.
   */
  it('does not count a specification row a job references, so the inventory cannot cry wolf', async () => {
    await submit();

    expect(world.specCount()).toBe(1);
    expect(await world.repo.countOrphanedSpecs()).toBe(0);
  });
});
