import { canTransition } from '../domain/job-state';
import { estimateRequestSchema, submitJobSchema } from '../domain/schemas';
import type { CostEstimate, JobStatus } from '../domain/types';

import { MAX_IMAGE_REFERENCES_PER_SPEC, assertImageReferenceSelection } from './assets';
import { creationCoreCapabilities } from './capabilities';
import { TwiRepositoryCollisionError } from './errors';
import { creationCoreEstimatePolicy, estimateView, type EstimatePolicy } from './estimates';
import { HttpError, json, parseJson } from './http';
import { assertImageReferencesUsable } from './job-references';
import type { TwiOrchestratorBinding } from './orchestrator-types';
import { systemIdentityClock, type ProjectIdentityClock } from './projects';
import { specSha256, type TwiRepository } from './repository';
import type { JobRecord, RetryCheckpoint, TransitionOutcome } from './repository-types';

/**
 * The creation-job use cases: estimate, submit, poll, cancel, retry.
 *
 * This is the money path. Every request below either costs the owner real provider
 * money or acts on a job that already did, so the properties that matter are not
 * response shapes — they are counts. ONE job per idempotency key, ONE estimate cost
 * row, ONE Workflow start. A duplicate submission is a financial defect and a false
 * idempotency collision is a broken retry, and each of the five inherited contracts
 * below exists because one of those was reproduced end to end earlier in this project.
 *
 *   1. `spec_sha256` IS REPOSITORY-DERIVED. The fingerprint comes from `specSha256()`
 *      (re-exported by `./repository`, computed over the canonicalised document by
 *      `./spec-digest`) and the SAME value is handed to
 *      `findJobByIdempotencyKey`. Hashing it independently here would produce a digest
 *      that disagrees with the stored one, and that lookup reads a mismatch as "this
 *      key belongs to a different request" — turning a caller's legitimate replay into
 *      a SECOND PAID SUBMISSION. `saveSpec`'s returned digest is compared against it
 *      below, so the two can never silently part company.
 *   2. EVERY TIMESTAMP IS JS-GENERATED `YYYY-MM-DDTHH:MM:SS.sssZ`. The repository
 *      refuses anything else at its boundary and twelve schema CHECKs refuse it again
 *      at write time — including hour 24 — so a wrong shape is a runtime failure, not
 *      a type error. Nothing here asks SQLite for the time.
 *   3. THE OUTCOME DECIDES. `createEstimatedJob` and `transitionJob` return
 *      `{ job, outcome }`, and a resolved promise does not mean this call wrote
 *      anything. `outcome` picks the status code (201 only for a job this call
 *      created) and gates the dispatch (a replayed insert must not start a second
 *      render). Reading an outcome is not using it: an implementation that answered
 *      201 unconditionally once left an entire suite green.
 *   4. EVERY EVENT AND COST INSERT SUPPLIES ITS OWN KEY. `twi_job_events.event_key`
 *      and `twi_cost_events.idempotency_key` are NOT NULL, UNIQUE and have no DEFAULT.
 *      The job-event key carries the ATTEMPT ORDINAL: `${jobId}:${to}` collides on the
 *      first retry loop and the second write becomes a silent no-op replay, so the job
 *      would report retried while nothing moved.
 *   5. THE TEN-REFERENCE CAP IS CALLED. `assertImageReferenceSelection` shipped in
 *      Task 6 with no production caller, which means the cap did not exist. It is
 *      applied HERE, to the raw request and ahead of the schema parse, so the refusal
 *      is specific (`too_many_image_references`) and costs nothing.
 *
 * The route file stays a route table: every function here owns one route's whole job —
 * validate, call the repository, dispatch, shape the response — and returns a
 * `Response`, so the whole surface is unit-testable without a Workers runtime.
 */

/** The rights assertion the owner accepts by submitting, versioned with the spec. */
export const RIGHTS_ASSERTION_VERSION = '2026-08-16';

/** Where the Workflow Worker answers. A service binding, never the public internet. */
export const ORCHESTRATOR_ORIGIN = 'https://twi.internal';

/** The submission itself is attempt 0; the first retry is attempt 1. */
export const SUBMIT_ATTEMPT = 0;

/** How many jobs one list answer may carry. Not caller-controlled. */
export const MAX_JOB_PAGE = 50;

/** Where a resumed job starts when the failed attempt recorded no checkpoint. */
export const DEFAULT_RETRY_CHECKPOINT: RetryCheckpoint = 'queued';

export const ORCHESTRATOR_UNAVAILABLE = 'orchestrator_unavailable';

/** Longest refusal detail echoed from a schema failure. Bounds a hostile payload. */
const MAX_ISSUE_TEXT = 400;
const MAX_REPORTED_ISSUES = 5;

