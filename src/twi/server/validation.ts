import { canTransition } from '../domain/job-state';
import type { AssetKind, JobPhase, JobStatus } from '../domain/types';

import {
  assertEnum,
  assertFiniteNonnegative,
  assertNonBlank,
  assertNullableNonBlank,
  assertNullableTimestamp,
  assertTimestamp,
} from './assertions';
import { canonicalStoredObjectJson, canonicalStringify, parseInputObjectJson } from './canonical-json';
import { validation } from './errors';
import {
  ASSET_KINDS,
  ASSET_LIFECYCLES,
  COST_CATEGORIES,
  JOB_PHASES,
  JOB_STATUSES,
  RETRY_CHECKPOINTS,
  type AppendCostInput,
  type AssetRecord,
  type CandidateLabel,
  type CandidatePublicationEntry,
  type CandidatePublicationManifest,
  type CostEventRow,
  type CreateEstimatedJobInput,
  type JobEventRow,
  type JobRecord,
  type JsonValue,
  type PublishCandidatesInput,
  type RegisterAssetInput,
  type TransitionJobOptions,
} from './repository-types';

export function assetMatchesInput(asset: AssetRecord, input: RegisterAssetInput): boolean {
  return (
    asset.id === input.id &&
    asset.projectId === input.projectId &&
    asset.jobId === input.jobId &&
    asset.kind === input.kind &&
    asset.label === input.label &&
    asset.r2Key === input.r2Key &&
    asset.contentType === input.contentType &&
    asset.bytes === input.bytes &&
    asset.durationSeconds === input.durationSeconds &&
    asset.sha256 === input.sha256 &&
    asset.provenanceKey === input.provenanceKey &&
    asset.lifecycleState === input.lifecycleState &&
    asset.createdAt === input.createdAt &&
    asset.deletedAt === input.deletedAt
  );
}

export function validateAssetInput(input: RegisterAssetInput): void {
  assertNonBlank('asset.id', input.id);
  assertNonBlank('asset.projectId', input.projectId);
  assertNullableNonBlank('asset.jobId', input.jobId);
  assertEnum('asset.kind', input.kind, ASSET_KINDS);
  assertNullableNonBlank('asset.label', input.label);
  assertNonBlank('asset.r2Key', input.r2Key);
  assertNonBlank('asset.contentType', input.contentType);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
    validation('asset.bytes must be a nonnegative safe integer', { field: 'asset.bytes' });
  }
  assertFiniteNonnegative('asset.durationSeconds', input.durationSeconds, true);
  assertNonBlank('asset.sha256', input.sha256);
  assertNullableNonBlank('asset.provenanceKey', input.provenanceKey);
  assertEnum('asset.lifecycleState', input.lifecycleState, ASSET_LIFECYCLES);
  assertTimestamp('asset.createdAt', input.createdAt);
  assertNullableTimestamp('asset.deletedAt', input.deletedAt);
  if (input.lifecycleState === 'deleted' && input.deletedAt === null) {
    validation('deleted asset requires deletedAt', { assetId: input.id });
  }
  if (input.lifecycleState !== 'deleted' && input.deletedAt !== null) {
    validation('non-deleted asset must have null deletedAt', { assetId: input.id });
  }
}

export interface ValidatedEstimatedJob {
  estimateJson: string;
  eventDetailJson: string;
  costDetailJson: string;
}

export function validateCreateEstimatedJobInput(input: CreateEstimatedJobInput): ValidatedEstimatedJob {
  assertNonBlank('job.id', input.id);
  assertNonBlank('job.projectId', input.projectId);
  assertNonBlank('job.specId', input.specId);
  assertNonBlank('job.idempotencyKey', input.idempotencyKey);
  assertNonBlank('job.eventKey', input.eventKey);
  assertNonBlank('job.costIdempotencyKey', input.costIdempotencyKey);
  assertTimestamp('job.now', input.now);
  assertNullableNonBlank('job.provider', input.provider);
  assertNullableNonBlank('job.model', input.model);
  assertFiniteNonnegative('job.estimateAmountUsd', input.estimateAmountUsd);
  return {
    estimateJson: parseInputObjectJson('job.estimateJson', input.estimateJson).canonical,
    eventDetailJson: parseInputObjectJson('job.eventDetailJson', input.eventDetailJson).canonical,
    costDetailJson: parseInputObjectJson('job.costDetailJson', input.costDetailJson).canonical,
  };
}

