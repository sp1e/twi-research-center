// @vitest-environment node
/// <reference types="node" />
//
// What crosses the service binding, and what the audit trail records afterwards.
//
// Every fact in this file is one the change's own comments call load-bearing and that
// nothing tested. Each had a mutation that survived all 523 tests, all 79 contract checks
// and `typecheck:twi` at the merged base:
//
//   * THE ATTEMPT ORDINAL ON THE WIRE. It is pinned inside `twi_job_events.event_key` and
//     was unpinned in the payload the orchestrator actually receives — the one field Task 8
//     uses to tell a retry from the original submission. Setting `startPayload`'s `attempt`
//     to a literal 0 survived, because the only test reading a payload asserted four fields
//     and ran only on submit, where the ordinal genuinely IS 0. It is driven across its
//     admitted range (0, 1, 2) here, on the start payload and on the cancel payload.
//   * `cancelJob`'s ORDINAL. Same shape, worse consequence: with it pinned to 0, a cancel of
//     a retried job writes `…:0:cancelling`, a key that already exists, so `transitionJob`
//     reconciles it as a replay and the route reports `cancelling` while nothing moved —
//     AFTER the stop request was already sent.
//   * `provider` ATTRIBUTION, bound into both the job row and the estimate cost row.
//     `provider: null` survived: cost attribution, entirely unasserted.
//   * the `accepted: false` AUDIT MARKER. The claim is that the trail shows the attempt AND
//     its outcome; `accepted: false` is the outcome half, and flipping it to `true` survived.
//     Both values are asserted below, so the marker cannot be a constant either way.
//   * the READ-BACK STATUS in `failDispatch`. Its comment says the second transition's
//     precondition matches what is actually stored "even if a concurrent writer got there
//     first" — and no test ever had one get there first, so the literal was indistinguishable.
//     The override here IS that concurrent writer, driven through the real repository.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draft } from '../domain/spec.fixture';

import { creationCoreCapabilities } from './capabilities';
import { RIGHTS_ASSERTION_VERSION, submitJob, type JobDeps } from './jobs';
import { cancelJob, retryJob } from './jobs-cancel-retry';
import { FIXED_NOW, OWNER_PROJECT_ID, jobsWorld, jsonRequest, readJson, repoWith, type JobsWorld } from './jobs.harness';
import type { JobRecord } from './repository-types';

const FIRST_KEY = '22222222-2222-4222-8222-222222222222';
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
  attempt?: number;
  transition?: string | null;
}

const submitOnce = async (extra: Partial<JobDeps> = {}): Promise<{ response: Response; job: JobRecord }> => {
  const response = await submitJob(
    jsonRequest(SUBMIT_URL, { projectId: OWNER_PROJECT_ID, idempotencyKey: FIRST_KEY, spec: draft }),
    deps(extra),
  );
  return { response, job: (await readJson<JobBody>(response)).job };
};

/**
 * The CALLER's half of a stored transition event.
 *
 * `twi_job_events.detail_json` holds the repository's transition fingerprint, and what
 * `jobs.ts` passed as `detailJson` is nested under `detail` inside it (validation.ts:180-190).
 * Reading the nested object rather than the whole fingerprint keeps these assertions about
 * the use case's own audit record and not about the repository's idempotency machinery.
 */
const detailOf = (eventKey: string): Record<string, unknown> => {
  const fingerprint = JSON.parse(
    world.db.value<string>('SELECT detail_json FROM twi_job_events WHERE event_key = ?', eventKey),
  ) as { detail?: Record<string, unknown> };
  return fingerprint.detail ?? {};
};

beforeEach(async () => {
  world = await jobsWorld();
});

afterEach(() => {
  world.close();
  vi.restoreAllMocks();
});