export interface JobDeps {
  repo: TwiRepository;
  orchestrator: TwiOrchestratorBinding;
  /** The raw `TWI_LYRIA_ESTIMATE_USD` value, or nothing. Parsed by `./estimates`. */
  providerEstimateUsd?: string | null;
  clock?: ProjectIdentityClock;
}

interface DispatchFailure {
  job: JobRecord;
  transition: TransitionOutcome;
}

const clockOf = (deps: JobDeps): ProjectIdentityClock => deps.clock ?? systemIdentityClock;

const policyOf = (deps: JobDeps): EstimatePolicy =>
  creationCoreEstimatePolicy(deps.providerEstimateUsd ?? null);

/** `${jobId}:${attempt}:${to}` — unique per attempt, which is the whole point. */
const eventKey = (jobId: string, attempt: number, to: JobStatus): string => `${jobId}:${attempt}:${to}`;

const costKey = (jobId: string, attempt: number): string => `${jobId}:${attempt}:estimate`;

/**
 * A schema failure, recognised without importing zod into this module.
 *
 * Structural rather than `instanceof ZodError` deliberately: the route file's import
 * graph carries no npm package of its own, and the check that pins that reads the
 * files it lists. The name plus a real `issues` array is a precise enough test — and
 * anything that is not one is rethrown untouched, so a genuine fault still reaches the
 * route's `internal_error` mapping instead of being reported as a bad request.
 */
