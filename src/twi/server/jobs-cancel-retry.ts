import { canTransition } from '../domain/job-state';
import type { CostEstimate } from '../domain/types';

import { HttpError, json } from './http';
import { isUnreconciledProviderCall } from './provider-call-types';
import {
  DEFAULT_RETRY_CHECKPOINT,
  ORCHESTRATOR_ORIGIN,
  clockOf,
  dispatch,
  eventKey,
  failDispatch,
  requireJob,
  startPayload,
  type JobDeps,
} from './jobs';

/**
 * The two control operations on a job that has ALREADY been paid for: cancel and retry.
 *
 * Split out of `./jobs` (gate 2's M7) because that module reached 595 lines carrying five
 * use cases. The two here belong together and apart from the other three: `estimateJob`
 * and `submitJob` decide whether money is spent, while these two act on a job whose
 * estimate row is already written, so neither may ever create a job, a specification or a
 * cost row. That is the invariant the file boundary now makes visible — `saveSpec`,
 * `createEstimatedJob` and `appendCost` are not imported here and must never be.
 *
 * WHY THE SHARED HELPERS ARE IMPORTED RATHER THAN COPIED. Nothing was duplicated in this
 * move. `requireJob`, `dispatch`, `startPayload`, `failDispatch`, `clockOf` and `eventKey`
 * are used by `submitJob` too, so they stay in `./jobs` and are imported from there; the
 * one thing used ONLY by these two functions was the `canTransition` import, which moved
 * with them. The edge is one-way — `./jobs` does not import this module — so there is no
 * cycle, and the route file imports six handlers from two modules instead of one.
 *
 * THE CONTRACT CHECK READS BOTH FILES. Section 13 of the TWI contract check
 * (`scripts/lib/twi-contract-jobs.mjs`) asserts orders WITHIN these functions and absences
 * ACROSS the whole job use case. Its corpus is the concatenation of `./jobs` and this
 * module, so moving a function between the two changes nothing it can see. An order
 * assertion fails CLOSED if a function it names disappears from both — `jobFunction`
 * answers the empty string and `precedes` is false on it — and a separate check refuses an
 * empty or missing file here by name, because an ABSENCE assertion would otherwise pass
 * vacuously over a corpus that had quietly shrunk to one file.
 */

// ---------------------------------------------------------------------------
// POST /api/twi/jobs/:id/cancel
// ---------------------------------------------------------------------------

export async function cancelJob(jobId: string, deps: JobDeps): Promise<Response> {
  const job = await requireJob(jobId, deps.repo);
  // The state machine decides which statuses can be cancelled — `validating` cannot,
  // because a render that is already being checked has nothing left to stop.
  if (!canTransition(job.status, 'cancelling')) {
    throw new HttpError(409, `a job in ${job.status} cannot be cancelled`, 'cancel_not_allowed');
  }
  const attempt = await deps.repo.countJobEvents({ jobId: job.id, toStatus: 'retrying' });

  const stopped = await dispatch(deps, `${ORCHESTRATOR_ORIGIN}/cancel/${encodeURIComponent(job.id)}`, {
    schemaVersion: 1,
    jobId: job.id,
    projectId: job.projectId,
    attempt,
  });
  if (!stopped) {
    // Deliberately NOT transitioned. The render is still going, and a job reported
    // `cancelling` that nothing was ever told to stop is worse than a refusal: the
    // owner stops watching a job that keeps spending.
    return json({ job, outcome: 'not_cancelled', transition: null }, 502);
  }

  const cancelling = await deps.repo.transitionJob(job.id, 'cancelling', {
    fromStatus: job.status,
    phase: 'cancelling',
    retryCheckpoint: null,
    now: clockOf(deps).now(),
    eventKey: eventKey(job.id, attempt, 'cancelling'),
    detailJson: JSON.stringify({ schemaVersion: 1, attempt, requestedFrom: job.status }),
  });
  return json({ job: cancelling.job, outcome: 'cancelling', transition: cancelling.outcome }, 200);
}

// ---------------------------------------------------------------------------
// POST /api/twi/jobs/:id/retry
// ---------------------------------------------------------------------------