describe('the attempt ordinal on the wire', () => {
  it('is 0 on the submission, then 1 and 2 across two retries — in the PAYLOAD, not only the event key', async () => {
    world.orchestrator.status = 503;
    const { job } = await submitOnce();

    expect(world.orchestrator.payload(0).attempt).toBe(0);

    // Refused again, which is the only way production reaches a SECOND retry.
    expect((await retryJob(job.id, deps())).status).toBe(502);
    expect(world.orchestrator.payload(1).attempt).toBe(1);

    world.orchestrator.status = 202;
    expect((await retryJob(job.id, deps())).status).toBe(200);
    expect(world.orchestrator.payload(2).attempt).toBe(2);

    // The number on the wire and the number in the key are the same number. A payload
    // pinned at 0 while the keys advance is exactly the state that survived before.
    expect(world.eventKeys()).toContain(`${job.id}:2:queued`);
    expect(world.orchestrator.starts).toBe(3);
  });

  it('carries the ORIGINAL identity and the paid estimate on a retry, never a second spec', async () => {
    world.orchestrator.status = 503;
    const { job } = await submitOnce();
    world.orchestrator.status = 202;

    await retryJob(job.id, deps());
    const payload = world.orchestrator.payload(1);

    expect(payload).toMatchObject({
      schemaVersion: 1,
      jobId: job.id,
      specId: job.specId,
      specSha256: job.specSha256,
      idempotencyKey: FIRST_KEY,
      attempt: 1,
      estimate: job.estimate,
    });
    expect(world.specCount()).toBe(1);
    expect(world.costCount()).toBe(1);
  });

  it('cancels a RETRIED job under its OWN ordinal, so the cancel cannot replay attempt 0', async () => {
    world.orchestrator.status = 503;
    const { job } = await submitOnce();
    world.orchestrator.status = 202;
    await retryJob(job.id, deps());
    world.orchestrator.calls.length = 0;

    const body = await readJson<JobBody>(await cancelJob(job.id, deps()));

    expect(world.orchestrator.cancels).toBe(1);
    expect(world.orchestrator.payload().attempt).toBe(1);
    expect(body.job.status).toBe('cancelling');

    const keys = world.eventKeys();
    expect(keys).toContain(`${job.id}:1:cancelling`);
    // With the ordinal pinned to 0 this would be `…:0:cancelling` — a key already written
    // for this job's first attempt, which `transitionJob` answers as a replay.
    expect(keys).not.toContain(`${job.id}:0:cancelling`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('percent-encodes the job id in the cancel URL rather than pasting it into the path', async () => {
    // `twi_jobs.id` carries no format CHECK and this route takes the id straight from a URL
    // segment, so the encoding is all that stands between a stored id and a forged internal
    // path. Every id the suite mints is a UUID, so nothing could tell the difference; this
    // writes a job whose id needs encoding, through the real repository.
    const specId = '77777777-7777-4777-8777-777777777777';
    const jobId = 'raw id/../start';
    await world.repo.saveSpec({
      id: specId,
      projectId: OWNER_PROJECT_ID,
      specJson: JSON.stringify(draft),
      rightsAssertionVersion: RIGHTS_ASSERTION_VERSION,
      createdAt: FIXED_NOW,
    });
    await world.repo.createEstimatedJob({
      id: jobId,
      projectId: OWNER_PROJECT_ID,
      specId,
      idempotencyKey: FIRST_KEY,
      estimateJson: JSON.stringify({ currency: 'USD', total: 0.05 }),
      estimateAmountUsd: 0.05,
      provider: creationCoreCapabilities.provider,
      model: null,
      eventKey: `${jobId}:0:estimated`,
      eventDetailJson: JSON.stringify({ schemaVersion: 1, attempt: 0 }),
      costIdempotencyKey: `${jobId}:0:estimate`,
      costDetailJson: JSON.stringify({ schemaVersion: 1, kind: 'estimate' }),
      now: FIXED_NOW,
    });
    await world.repo.transitionJob(jobId, 'queued', {
      fromStatus: 'estimated',
      phase: 'queued',
      retryCheckpoint: null,
      now: FIXED_NOW,
      eventKey: `${jobId}:0:queued`,
      detailJson: JSON.stringify({ schemaVersion: 1, attempt: 0 }),
    });

    await cancelJob(jobId, deps());

    expect(world.orchestrator.call().url).toBe(`https://twi.internal/cancel/${encodeURIComponent(jobId)}`);
    expect(world.orchestrator.call().url).not.toContain('/../');
  });
});

describe('what the audit trail and the cost row record', () => {
  it('attributes the provider on BOTH the job row and the estimate cost row', async () => {
    const { job } = await submitOnce();

    // Named, not read off the code under test: a null on either side is a cost row nobody
    // can attribute, and both survived being nulled.
    expect(creationCoreCapabilities.provider).toBe('lyria-3-pro');
    expect(job.provider).toBe('lyria-3-pro');
    expect(world.db.value<string>('SELECT provider FROM twi_jobs')).toBe('lyria-3-pro');
    expect(world.db.value<string>('SELECT provider FROM twi_cost_events')).toBe('lyria-3-pro');
  });

  it('records a refused dispatch as accepted: false and an accepted one as true', async () => {
    world.orchestrator.status = 503;
    const refused = await submitOnce();

    expect(refused.response.status).toBe(502);
    expect(detailOf(`${refused.job.id}:0:queued`)).toMatchObject({
      schemaVersion: 1,
      attempt: 0,
      dispatched: 'start',
      accepted: false,
    });
    // Both transitions of the failure path sit under the SAME ordinal, which is what makes
    // the attempt and its outcome one story rather than two.
    expect(detailOf(`${refused.job.id}:0:error`)).toMatchObject({ schemaVersion: 1, attempt: 0 });

    // And the accepted case records the other value, so the marker is not a constant.
    world.orchestrator.status = 202;
    const accepted = await submitJob(
      jsonRequest(SUBMIT_URL, {
        projectId: OWNER_PROJECT_ID,
        idempotencyKey: '66666666-6666-4666-8666-666666666666',
        spec: draft,
      }),
      deps(),
    );
    const acceptedJob = (await readJson<JobBody>(accepted)).job;
    expect(detailOf(`${acceptedJob.id}:0:queued`)).toMatchObject({ dispatched: 'start', accepted: true });
  });

  it('takes the failure transition from the STORED status, so a concurrent writer does not strand the job', async () => {
    // The override is the concurrent writer the comment describes: it performs the real
    // `estimated → queued` transition and then advances the row one further legal edge, the
    // way the orchestrator would if it picked the job up between `failDispatch`'s two
    // writes. With the precondition read back, `generating → error` applies. With the
    // literal `'estimated'`/`'queued'`, the precondition fails, the repository raises a
    // conflict, and the request dies as a 500 with the job stranded OUTSIDE `error` — where
    // the retry route cannot reach it and its paid estimate is lost.
    world.orchestrator.status = 503;
    const racing = repoWith(world.repo, {
      transitionJob: async (jobId, to, options) => {
        const applied = await world.repo.transitionJob(jobId, to, options);
        if (to !== 'queued') return applied;
        await world.repo.transitionJob(jobId, 'generating', {
          fromStatus: 'queued',
          phase: 'generating',
          retryCheckpoint: null,
          now: world.clock.now(),
          eventKey: `${jobId}:0:generating`,
          detailJson: JSON.stringify({ schemaVersion: 1, attempt: 0, wroteBy: 'concurrent' }),
        });
        return { job: (await world.repo.findJobById(jobId)) ?? applied.job, outcome: applied.outcome };
      },
    });

    const { response, job } = await submitOnce({ repo: racing });
    const stored = await world.job(job.id);

    expect(response.status).toBe(502);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('orchestrator_unavailable');
    expect(stored?.retryCheckpoint).toBe('queued');
    // The whole finding in one line: the recorded edge is the one that was actually stored.
    expect(
      world.db.value<string>('SELECT from_status FROM twi_job_events WHERE event_key = ?', `${job.id}:0:error`),
    ).toBe('generating');
  });
});