const schemaIssuesOf = (error: unknown): string[] | null => {
  if (!(error instanceof Error) || error.name !== 'ZodError') return null;
  const { issues } = error as unknown as { issues?: unknown };
  if (!Array.isArray(issues)) return null;
  return issues.slice(0, MAX_REPORTED_ISSUES).map((entry) => {
    const issue = entry as { path?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
    const message = typeof issue.message === 'string' ? issue.message : 'invalid value';
    return path.length > 0 ? `${path}: ${message}` : message;
  });
};

/**
 * Parses and normalizes in one step, because the schema does both: the transforms are
 * inside it, and its output is the branded `NormalizedGenerationSpec` nothing else can
 * mint. A `ZodError` is a 400 — including the `instrumental`-with-vocal-fields
 * rejection, which is a refusal rather than a silent discard of what the owner typed.
 */
const parseRequest = <T>(schema: { parse(value: unknown): T }, body: unknown): T => {
  try {
    return schema.parse(body);
  } catch (error) {
    const issues = schemaIssuesOf(error);
    if (!issues) throw error;
    const detail = issues.join('; ').slice(0, MAX_ISSUE_TEXT);
    throw new HttpError(400, `the creation specification was refused — ${detail}`, 'invalid_spec');
  }
};

/**
 * The reference list as the request sent it, bounded.
 *
 * At most `cap + 1` entries are copied: enough for the cap below to fire, and bounded
 * so a million-entry array costs O(cap) rather than O(entries) before anything parses
 * it. Same shape of guard as `RAW_ENTRY_SLACK` in src/twi/domain/schemas.ts, and here
 * for the same measured reason — a bound applied after the work is an amplifier.
 */
const rawImageReferences = (body: Record<string, unknown>): string[] => {
  const { spec } = body;
  if (spec === null || typeof spec !== 'object') return [];
  const { sound } = spec as { sound?: unknown };
  if (sound === null || typeof sound !== 'object') return [];
  const { imageAssetIds } = sound as { imageAssetIds?: unknown };
  if (!Array.isArray(imageAssetIds)) return [];
  return imageAssetIds.slice(0, MAX_IMAGE_REFERENCES_PER_SPEC + 1).map((id) => String(id));
};

const requireProject = async (projectId: string, repo: TwiRepository): Promise<void> => {
  const project = projectId.trim().length === 0 ? null : await repo.getProject(projectId);
  if (!project) throw new HttpError(404, 'project not found');
};

/** A blank id is a request for a job that cannot exist, not a server fault. */
const requireJob = async (jobId: string, repo: TwiRepository): Promise<JobRecord> => {
  const job = jobId.trim().length === 0 ? null : await repo.findJobById(jobId);
  if (!job) throw new HttpError(404, 'job not found');
  return job;
};

/**
 * The replay lookup, on the digest `specSha256()` derived.
 *
 * A `TwiRepositoryCollisionError` here is the key being reused for a MATERIALLY
 * DIFFERENT specification, which is a caller mistake and answered 409 — not the
 * internal fault it would otherwise surface as.
 */
const findReplayableJob = async (
  repo: TwiRepository,
  input: { projectId: string; idempotencyKey: string; specSha256: string },
): Promise<JobRecord | null> => {
  try {
    return await repo.findJobByIdempotencyKey(input);
  } catch (error) {
    if (error instanceof TwiRepositoryCollisionError) {
      throw new HttpError(
        409,
        'this idempotency key was already used for a different specification',
        'idempotency_key_reused',
      );
    }
    throw error;
  }
};

/**
 * One POST to the Workflow Worker. Returns whether it landed, and never throws.
 *
 * What crosses this boundary is an IDENTITY — ids, the spec digest, the attempt, the
 * estimate — and never the specification itself. The Workflow loads the frozen spec
 * from its own row, so the lyrics the owner typed are not copied into a second place
 * on every submission.
 */
const dispatch = async (deps: JobDeps, url: string, payload: Record<string, unknown>): Promise<boolean> => {
  try {
    const response = await deps.orchestrator.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (error) {
    // The binding's message quotes connection detail, so the caller gets a verdict and
    // the log gets the error's class — the same split the route table makes for a 500.
    console.error('[twi] orchestrator dispatch failed', {
      url,
      error: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
};

const startPayload = (job: JobRecord, attempt: number, estimate: CostEstimate | null): Record<string, unknown> => ({
  schemaVersion: 1,
  jobId: job.id,
  projectId: job.projectId,
  specId: job.specId,
  specSha256: job.specSha256,
  idempotencyKey: job.idempotencyKey,
  attempt,
  estimate,
});

/**
 * A dispatch that did not land, recorded as a FAILED job the retry route can pick up.
 *
 * From `retrying` that is one transition. From `estimated` it is TWO, and the reason is
 * the closed state machine rather than a preference: `src/twi/domain/job-state.ts`
 * models `estimated → queued` as the only edge out of `estimated`, so `estimated →
 * error` does not exist and `assertTransition` refuses it. The job has to end in
 * `error` — the retry route is allowed only from `error`, so anything else would leave
 * a failed submission unreachable and its paid estimate stranded. It therefore takes
 * the one legal path: queued, which is what the dispatch attempt WAS, and then failed.
 * Both events are written under the same attempt ordinal, so the audit trail shows the
 * attempt and its outcome rather than hiding one of them. The domain is not modified.
 */
const failDispatch = async (
  deps: JobDeps,
  job: JobRecord,
  attempt: number,
  fromStatus: 'estimated' | 'retrying',
): Promise<DispatchFailure> => {
  const clock = clockOf(deps);
  const checkpoint = job.retryCheckpoint ?? DEFAULT_RETRY_CHECKPOINT;

  let from: JobStatus = fromStatus;
  if (fromStatus === 'estimated') {
    const queued = await deps.repo.transitionJob(job.id, 'queued', {
      fromStatus: 'estimated',
      phase: 'queued',
      retryCheckpoint: null,
      now: clock.now(),
      eventKey: eventKey(job.id, attempt, 'queued'),
      detailJson: JSON.stringify({ schemaVersion: 1, attempt, dispatched: 'start', accepted: false }),
    });
    // The read-back status, not the literal: the second transition's precondition then
    // matches what is actually stored even if a concurrent writer got there first.
    from = queued.job.status;
  }

  const failed = await deps.repo.transitionJob(job.id, 'error', {
    fromStatus: from,
    phase: 'error',
    retryCheckpoint: checkpoint,
    now: clock.now(),
    eventKey: eventKey(job.id, attempt, 'error'),
    errorCode: ORCHESTRATOR_UNAVAILABLE,
    errorMessage: 'the render orchestrator did not accept the job',
    detailJson: JSON.stringify({ schemaVersion: 1, attempt }),
  });
  return { job: failed.job, transition: failed.outcome };
};

// ---------------------------------------------------------------------------
// POST /api/twi/jobs/estimate — the "before" half of the cost rule
// ---------------------------------------------------------------------------

export async function estimateJob(request: Request, deps: JobDeps): Promise<Response> {
  const body = await parseJson(request);
  assertImageReferenceSelection(rawImageReferences(body));
  const { projectId, spec } = parseRequest(estimateRequestSchema, body);
  await requireProject(projectId, deps.repo);
  await assertImageReferencesUsable(projectId, spec.sound.imageAssetIds, deps.repo);
  return json(estimateView(await policyOf(deps).estimate(spec)));
}

// ---------------------------------------------------------------------------
// POST /api/twi/jobs — idempotent submission
// ---------------------------------------------------------------------------

export async function submitJob(request: Request, deps: JobDeps): Promise<Response> {
  const body = await parseJson(request);
  // Free, and therefore first: no query, no parse, nothing paid for.
  assertImageReferenceSelection(rawImageReferences(body));
  const { projectId, idempotencyKey, spec } = parseRequest(submitJobSchema, body);
  await requireProject(projectId, deps.repo);
  await assertImageReferencesUsable(projectId, spec.sound.imageAssetIds, deps.repo);

  const specJson = JSON.stringify(spec);
  // THE fingerprint, derived by the repository. Never hashed here — see contract 1.
  const fingerprint = await specSha256(specJson);

  const prior = await findReplayableJob(deps.repo, { projectId, idempotencyKey, specSha256: fingerprint });
  if (prior) return json({ job: prior, outcome: 'replayed', transition: null }, 200);

  const clock = clockOf(deps);
  const estimate = await policyOf(deps).estimate(spec);
  const now = clock.now();
  const specId = clock.newId();
  const jobId = clock.newId();

  const saved = await deps.repo.saveSpec({
    id: specId,
    projectId,
    specJson,
    rightsAssertionVersion: RIGHTS_ASSERTION_VERSION,
    createdAt: now,
  });
  if (saved.specSha256 !== fingerprint) {
    // Unreachable while both values come from `canonicalSpecDocument`, and asserted
    // anyway: this exact divergence was reproduced end to end once, and it presents as
    // a caller's own paid submission being refused as somebody else's.
    throw new HttpError(
      500,
      'the stored specification digest disagrees with the submitted one',
      'spec_digest_mismatch',
    );
  }

  const { job, outcome } = await deps.repo.createEstimatedJob({
    id: jobId,
    projectId,
    specId,
    idempotencyKey,
    estimateJson: JSON.stringify(estimate),
    estimateAmountUsd: estimate.total,
    provider: creationCoreCapabilities.provider,
    model: null,
    eventKey: eventKey(jobId, SUBMIT_ATTEMPT, 'estimated'),
    eventDetailJson: JSON.stringify({
      schemaVersion: 1,
      event: 'submit',
      attempt: SUBMIT_ATTEMPT,
      specSha256: fingerprint,
    }),
    costIdempotencyKey: costKey(jobId, SUBMIT_ATTEMPT),
    costDetailJson: JSON.stringify({ schemaVersion: 1, kind: 'estimate', estimate }),
    now,
  });
  // The outcome decides. `replayed` means a concurrent submission of this key won, so
  // nothing was charged twice — and starting a render here would start a second one for
  // the job that other request is about to queue.
  if (outcome === 'replayed') return json({ job, outcome, transition: null }, 200);

  const started = await dispatch(deps, `${ORCHESTRATOR_ORIGIN}/start`, startPayload(job, SUBMIT_ATTEMPT, estimate));
  if (!started) {
    const failure = await failDispatch(deps, job, SUBMIT_ATTEMPT, 'estimated');
    return json({ job: failure.job, outcome: 'error', transition: failure.transition }, 502);
  }

  // `estimated → queued` only after a successful internal response.
  const queued = await deps.repo.transitionJob(job.id, 'queued', {
    fromStatus: 'estimated',
    phase: 'queued',
    retryCheckpoint: null,
    now: clock.now(),
    eventKey: eventKey(job.id, SUBMIT_ATTEMPT, 'queued'),
    detailJson: JSON.stringify({ schemaVersion: 1, attempt: SUBMIT_ATTEMPT, dispatched: 'start', accepted: true }),
  });
  return json({ job: queued.job, outcome, transition: queued.outcome }, 201);
}

// ---------------------------------------------------------------------------
// GET /api/twi/jobs and GET /api/twi/jobs/:id — polling
// ---------------------------------------------------------------------------

export async function listJobs(request: Request, repo: TwiRepository): Promise<Response> {
  const requested = new URL(request.url).searchParams.get('projectId');
  const projectId = requested !== null && requested.trim().length > 0 ? requested.trim() : null;
  return json({ jobs: await repo.listJobs({ projectId, limit: MAX_JOB_PAGE }) });
}

export async function getJob(jobId: string, repo: TwiRepository): Promise<Response> {
  return json({ job: await requireJob(jobId, repo) });
}

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
 * Nothing here calls `saveSpec` or `createEstimatedJob`: the specification, the job row
 * and the estimate cost row are the ones the submission already wrote, so a retry
 * cannot become a second paid submission however many times it is pressed. The only
 * new rows are job events, and their keys carry the attempt ordinal.
 */
export async function retryJob(jobId: string, deps: JobDeps): Promise<Response> {
  const job = await requireJob(jobId, deps.repo);
  if (job.status !== 'error') {
    throw new HttpError(409, `only a failed job can be retried; this one is ${job.status}`, 'retry_not_allowed');
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