/**
 * True when an already-stored job is the *same submission* as this request, so a
 * loser of the UNIQUE(idempotency_key) race can be handed the winner's row
 * instead of a raw driver error.
 */
export function estimatedJobMatchesInput(
  job: JobRecord,
  event: JobEventRow | null,
  input: CreateEstimatedJobInput,
  validated: ValidatedEstimatedJob,
): boolean {
  if (
    job.id !== input.id ||
    job.projectId !== input.projectId ||
    job.specId !== input.specId ||
    job.idempotencyKey !== input.idempotencyKey ||
    job.provider !== input.provider ||
    job.model !== input.model
  ) {
    return false;
  }
  if (job.estimate === null) return false;
  const storedEstimate = canonicalStringify(job.estimate as Record<string, JsonValue>, (reason) => {
    validation(`stored estimate ${reason}`, { jobId: job.id });
  });
  if (storedEstimate !== validated.estimateJson) return false;
  if (!event || event.from_status !== null || event.to_status !== 'estimated') return false;
  return (
    canonicalStoredObjectJson(
      event.detail_json,
      `twi_job_events ${job.id}/${event.event_key} detail_json`,
    ) === validated.eventDetailJson
  );
}

export function validateTransitionInput(
  jobId: string,
  to: JobStatus,
  options: TransitionJobOptions,
): { fingerprintJson: string } {
  assertNonBlank('jobId', jobId);
  assertEnum('transition.to', to, JOB_STATUSES);
  if (to === 'complete') {
    validation(
      'transition.to must not be complete: use publishCandidates, the only writer that completes a job together with its output manifest',
      { jobId, to },
    );
  }
  assertEnum('transition.fromStatus', options.fromStatus, JOB_STATUSES);
  if (options.phase !== null) assertEnum('transition.phase', options.phase, JOB_PHASES);
  if (!Object.prototype.hasOwnProperty.call(options, 'retryCheckpoint')) {
    validation('transition.retryCheckpoint must be supplied explicitly', { jobId });
  }
  if (options.retryCheckpoint !== null) {
    assertEnum('transition.retryCheckpoint', options.retryCheckpoint, RETRY_CHECKPOINTS);
  }
  assertTimestamp('transition.now', options.now);
  assertNonBlank('transition.eventKey', options.eventKey);

  if (to === 'error') {
    assertNonBlank('transition.errorCode', options.errorCode);
    assertNonBlank('transition.errorMessage', options.errorMessage);
    if (options.retryCheckpoint === null) {
      validation('error transition requires retryCheckpoint', { jobId });
    }
  } else if (options.errorCode !== undefined || options.errorMessage !== undefined) {
    validation('non-error transition must not provide error metadata', { jobId, to });
  }
  if (to === 'retrying' && options.retryCheckpoint === null) {
    validation('retrying transition requires retryCheckpoint', { jobId });
  }
  if (to !== 'error' && to !== 'retrying' && options.retryCheckpoint !== null) {
    validation('non-retry transition must clear retryCheckpoint', { jobId, to });
  }

  const callerDetail = parseInputObjectJson('transition.detailJson', options.detailJson ?? '{}');
  const fingerprint = {
    schemaVersion: 1,
    eventType: 'job-transition',
    fromStatus: options.fromStatus,
    toStatus: to,
    phase: options.phase,
    retryCheckpoint: options.retryCheckpoint,
    errorCode: to === 'error' ? (options.errorCode as string) : null,
    errorMessage: to === 'error' ? (options.errorMessage as string) : null,
    detail: callerDetail.object,
  } as unknown as Record<string, JsonValue>;
  return {
    fingerprintJson: canonicalStringify(fingerprint, (reason) =>
      validation(`transition fingerprint ${reason}`, { jobId }),
    ),
  };
}

export function transitionEventMatches(
  jobId: string,
  event: JobEventRow,
  from: JobStatus,
  to: JobStatus,
  phase: JobPhase | null,
  fingerprintJson: string,
): boolean {
  if (event.from_status !== from || !canTransition(from, to)) return false;
  const eventDetail = canonicalStoredObjectJson(
    event.detail_json,
    `twi_job_events ${jobId}/${event.event_key} detail_json`,
  );
  return event.to_status === to && event.phase === phase && eventDetail === fingerprintJson;
}