/**
 * Resumes a failed job on its ORIGINAL frozen spec and idempotency key.
 *
 * TWO DIFFERENT KINDS OF MONEY ARE AT STAKE HERE, AND THIS FUNCTION ONLY EVER PROTECTED ONE.
 *
 * The job-row argument: nothing here calls `saveSpec` or `createEstimatedJob`, so the
 * specification, the job row and the estimate cost row are the ones the submission already
 * wrote, and a retry cannot become a second SUBMISSION however many times it is pressed. The
 * only new rows are job events, and their keys carry the attempt ordinal. That argument is
 * true and it says nothing about provider calls.
 *
 * The provider-call argument: a retried Workflow starts at `load-job` and re-runs BOTH
 * `generate` steps -- there is no retryCheckpoint resumption in the orchestrator -- so every
 * retry after an attempt that reached the provider buys two more renders. That is a second
 * PAID CALL, not a second submission, and no job-row invariant sees it. The gate below does:
 * it reads the job's provider calls (`twi_provider_calls`, written by the orchestrator BEFORE
 * each billable call) and refuses while any of them has a charge that is not known to be
 * absent and that no human has resolved through `resolveProviderCall`. `abandoned` rows and
 * resolved rows do not block. NO rows at all does not block either -- and that is sound ONLY
 * because the claim row precedes the call, so absence means "no call was recorded" and never
 * "not charged". The refusal comes BEFORE the attempt ordinal is computed and BEFORE any write,
 * so a refused retry leaves no `retrying` event and dispatches nothing.
 *
 * `cancelJob` above is deliberately out of scope for the gate: a cancel stops spending, it
 * cannot start any.
 */
export async function retryJob(jobId: string, deps: JobDeps): Promise<Response> {
  const job = await requireJob(jobId, deps.repo);
  if (job.status !== 'error') {
    throw new HttpError(409, `only a failed job can be retried; this one is ${job.status}`, 'retry_not_allowed');
  }

  // THE PROVIDER-CALL GATE. Read before the ordinal, before any write.
  const blocking = (await deps.repo.listProviderCalls(job.id)).find(isUnreconciledProviderCall);
  if (blocking) {
    throw new HttpError(
      409,
      `attempt ${blocking.attempt} candidate ${blocking.label} left a provider call in state ${blocking.state} ` +
        `with charge certainty ${blocking.chargeCertainty}; a retry would pay for both candidates again, ` +
        'so the call must be resolved first',
      'unreconciled_provider_call',
    );
  }

  const clock = clockOf(deps);
  // The ordinal comes from the job's own history, so it advances across retries even
  // across isolates. Attempt 0 is the submission, so the first retry is 1.
  const attempt = (await deps.repo.countJobEvents({ jobId: job.id, toStatus: 'retrying' })) + 1;

  const retrying = await deps.repo.transitionJob(job.id, 'retrying', {
    fromStatus: 'error',
    phase: 'retrying',
    retryCheckpoint: job.retryCheckpoint ?? DEFAULT_RETRY_CHECKPOINT,
    now: clock.now(),
    eventKey: eventKey(job.id, attempt, 'retrying'),
    detailJson: JSON.stringify({ schemaVersion: 1, attempt, resumedFrom: job.retryCheckpoint }),
  });
  // Anything but `applied` means this call did not claim the attempt — another retry
  // did — so dispatching would start a second render against one paid job.
  if (retrying.outcome !== 'applied') {
    return json({ job: retrying.job, attempt, transition: retrying.outcome }, 200);
  }

  const started = await dispatch(deps, `${ORCHESTRATOR_ORIGIN}/start`, startPayload(job, attempt, job.estimate as CostEstimate | null));
  if (!started) {
    const failure = await failDispatch(deps, job, attempt, 'retrying');
    return json({ job: failure.job, attempt, transition: failure.transition }, 502);
  }

  const queued = await deps.repo.transitionJob(job.id, 'queued', {
    fromStatus: 'retrying',
    phase: 'queued',
    retryCheckpoint: null,
    now: clock.now(),
    eventKey: eventKey(job.id, attempt, 'queued'),
    detailJson: JSON.stringify({ schemaVersion: 1, attempt, dispatched: 'start', accepted: true }),
  });
  return json({ job: queued.job, attempt, transition: queued.outcome }, 200);
}
