import { generationSpecSchema, type NormalizedGenerationSpec } from '../../src/twi/domain/schemas';
import type { JobPhase, JobStatus } from '../../src/twi/domain/types';
import { D1TwiRepository } from '../../src/twi/server/repository';
import type {
  AppendCostInput,
  JobRecord,
  PublishCandidatesInput,
  PublishCandidatesResult,
  RegisterAssetInput,
  RegisterAssetResult,
  TransitionJobResult,
} from '../../src/twi/server/repository-types';
import { findJobById } from '../../src/twi/server/queries';
import { specSha256 } from '../../src/twi/server/spec-digest';
import { assertAllProvisional, assertFrozenJobMatchesPayload } from './publication-guards';
import type { StartPayload } from './workflow';

export interface FrozenJob {
  job: JobRecord;
  spec: NormalizedGenerationSpec;
}

interface StoredSpecRow {
  spec_json: string;
  spec_sha256: string;
}

/** A narrow orchestration adapter; all writes remain owned by D1TwiRepository. */
export class TwiWorkflowStore {
  private readonly repository: D1TwiRepository;

  constructor(private readonly database: D1Database) {
    this.repository = new D1TwiRepository({ DB: database });
  }

  async loadFrozenJob(payload: StartPayload): Promise<FrozenJob> {
    const job = await findJobById(this.database, payload.jobId);
    if (!job) throw new Error('workflow job was not found');
    assertFrozenJobMatchesPayload(job, payload);

    const row = await this.database
      .prepare(
        `SELECT spec_json, spec_sha256
         FROM twi_generation_specs
         WHERE id = ? AND project_id = ?`,
      )
      .bind(payload.specId, payload.projectId)
      .first<StoredSpecRow>();
    if (!row || row.spec_sha256 !== payload.specSha256) {
      throw new Error('workflow specification digest does not match');
    }

    const spec = generationSpecSchema.parse(JSON.parse(row.spec_json));
    if ((await specSha256(JSON.stringify(spec))) !== payload.specSha256) {
      throw new Error('workflow specification content does not match its digest');
    }
    return { job, spec };
  }

  transition(
    jobId: string,
    attempt: number,
    fromStatus: JobStatus,
    toStatus: Exclude<JobStatus, 'complete'>,
    phase: JobPhase,
    now: string,
  ): Promise<TransitionJobResult> {
    return this.repository.transitionJob(jobId, toStatus, {
      fromStatus,
      phase,
      retryCheckpoint: null,
      now,
      eventKey: `${jobId}:${attempt}:${toStatus}`,
      detailJson: JSON.stringify({ schemaVersion: 1, attempt }),
    });
  }

  registerAsset(input: RegisterAssetInput): Promise<RegisterAssetResult> {
    return this.repository.registerAsset(input);
  }

  appendProviderCost(input: AppendCostInput): Promise<void> {
    return this.repository.appendCost(input).then(() => undefined);
  }

  async assertAssetsProvisional(projectId: string, jobId: string, assetIds: string[]): Promise<void> {
    const placeholders = assetIds.map(() => '?').join(', ');
    const row = await this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM twi_assets
         WHERE project_id = ? AND job_id = ? AND lifecycle_state = 'provisional'
           AND id IN (${placeholders})`,
      )
      .bind(projectId, jobId, ...assetIds)
      .first<{ count: number }>();
    assertAllProvisional(row?.count, assetIds.length);
  }

  publish(input: PublishCandidatesInput): Promise<PublishCandidatesResult> {
    return this.repository.publishCandidates(input);
  }
}