export function validateCostInput(input: AppendCostInput): string {
  assertNonBlank('cost.jobId', input.jobId);
  assertNonBlank('cost.idempotencyKey', input.idempotencyKey);
  assertEnum('cost.category', input.category, COST_CATEGORIES);
  assertNullableNonBlank('cost.provider', input.provider);
  assertNullableNonBlank('cost.model', input.model);
  assertFiniteNonnegative('cost.amountUsd', input.amountUsd);
  assertFiniteNonnegative('cost.quantity', input.quantity, true);
  assertTimestamp('cost.createdAt', input.createdAt);
  return parseInputObjectJson('cost.detailJson', input.detailJson).canonical;
}

export function costMatchesInput(row: CostEventRow, input: AppendCostInput, detailJson: string): boolean {
  return (
    row.job_id === input.jobId &&
    row.idempotency_key === input.idempotencyKey &&
    row.category === input.category &&
    row.provider === input.provider &&
    row.model === input.model &&
    row.amount_usd === input.amountUsd &&
    row.quantity === input.quantity &&
    canonicalStoredObjectJson(
      row.detail_json,
      `twi_cost_events ${row.job_id}/${row.idempotency_key} detail_json`,
    ) === detailJson
  );
}

export interface PublicationPair {
  id: string;
  label: CandidateLabel;
  kind: Exclude<AssetKind, 'image-reference'>;
}

export interface ValidatedPublication {
  manifest: CandidatePublicationManifest;
  manifestJson: string;
  fingerprintJson: string;
  pairs: PublicationPair[];
}

export function validatePublicationInput(input: PublishCandidatesInput): ValidatedPublication {
  assertNonBlank('publication.projectId', input.projectId);
  assertNonBlank('publication.jobId', input.jobId);
  assertNonBlank('publication.eventKey', input.eventKey);
  assertTimestamp('publication.now', input.now);
  if (!Array.isArray(input.candidates) || input.candidates.length !== 2) {
    validation('publication requires exactly two candidates', { jobId: input.jobId });
  }

  const normalized = input.candidates.map((candidate, index): CandidatePublicationEntry => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      validation(`publication.candidates[${index}] must be an object`, { jobId: input.jobId });
    }
    assertEnum(`publication.candidates[${index}].label`, candidate.label, ['A', 'B'] as const);
    assertNonBlank(`publication.candidates[${index}].rawAssetId`, candidate.rawAssetId);
    assertNonBlank(`publication.candidates[${index}].masterAssetId`, candidate.masterAssetId);
    assertNonBlank(`publication.candidates[${index}].previewAssetId`, candidate.previewAssetId);
    assertNonBlank(`publication.candidates[${index}].provenanceAssetId`, candidate.provenanceAssetId);
    return {
      label: candidate.label,
      rawAssetId: candidate.rawAssetId,
      masterAssetId: candidate.masterAssetId,
      previewAssetId: candidate.previewAssetId,
      provenanceAssetId: candidate.provenanceAssetId,
    };
  });
  if (new Set(normalized.map(({ label }) => label)).size !== 2) {
    validation('publication candidates must contain labels A and B exactly once', { jobId: input.jobId });
  }
  normalized.sort((left, right) => left.label.localeCompare(right.label));
  const candidates = normalized as [CandidatePublicationEntry, CandidatePublicationEntry];
  const pairs: PublicationPair[] = candidates.flatMap((candidate) => [
    { id: candidate.rawAssetId, label: candidate.label, kind: 'generation-raw' },
    { id: candidate.masterAssetId, label: candidate.label, kind: 'generation-master' },
    { id: candidate.previewAssetId, label: candidate.label, kind: 'generation-preview' },
    { id: candidate.provenanceAssetId, label: candidate.label, kind: 'provenance' },
  ]);
  if (new Set(pairs.map(({ id }) => id)).size !== pairs.length) {
    validation('publication asset IDs must be globally unique', { jobId: input.jobId });
  }

  const manifest: CandidatePublicationManifest = { schemaVersion: 1, candidates };
  const callerDetail = parseInputObjectJson('publication.eventDetailJson', input.eventDetailJson);
  const fingerprint = {
    schemaVersion: 1,
    eventType: 'candidate-publication',
    manifest,
    detail: callerDetail.object,
  } as unknown as Record<string, JsonValue>;
  return {
    manifest,
    manifestJson: JSON.stringify(manifest),
    fingerprintJson: canonicalStringify(fingerprint, (reason) =>
      validation(`publication fingerprint ${reason}`, { jobId: input.jobId }),
    ),
    pairs,
  };
}
