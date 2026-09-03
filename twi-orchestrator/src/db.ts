import { generationSpecSchema, type NormalizedGenerationSpec } from '../../src/twi/domain/schemas';
import type { JobPhase, JobStatus } from '../../src/twi/domain/types';
import { D1TwiRepository } from '../../src/twi/server/repository';
import type {
  ClaimProviderCallInput,
  ClaimProviderCallResult,
  SettleProviderCallInput,
  SettleProviderCallResult,
} from '../../src/twi/server/provider-call-types';
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

/**
 * How a Modal finishing callback is recorded, and why the answer is a WORD rather than a
 * boolean. `unknown-job` and `replayed` are different HTTP answers -- 404 and 200 -- and a
 * boolean would have to be read alongside a second lookup to tell them apart.
 */
export type CallbackReceiptOutcome = 'recorded' | 'replayed' | 'unknown-job';

export interface FinishCallbackReceipt {
  jobId: string;
  attempt: number;
  label: string;
  callbackId: string;
  nonce: string;
  callId: string;
  /** ISO-8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SS.sssZ`, generated in JS. */
  now: string;
}

/**
 * A narrow orchestration adapter. Every write that changes a JOB's state is still owned by
 * D1TwiRepository; the one exception is `recordFinishCallback` below, and the reason is
 * recorded there.
 */
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

  /**
   * The provider-call ledger (research P0). Two writes, both owned by D1TwiRepository and merely
   * reached through here: the claim BEFORE the billable call and the settlement immediately after.
   * `generate-step.ts` is the only caller, and the order it calls them in is the whole point.
   */
  claimProviderCall(input: ClaimProviderCallInput): Promise<ClaimProviderCallResult> {
    return this.repository.claimProviderCall(input);
  }

  settleProviderCall(input: SettleProviderCallInput): Promise<SettleProviderCallResult> {
    return this.repository.settleProviderCall(input);
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

  /**
   * Records that a Modal finishing callback arrived, and refuses a replay BY THE DATABASE.
   *
   * WHY THE CALLBACK ID IS IN THE EVENT KEY. `twi_job_events.event_key` is `NOT NULL` with
   * `UNIQUE (job_id, event_key)` and no default, so a second callback carrying the same id
   * cannot insert -- it is refused by a constraint rather than detected by parsing JSON out of
   * `detail_json`, which is what an earlier draft of the plan proposed and what its own
   * shipped-state correction withdrew.
   *
   * WHY THIS ONE WRITE IS NOT ROUTED THROUGH D1TwiRepository. The repository's only
   * event-writing entry point is `transitionJob`, which writes an event *and* a guarded status
   * change, and refuses any pair `assertTransition` forbids. `finishing -> finishing` is
   * forbidden (src/twi/domain/job-state.ts) and there are TWO callbacks against ONE status, so
   * a callback receipt cannot be a transition without either inventing a self-edge in the job
   * state machine or collapsing the two candidates into one event. Both are worse. This is
   * therefore a status-NEUTRAL audit row -- `from_status` NULL marks it as an observation
   * rather than a transition -- and the two invariants a repository write would have enforced
   * are enforced by the schema itself on this path: `detail_json` is CHECKed to be a JSON
   * object and `created_at` is CHECKed to be `YYYY-MM-DDTHH:MM:SS.sssZ`, so a malformed value
   * is refused at write time exactly as it would be through the repository.
   */
  async recordFinishCallback(receipt: FinishCallbackReceipt): Promise<CallbackReceiptOutcome> {
    const job = await findJobById(this.database, receipt.jobId);
    if (!job) return 'unknown-job';

    const result = await this.database
      .prepare(
        `INSERT INTO twi_job_events (job_id, event_key, from_status, to_status, phase, detail_json, created_at)
         VALUES (?, ?, NULL, 'finishing', 'finishing', ?, ?)
         ON CONFLICT(job_id, event_key) DO NOTHING`,
      )
      .bind(
        receipt.jobId,
        `${receipt.jobId}:${receipt.attempt}:finish-callback:${receipt.callbackId}`,
        JSON.stringify({
          schemaVersion: 1,
          attempt: receipt.attempt,
          label: receipt.label,
          callId: receipt.callId,
          nonce: receipt.nonce,
        }),
        receipt.now,
      )
      .run();

    return result.meta.changes === 1 ? 'recorded' : 'replayed';
  }
}
