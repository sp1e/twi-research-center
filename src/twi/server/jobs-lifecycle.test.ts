// @vitest-environment node
/// <reference types="node" />
//
// Polling, cancel and retry — the three routes that act on a job that already cost
// money, so the thing each of them must NOT do is create a second charge.
//
// The retry cases carry the fact the brief singles out: `transitionJob`'s `eventKey`
// must include the attempt ordinal. `${jobId}:${to}` collides on the first retry loop
// and the second call is a silent no-op REPLAY, not a transition — the job would look
// retried and nothing would have moved. So the ordinal is asserted by value, twice,
// across two consecutive retries, which is the only arrangement in which a missing
// ordinal is visible at all.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canTransition } from '../domain/job-state';
import { draft } from '../domain/spec.fixture';
import type { JobPhase, JobStatus } from '../domain/types';

import { HttpError } from './http';
import { MAX_JOB_PAGE, getJob, listJobs, submitJob, type JobDeps } from './jobs';
import { cancelJob, retryJob } from './jobs-cancel-retry';
import {
  OTHER_PROJECT_ID,
  OWNER_PROJECT_ID,
  UNKNOWN_JOB_ID,
  jobsWorld,
  jsonRequest,
  readJson,
  repoWith,
  type JobsWorld,
} from './jobs.harness';
import { JOB_STATUSES, type JobRecord } from './repository-types';

const FIRST_KEY = '22222222-2222-4222-8222-222222222222';
const SECOND_KEY = '66666666-6666-4666-8666-666666666666';
const SUBMIT_URL = 'https://sp1e.se/api/twi/jobs';

let world: JobsWorld;

const deps = (overrides: Partial<JobDeps> = {}): JobDeps => ({
  repo: world.repo,
  orchestrator: world.orchestrator,
  clock: world.clock,
  ...overrides,
});

