import type { CandidatePublicationEntry, PublishCandidatesInput } from './repository-types';

export const normalized = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

export function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sort(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

export const transitionFingerprint = (overrides: Record<string, unknown> = {}): string =>
  stableJson({
    schemaVersion: 1,
    eventType: 'job-transition',
    fromStatus: 'queued',
    toStatus: 'generating',
    phase: 'generating',
    retryCheckpoint: null,
    errorCode: null,
    errorMessage: null,
    detail: { attempt: 1, z: 1 },
    ...overrides,
  });

export const projectRow = {
  id: 'project-1',
  name: 'Night Signal',
  current_revision_id: 'revision-2',
  lifecycle_state: 'active',
  deleted_at: null,
  created_at: '2026-08-16T00:00:00.000Z',
  updated_at: '2026-08-16T01:00:00.000Z',
};

export const jobRow = {
  id: 'job-1',
  project_id: 'project-1',
  spec_id: 'spec-1',
  spec_sha256: 'spec-sha',
  kind: 'full-song',
  status: 'queued',
  phase: 'queued',
  workflow_id: 'workflow-1',
  provider: 'google',
  model: 'lyria-3-pro-preview',
  idempotency_key: 'submission-1',
  estimate_json: '{"total":1.25}',
  actual_cost_usd: 0.75,
  output_manifest_json: null,
  retry_checkpoint: null,
  error_code: null,
  error_message: null,
  created_at: '2026-08-16T00:00:00.000Z',
  updated_at: '2026-08-16T01:00:00.000Z',
  finished_at: null,
};

export const assetInput = {
  id: 'asset-a',
  projectId: 'project-1',
  jobId: 'job-1',
  kind: 'generation-master' as const,
  label: 'A',
  r2Key: 'twi/project-1/jobs/job-1/a/master.wav',
  contentType: 'audio/wav',
  bytes: 4096,
  durationSeconds: 122.5,
  sha256: 'abc123',
  provenanceKey: 'twi/project-1/jobs/job-1/a/provenance.json',
  lifecycleState: 'provisional' as const,
  createdAt: '2026-08-16T01:00:00.000Z',
  deletedAt: null,
};

export const assetRow = {
  id: assetInput.id,
  project_id: assetInput.projectId,
  job_id: assetInput.jobId,
  kind: assetInput.kind,
  label: assetInput.label,
  r2_key: assetInput.r2Key,
  content_type: assetInput.contentType,
  bytes: assetInput.bytes,
  duration_seconds: assetInput.durationSeconds,
  sha256: assetInput.sha256,
  provenance_key: assetInput.provenanceKey,
  lifecycle_state: assetInput.lifecycleState,
  created_at: assetInput.createdAt,
  deleted_at: assetInput.deletedAt,
};

export const candidateA: CandidatePublicationEntry = {
  label: 'A',
  rawAssetId: 'a-raw',
  masterAssetId: 'a-master',
  previewAssetId: 'a-preview',
  provenanceAssetId: 'a-provenance',
};

export const candidateB: CandidatePublicationEntry = {
  label: 'B',
  rawAssetId: 'b-raw',
  masterAssetId: 'b-master',
  previewAssetId: 'b-preview',
  provenanceAssetId: 'b-provenance',
};

export const publicationManifest = () => ({ schemaVersion: 1, candidates: [candidateA, candidateB] });

export const publicationFingerprint = (detail: Record<string, unknown> = { candidateCount: 2 }): string =>
  stableJson({
    schemaVersion: 1,
    eventType: 'candidate-publication',
    manifest: publicationManifest(),
    detail,
  });

export const publicationInput = (
  overrides: Partial<PublishCandidatesInput> = {},
): PublishCandidatesInput => ({
  projectId: 'project-1',
  jobId: 'job-1',
  candidates: [candidateA, candidateB],
  eventKey: 'job-1:complete',
  eventDetailJson: '{"candidateCount":2}',
  now: '2026-08-16T05:00:00.000Z',
  ...overrides,
});

export const completeJobRow = () => ({
  ...jobRow,
  status: 'complete',
  phase: 'complete',
  output_manifest_json: JSON.stringify(publicationManifest()),
  finished_at: '2026-08-16T05:00:00.000Z',
});

export const publicationEventRow = (detail?: Record<string, unknown>) => ({
  event_key: 'job-1:complete',
  from_status: 'validating',
  to_status: 'complete',
  phase: 'complete',
  detail_json: publicationFingerprint(detail),
  created_at: '2026-08-16T05:00:00.000Z',
});
