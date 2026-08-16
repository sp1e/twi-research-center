/**
 * Replay and race reconciliation.
 *
 * Every write path in this layer can lose a race or be retried by a Cloudflare
 * Workflow. These helpers answer one question: "did somebody else already commit
 * exactly the request I am holding?" If yes the caller returns that outcome; if
 * a *different* request wrote under the same idempotency key, they raise a
 * typed collision instead of overwriting it.
 */

import { canTransition } from '../domain/job-state';
import type { JobStatus } from '../domain/types';

import { canonicalStoredObjectJson, canonicalStringify } from './canonical-json';
import type { D1DatabaseLike } from './d1-types';
import { collision, conflict, corruption, validation } from './errors';
import { findCostEvent, findJobById, findJobByKey, findJobEvent, selectProvisionalCandidates } from './queries';
import type {
  AppendCostInput,
  CreateEstimatedJobInput,
  JobEventRow,
  JobRecord,
  JsonValue,
  PublishCandidatesInput,
  TransitionJobOptions,
} from './repository-types';
import {
  costMatchesInput,
  estimatedJobMatchesInput,
  transitionEventMatches,
  type PublicationPair,
  type ValidatedEstimatedJob,
  type ValidatedPublication,
} from './validation';

export async function reconcileEstimatedJob(
  db: D1DatabaseLike,
  input: CreateEstimatedJobInput,
  validated: ValidatedEstimatedJob,
  cause?: unknown,
): Promise<JobRecord | null> {
  const existing = await findJobByKey(db, input.idempotencyKey);
  if (!existing) return null;
  const event = await findJobEvent(db, existing.id, input.eventKey);
  if (!estimatedJobMatchesInput(existing, event, input, validated)) {
    collision(
      'estimated job idempotency collision',
      {
        jobId: input.id,
        idempotencyKey: input.idempotencyKey,
        observedJobId: existing.id,
        observedStatus: existing.status,
      },
      cause,
    );
  }
  return existing;
}

export async function reconcileTransition(
  db: D1DatabaseLike,
  jobId: string,
  options: TransitionJobOptions,
  to: JobStatus,
  fingerprintJson: string,
  knownEvent?: JobEventRow,
): Promise<JobRecord | null> {
  const event = knownEvent ?? (await findJobEvent(db, jobId, options.eventKey));
  if (!event) return null;
  if (!transitionEventMatches(jobId, event, options.fromStatus, to, options.phase, fingerprintJson)) {
    collision('transition idempotency collision', {
      jobId,
      eventKey: options.eventKey,
      requestedFrom: options.fromStatus,
      requestedTo: to,
      storedFrom: event.from_status,
      storedTo: event.to_status,
    });
  }
  const latest = await findJobById(db, jobId);
  if (!latest) conflict('transition job vanished during reconcile', { jobId, eventKey: options.eventKey });
  return latest;
}

/** Resolves a cost insert that threw or reported zero changes into a verdict. */
export async function reconcileCost(
  db: D1DatabaseLike,
  input: AppendCostInput,
  detailJson: string,
  context: Record<string, unknown>,
  cause?: unknown,
): Promise<boolean> {
  const raced = await findCostEvent(db, input.jobId, input.idempotencyKey);
  if (!raced) return false;
  if (!costMatchesInput(raced, input, detailJson)) {
    collision('cost idempotency collision after race', context, cause);
  }
  return true;
}

export async function reconcilePublication(
  db: D1DatabaseLike,
  input: PublishCandidatesInput,
  publication: ValidatedPublication,
  knownJob?: JobRecord,
): Promise<JobRecord | null> {
  const latest = knownJob ?? (await findJobById(db, input.jobId));
  const event = await findJobEvent(db, input.jobId, input.eventKey);
  if (latest?.status !== 'complete' && !event) return null;
  if (!latest || latest.status !== 'complete' || !event) {
    collision('candidate publication state collision', {
      jobId: input.jobId,
      eventKey: input.eventKey,
      observedStatus: latest?.status ?? null,
      hasEvent: Boolean(event),
    });
  }

  const storedManifest = latest.outputManifest
    ? canonicalStringify(latest.outputManifest as Record<string, JsonValue>, (reason) =>
        corruption(`corrupt twi_jobs ${input.jobId} output_manifest_json: ${reason}`, { jobId: input.jobId }),
      )
    : null;
  const expectedManifest = canonicalStringify(
    publication.manifest as unknown as Record<string, JsonValue>,
    (reason) => validation(`publication manifest ${reason}`, { jobId: input.jobId }),
  );
  const storedFingerprint = canonicalStoredObjectJson(
    event.detail_json,
    `twi_job_events ${input.jobId}/${input.eventKey} detail_json`,
  );
  if (
    latest.projectId !== input.projectId ||
    latest.phase !== 'complete' ||
    latest.finishedAt === null ||
    storedManifest !== expectedManifest ||
    event.from_status === null ||
    !canTransition(event.from_status, 'complete') ||
    event.to_status !== 'complete' ||
    event.phase !== 'complete' ||
    storedFingerprint !== publication.fingerprintJson
  ) {
    collision('candidate publication collision', {
      jobId: input.jobId,
      eventKey: input.eventKey,
      manifestMatches: storedManifest === expectedManifest,
      fingerprintMatches: storedFingerprint === publication.fingerprintJson,
      storedFromStatus: event.from_status,
    });
  }
  return latest;
}

/**
 * Names the `(id, label, kind)` triples that are not present as provisional rows
 * for this job. Without this, candidates registered as `'Candidate A'` instead of
 * `'A'` fail with a message that points at concurrency rather than at the cause.
 */
export async function findUnmatchedPublicationPairs(
  db: D1DatabaseLike,
  input: PublishCandidatesInput,
  pairs: PublicationPair[],
): Promise<PublicationPair[]> {
  const rows = await selectProvisionalCandidates(db, input.projectId, input.jobId);
  const present = new Set(rows.results.map((row) => `${row.id} ${row.label ?? ''} ${row.kind}`));
  return pairs.filter((pair) => !present.has(`${pair.id} ${pair.label} ${pair.kind}`));
}
