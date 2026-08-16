import { parseStoredObjectJson } from './canonical-json';
import type {
  AssetRecord,
  AssetRow,
  JobRecord,
  JobRow,
  ProjectRecord,
  ProjectRow,
} from './repository-types';

export function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    currentRevisionId: row.current_revision_id,
    lifecycleState: row.lifecycle_state,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    specId: row.spec_id,
    specSha256: row.spec_sha256,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    workflowId: row.workflow_id,
    provider: row.provider,
    model: row.model,
    idempotencyKey: row.idempotency_key,
    estimate: parseStoredObjectJson(row.estimate_json, `twi_jobs ${row.id} estimate_json`, true),
    actualCostUsd: row.actual_cost_usd,
    outputManifest: parseStoredObjectJson(
      row.output_manifest_json,
      `twi_jobs ${row.id} output_manifest_json`,
      true,
    ),
    retryCheckpoint: row.retry_checkpoint,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function mapAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind,
    label: row.label,
    r2Key: row.r2_key,
    contentType: row.content_type,
    bytes: row.bytes,
    durationSeconds: row.duration_seconds,
    sha256: row.sha256,
    provenanceKey: row.provenance_key,
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}