interface JobBody {
  job: JobRecord;
  transition?: string;
  attempt?: number;
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

/** A submitted, dispatched, `queued` job. */
const queuedJob = async (idempotencyKey = FIRST_KEY, projectId = OWNER_PROJECT_ID): Promise<JobRecord> => {
  const response = await submitJob(jsonRequest(SUBMIT_URL, { projectId, idempotencyKey, spec: draft }), deps());
  return (await readJson<JobBody>(response)).job;
};

/** A job in `error`, reached the way production reaches it: a refused dispatch. */
const failedJob = async (idempotencyKey = FIRST_KEY): Promise<JobRecord> => {
  world.orchestrator.status = 503;
  const response = await submitJob(
    jsonRequest(SUBMIT_URL, { projectId: OWNER_PROJECT_ID, idempotencyKey, spec: draft }),
    deps(),
  );
  world.orchestrator.status = 202;
  world.orchestrator.calls.length = 0;
  return (await readJson<JobBody>(response)).job;
};

beforeEach(async () => {
  world = await jobsWorld();
});

afterEach(() => {
  world.close();
  vi.restoreAllMocks();
});

// ── Polling ──────────────────────────────────────────────────────────────────

describe('GET /api/twi/jobs/:id', () => {
  it('returns the job, including the estimate it was submitted against', async () => {
    const job = await queuedJob();

    const body = await readJson<JobBody>(await getJob(job.id, world.repo));

    expect(body.job.id).toBe(job.id);
    expect(body.job.status).toBe('queued');
    expect(body.job.estimate).toMatchObject({ currency: 'USD' });
  });

  it('answers 404 for an unknown id rather than an empty envelope', async () => {
    expect((await rejection(getJob(UNKNOWN_JOB_ID, world.repo))).status).toBe(404);
  });

  it('answers 404 for a blank id rather than surfacing the repository assertion as a 500', async () => {
    expect((await rejection(getJob('   ', world.repo))).status).toBe(404);
  });
});

describe('GET /api/twi/jobs', () => {
  it('lists the owner’s jobs, newest first', async () => {
    const first = await queuedJob(FIRST_KEY);
    const second = await queuedJob(SECOND_KEY);

    const body = await readJson<{ jobs: JobRecord[] }>(await listJobs(new Request(SUBMIT_URL), world.repo));

    expect(body.jobs.map((job) => job.id)).toEqual([second.id, first.id]);
  });

  it('filters to one project when asked', async () => {
    const mine = await queuedJob(FIRST_KEY);
    await queuedJob(SECOND_KEY, OTHER_PROJECT_ID);

    const body = await readJson<{ jobs: JobRecord[] }>(
      await listJobs(new Request(`${SUBMIT_URL}?projectId=${OWNER_PROJECT_ID}`), world.repo),
    );

    expect(body.jobs.map((job) => job.id)).toEqual([mine.id]);
  });

  it('treats a whitespace-only projectId as no filter at all, rather than as a 500', async () => {
    // Without the `trim()` in `listJobs`, `?projectId=%20` is a non-empty string that
    // reaches `assertNullableNonBlank` inside the repository and surfaces as an
    // `internal_error`. Nothing ever drove a whitespace-only parameter, so removing the trim
    // was indistinguishable — the same single-input shape as the other survivors.
    const mine = await queuedJob(FIRST_KEY);

    const response = await listJobs(new Request(`${SUBMIT_URL}?projectId=%20`), world.repo);

    expect(response.status).toBe(200);
    expect((await readJson<{ jobs: JobRecord[] }>(response)).jobs.map((job) => job.id)).toEqual([mine.id]);
  });

  it('answers an empty list for a project with no jobs, not a 404 — and names the page bound', async () => {
    const response = await listJobs(new Request(`${SUBMIT_URL}?projectId=${OTHER_PROJECT_ID}`), world.repo);

    expect(response.status).toBe(200);
    // The bound is STATED, not applied silently: there is no cursor yet, so a caller has to
    // be able to tell "the first MAX_JOB_PAGE" from "all of them".
    expect(await readJson<unknown>(response)).toEqual({ jobs: [], limit: MAX_JOB_PAGE, mayHaveMore: false });
  });

  it('truncates at MAX_JOB_PAGE and SAYS so, and the hidden job is still reachable by id', async () => {
    // MAX_JOB_PAGE + 1 real submissions through the real route, because the fact under test
    // is what happens ON the bound and a shorter list cannot reach it. This is also the only
    // place the cap is proven end to end rather than as "the route asked for 50".
    const submitted: JobRecord[] = [];
    for (let index = 0; index <= MAX_JOB_PAGE; index += 1) {
      submitted.push(await queuedJob(`22222222-2222-4222-8222-${index.toString().padStart(12, '0')}`));
    }

    const body = await readJson<{ jobs: JobRecord[]; limit: number; mayHaveMore: boolean }>(
      await listJobs(new Request(SUBMIT_URL), world.repo),
    );

    expect(world.jobCount()).toBe(MAX_JOB_PAGE + 1);
    expect(body.jobs).toHaveLength(MAX_JOB_PAGE);
    expect(body.limit).toBe(MAX_JOB_PAGE);
    expect(body.mayHaveMore).toBe(true);

    // The oldest submission is off the page — and answered individually, so the history is
    // truncated in the VIEW only. There is no cursor yet; see `listJobs`.
    const oldest = submitted[0] as JobRecord;
    expect(body.jobs.map((job) => job.id)).not.toContain(oldest.id);
    expect((await readJson<JobBody>(await getJob(oldest.id, world.repo))).job.id).toBe(oldest.id);
  });

  // The page bound had NO discriminating test: raising it to Number.MAX_SAFE_INTEGER
  // left the whole suite green, because three jobs fit under either limit. Two
  // assertions rather than one, because the bound has two halves that fail apart:
  // the route must ask for MAX_JOB_PAGE, and the repository must honour what it is
  // asked. A test for only the first passes over a repository that ignores `limit`.
  it('asks the repository for exactly MAX_JOB_PAGE, never a caller-supplied bound', async () => {
    const asked: number[] = [];
    const watched = repoWith(world.repo, {
      listJobs: async (input) => {
        asked.push(input.limit);
        return world.repo.listJobs(input);
      },
    });

    await listJobs(new Request(`${SUBMIT_URL}?projectId=${OWNER_PROJECT_ID}&limit=100000`), watched);

    expect(asked).toEqual([MAX_JOB_PAGE]);
    expect(MAX_JOB_PAGE).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('is bounded by that limit in the repository itself, not merely by how few rows exist', async () => {
    await queuedJob(FIRST_KEY);
    await queuedJob(SECOND_KEY);
    await queuedJob('44444444-4444-4444-8444-999999999999');

    const page = await world.repo.listJobs({ projectId: null, limit: 2 });

    expect(page).toHaveLength(2);
    expect(world.jobCount()).toBe(3);
  });
});

// ── Cancel ───────────────────────────────────────────────────────────────────

describe('POST /api/twi/jobs/:id/cancel', () => {
  it('asks the orchestrator to stop, then moves the job to cancelling', async () => {
    const job = await queuedJob();
    world.orchestrator.calls.length = 0;

    const body = await readJson<JobBody>(await cancelJob(job.id, deps()));

    expect(world.orchestrator.cancels).toBe(1);
    expect(world.orchestrator.call().url).toBe(`https://twi.internal/cancel/${job.id}`);
    expect(body.job.status).toBe('cancelling');
    expect(body.transition).toBe('applied');
    expect((await world.job(job.id))?.status).toBe('cancelling');
  });

  it('records the cancel as its own event, keyed by the attempt ordinal', async () => {
    const job = await queuedJob();
    await cancelJob(job.id, deps());

    expect(world.eventKeys()).toEqual([
      `${job.id}:0:estimated`,
      `${job.id}:0:queued`,
      `${job.id}:0:cancelling`,
    ]);
  });

  // A cancel from EVERY legal state, not just the one the submit path leaves behind.
  //
  // Before these, `queued` was the only status ever cancelled in a test, so the guard
  // was pinned at exactly one of its four admitted inputs. That is the shape of hole
  // that let Task 6's idempotency gap survive a green suite: the branch was correct
  // and nothing drove the other cases through it. `canTransition` is the authority
  // here, so the expectation is READ OFF the domain rather than transcribed — a
  // transcribed list would have to be edited to keep agreeing with a domain change,
  // which is how the two drift apart silently.
  const CANCELLABLE: readonly JobStatus[] = ['queued', 'generating', 'ingesting', 'finishing'];

  /** Walks a real job forward through the state machine, one legal edge at a time. */
  const advanceTo = async (job: JobRecord, target: JobStatus): Promise<void> => {
    // Typed as phases, not statuses: `phase` excludes `draft` and `estimated`, and the
    // repository would reject either. Naming the narrower type here is what makes that
    // a compile error rather than a runtime refusal.
    const chain: readonly JobPhase[] = ['generating', 'ingesting', 'finishing', 'validating'];
    let from: JobStatus = 'queued';
    for (const to of chain) {
      if (from === target) return;
      await world.repo.transitionJob(job.id, to, {
        fromStatus: from,
        phase: to,
        retryCheckpoint: null,
        now: world.clock.now(),
        eventKey: `${job.id}:0:${to}`,
        detailJson: JSON.stringify({ schemaVersion: 1, attempt: 0 }),
      });
      from = to;
    }
  };

  it('agrees with the domain about which states are cancellable', () => {
    const modelled = JOB_STATUSES.filter((status) => canTransition(status, 'cancelling'));

    expect([...modelled].sort()).toEqual([...CANCELLABLE].sort());
  });

  it.each(CANCELLABLE.map((status) => [status]))(
    'cancels a job in %s: one stop request, and the job moves to cancelling',
    async (status) => {
      const job = await queuedJob();
      await advanceTo(job, status);
      expect((await world.job(job.id))?.status).toBe(status);
      world.orchestrator.calls.length = 0;

      const body = await readJson<JobBody>(await cancelJob(job.id, deps()));

      expect(world.orchestrator.cancels).toBe(1);
      expect(body.job.status).toBe('cancelling');
      expect(body.transition).toBe('applied');
      // The precondition is the status it was ACTUALLY in — a hardcoded `queued`
      // would fail the optimistic-concurrency match for the three later states.
      expect((await world.job(job.id))?.status).toBe('cancelling');
      // No cancel may create a charge. The estimate row is the only one that exists.
      expect(world.costCount()).toBe(1);
      expect(world.jobCount()).toBe(1);
    },
  );

  it.each([['validating'], ['cancelling']] as const)(
    'refuses to cancel from %s, which the state machine does not admit, and starts no stop request',
    async (status) => {
      const job = await queuedJob();
      if (status === 'validating') await advanceTo(job, 'validating');
      else await cancelJob(job.id, deps());
      world.orchestrator.calls.length = 0;

      const failure = await rejection(cancelJob(job.id, deps()));

      expect(failure.status).toBe(409);
      expect(failure.code).toBe('cancel_not_allowed');
      expect(world.orchestrator.calls).toEqual([]);
      expect((await world.job(job.id))?.status).toBe(status);
    },
  );

  it('refuses a status the state machine cannot cancel from, and does not call the orchestrator', async () => {
    const job = await failedJob();

    const failure = await rejection(cancelJob(job.id, deps()));

    expect(failure.status).toBe(409);
    expect(failure.code).toBe('cancel_not_allowed');
    expect(world.orchestrator.calls).toEqual([]);
    expect((await world.job(job.id))?.status).toBe('error');
  });

  it('leaves the job alone when the orchestrator cannot be reached — it is still running', async () => {
    const job = await queuedJob();
    world.orchestrator.calls.length = 0;
    world.orchestrator.status = 500;

    const response = await cancelJob(job.id, deps());

    expect(response.status).toBe(502);
    expect((await world.job(job.id))?.status).toBe('queued');
  });

  it('answers 404 for an unknown job', async () => {
    expect((await rejection(cancelJob(UNKNOWN_JOB_ID, deps()))).status).toBe(404);
    expect(world.orchestrator.calls).toEqual([]);
  });
});

// ── Retry ────────────────────────────────────────────────────────────────────

describe('POST /api/twi/jobs/:id/retry', () => {
  it('is allowed only from error', async () => {
    const job = await queuedJob(SECOND_KEY);
    world.orchestrator.calls.length = 0;

    const failure = await rejection(retryJob(job.id, deps()));

    expect(failure.status).toBe(409);
    expect(failure.code).toBe('retry_not_allowed');
    expect(world.orchestrator.starts).toBe(0);
  });

  it('re-queues the failed job without a second spec, job or charge', async () => {
    const job = await failedJob();

    const body = await readJson<JobBody>(await retryJob(job.id, deps()));

    expect(body.job.status).toBe('queued');
    expect(body.attempt).toBe(1);
    expect(world.orchestrator.starts).toBe(1);
    // The whole point: the frozen spec and the paid estimate are REUSED.
    expect(world.jobCount()).toBe(1);
    expect(world.specCount()).toBe(1);
    expect(world.costCount()).toBe(1);
    expect(body.job.specId).toBe(job.specId);
    expect(body.job.idempotencyKey).toBe(job.idempotencyKey);
    expect(body.job.specSha256).toBe(job.specSha256);
  });

  it('clears the error metadata and the checkpoint once the work is resumed', async () => {
    const job = await failedJob();

    await retryJob(job.id, deps());
    const stored = await world.job(job.id);

    expect(stored?.errorCode).toBeNull();
    expect(stored?.errorMessage).toBeNull();
    expect(stored?.retryCheckpoint).toBeNull();
  });

  it('advances the attempt ordinal across TWO retries, so the second is not a silent replay', async () => {
    const job = await failedJob();

    // Retry once against an unavailable orchestrator: the job returns to `error`, which
    // is the only way production reaches a SECOND retry.
    world.orchestrator.status = 503;
    expect((await retryJob(job.id, deps())).status).toBe(502);
    world.orchestrator.status = 202;

    const body = await readJson<JobBody>(await retryJob(job.id, deps()));

    expect(body.attempt).toBe(2);
    expect(body.job.status).toBe('queued');
    // Every key distinct. Under `${jobId}:${to}` the second retry's `retrying` write
    // would find its own key already present and REPLAY — the job would report retried
    // and nothing would have moved.
    expect(world.eventKeys()).toEqual([
      `${job.id}:0:estimated`,
      `${job.id}:0:queued`,
      `${job.id}:0:error`,
      `${job.id}:1:retrying`,
      `${job.id}:1:error`,
      `${job.id}:2:retrying`,
      `${job.id}:2:queued`,
    ]);
    expect(new Set(world.eventKeys()).size).toBe(world.eventKeys().length);
  });

  it('returns a refused retry to error rather than leaving it stuck in retrying', async () => {
    const job = await failedJob();
    world.orchestrator.status = 503;

    const response = await retryJob(job.id, deps());
    const stored = await world.job(job.id);

    expect(response.status).toBe(502);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('orchestrator_unavailable');
    expect(world.costCount()).toBe(1);
  });

  it('does not dispatch when the retrying transition was somebody else’s', async () => {
    const job = await failedJob();
    const claimed = repoWith(world.repo, {
      transitionJob: async (jobId, to, options) =>
        to === 'retrying'
          ? { job: { ...job, status: 'retrying' }, outcome: 'replayed' }
          : world.repo.transitionJob(jobId, to, options),
    });

    const response = await retryJob(job.id, deps({ repo: claimed }));
    const body = await readJson<JobBody>(response);

    expect(response.status).toBe(200);
    expect(body.transition).toBe('replayed');
    expect(world.orchestrator.starts).toBe(0);
  });

  it('answers 404 for an unknown job', async () => {
    expect((await rejection(retryJob(UNKNOWN_JOB_ID, deps()))).status).toBe(404);
    expect(world.orchestrator.starts).toBe(0);
  });

  // ── The provider-call gate (research P0) ────────────────────────────────────
  //
  // A retried Workflow starts at load-job and re-runs BOTH generate steps, so a retry after an
  // attempt that reached the provider pays again. The gate therefore refuses while any earlier
  // call has a charge that is not known to be absent and that no human has resolved -- and it
  // refuses BEFORE the retrying event and BEFORE the dispatch, which is what these assert: the
  // event keys are unchanged and the recorded orchestrator saw nothing.
  describe('the provider-call gate', () => {
    type Settled = 'completed' | 'accepted' | 'ambiguous' | 'abandoned';

    /** Plants what an earlier attempt's generate step would have left in the ledger. */
    const priorCall = async (job: JobRecord, attempt: number, label: 'A' | 'B', state?: Settled): Promise<void> => {
      await world.repo.claimProviderCall({ jobId: job.id, attempt, label, providerMode: 'fake', now: world.clock.now() });
      if (state) {
        await world.repo.settleProviderCall({
          jobId: job.id,
          attempt,
          label,
          state,
          providerRequestId: state === 'completed' ? `req-${attempt}-${label}` : undefined,
          now: world.clock.now(),
        });
      }
    };

    it.each([
      ['submitting', undefined],
      ['ambiguous', 'ambiguous'],
      ['completed', 'completed'],
      ['accepted', 'accepted'],
    ] as const)('refuses to retry past a %s call: 409, no retrying event, no dispatch', async (expectedState, settle) => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', settle);
      const eventsBefore = world.eventKeys();

      const failure = await rejection(retryJob(job.id, deps()));

      expect(failure.status).toBe(409);
      expect(failure.code).toBe('unreconciled_provider_call');
      // The refusal names what to look at: which attempt, which candidate, in which state.
      expect(failure.message).toContain('attempt 0');
      expect(failure.message).toContain('A');
      expect(failure.message).toContain(expectedState);
      expect(world.orchestrator.calls).toEqual([]);
      expect(world.eventKeys()).toEqual(eventsBefore);
      expect((await world.job(job.id))?.status).toBe('error');
      expect(world.costCount()).toBe(1);
    });

    it('is not blocked by an abandoned call — the adapter proved the money path was never entered', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'abandoned');
      await priorCall(job, 0, 'B', 'abandoned');

      const body = await readJson<JobBody>(await retryJob(job.id, deps()));

      expect(body.attempt).toBe(1);
      expect(body.job.status).toBe('queued');
      expect(world.orchestrator.starts).toBe(1);
    });

    it('is not blocked once a human has resolved the call, whatever its charge turned out to be', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');
      await priorCall(job, 0, 'B', 'completed');
      expect((await rejection(retryJob(job.id, deps()))).code).toBe('unreconciled_provider_call');

      await world.repo.resolveProviderCall({
        jobId: job.id,
        attempt: 0,
        label: 'A',
        to: 'accepted',
        note: 'the provider invoice lists this request',
        now: world.clock.now(),
      });
      // Still blocked: B is completed and unacknowledged.
      expect((await rejection(retryJob(job.id, deps()))).message).toContain('B');
      expect(world.orchestrator.starts).toBe(0);

      await world.repo.resolveProviderCall({
        jobId: job.id,
        attempt: 0,
        label: 'B',
        note: 'charge acknowledged, retry accepted as a second paid render',
        now: world.clock.now(),
      });
      const body = await readJson<JobBody>(await retryJob(job.id, deps()));

      expect(body.attempt).toBe(1);
      expect(world.orchestrator.starts).toBe(1);
    });

    it('is blocked by mixed attempts: attempt 0 abandoned does not excuse attempt 1 ambiguous', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'abandoned');
      await priorCall(job, 0, 'B', 'abandoned');
      await priorCall(job, 1, 'A', 'ambiguous');

      const failure = await rejection(retryJob(job.id, deps()));

      expect(failure.code).toBe('unreconciled_provider_call');
      expect(failure.message).toContain('attempt 1');
      expect(world.orchestrator.calls).toEqual([]);
    });

    it('is not blocked when no call was ever recorded — absence means "no call", which is sound only because the claim precedes the call', async () => {
      const job = await failedJob();
      expect(await world.repo.listProviderCalls(job.id)).toEqual([]);

      const body = await readJson<JobBody>(await retryJob(job.id, deps()));

      expect(body.attempt).toBe(1);
      expect(world.orchestrator.starts).toBe(1);
    });
  });
});
