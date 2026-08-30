import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import type { CostEstimate, GenerationSpec } from '../../src/twi/domain/types';
import type { CandidatePublicationEntry, RegisterAssetInput } from '../../src/twi/server/repository-types';
import { TwiWorkflowStore } from './db';
import { canCompleteRender, createProvider, mustNotRetry } from './providers/select';
import {
  assertBothCandidatesValidated,
  assertCandidateAudio,
  assertProvenance,
  assertWavHeader,
} from './publication-guards';
import type { CandidateLabel, MusicProvider, ProviderCandidate } from './providers/types';

export interface StartPayload {
  schemaVersion: 1;
  jobId: string;
  projectId: string;
  specId: string;
  specSha256: string;
  idempotencyKey: string;
  attempt: number;
  estimate: CostEstimate | Record<string, unknown> | null;
}

export interface OrchestratorEnv {
  DB: D1Database;
  FILES: R2Bucket;
  TWI_RENDER_WORKFLOW: Workflow<StartPayload>;
  TWI_RENDER_QUEUE: Queue;
  TWI_PROVIDER_MODE?: string;
  GEMINI_API_KEY?: string;
}

interface ObjectManifest {
  id: string;
  key: string;
  contentType: string;
  /**
   * The SIZE of the object, never its content. Named `sizeBytes` rather than `bytes`
   * because a Workflow step result is durable state that crosses a step boundary, and a
   * field called `bytes` is one careless edit away from carrying the audio itself. The
   * integration test forbids the NAME on a step result for exactly that reason, and
   * backs it with a 1 KiB ceiling on the serialized manifest.
   */
  sizeBytes: number;
  sha256: string;
  durationSeconds: number | null;
}

interface RawCandidateManifest extends ObjectManifest {
  label: CandidateLabel;
  provider: string;
  model: string;
  providerCostUsd: number;
  providerRequestId: string;
  provenanceKey: string;
}

interface FinishedCandidateManifest {
  label: CandidateLabel;
  provider: string;
  model: string;
  providerCostUsd: number;
  providerRequestId: string;
  raw: ObjectManifest;
  master: ObjectManifest;
  preview: ObjectManifest;
  provenance: ObjectManifest;
}

const STEP_CONFIG = { retries: { limit: 0, delay: '1 second' as const } };
const LOAD_STEP_CONFIG = { retries: { limit: 5, delay: '1 second' as const, backoff: 'exponential' as const } };
const encoder = new TextEncoder();

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const objectPrefix = (payload: StartPayload, label: CandidateLabel): string =>
  `twi/${payload.projectId}/jobs/${payload.jobId}/attempt-${payload.attempt}/${label}`;

const assetId = (payload: StartPayload, label: CandidateLabel, kind: string): string =>
  `${payload.jobId}:${payload.attempt}:${label}:${kind}`;

const getObjectBytes = async (bucket: R2Bucket, manifest: ObjectManifest): Promise<Uint8Array> => {
  const object = await bucket.get(manifest.key);
  if (!object) throw new Error('candidate object is missing');
  if (object.httpMetadata?.contentType !== manifest.contentType) throw new Error('candidate content type is invalid');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== manifest.sizeBytes || (await sha256Hex(bytes)) !== manifest.sha256) {
    throw new Error('candidate object integrity check failed');
  }
  return bytes;
};

const registerInput = (
  payload: StartPayload,
  label: CandidateLabel,
  kind: RegisterAssetInput['kind'],
  manifest: ObjectManifest,
  provenanceKey: string | null,
  now: string,
): RegisterAssetInput => ({
  id: manifest.id,
  projectId: payload.projectId,
  jobId: payload.jobId,
  kind,
  label,
  r2Key: manifest.key,
  contentType: manifest.contentType,
  bytes: manifest.sizeBytes, //   `bytes` is the twi_assets COLUMN name; the manifest field is not
  durationSeconds: manifest.durationSeconds,
  sha256: manifest.sha256,
  provenanceKey,
  lifecycleState: 'provisional',
  createdAt: now,
  deletedAt: null,
});

const selectProvider = (env: OrchestratorEnv): MusicProvider | null =>
  createProvider({ mode: env.TWI_PROVIDER_MODE, apiKey: env.GEMINI_API_KEY });

export class TwiRenderWorkflow extends WorkflowEntrypoint<OrchestratorEnv, StartPayload> {
  async run(event: Readonly<WorkflowEvent<StartPayload>>, step: WorkflowStep): Promise<unknown> {
    const payload = event.payload;
    const now = event.timestamp.toISOString();
    const store = new TwiWorkflowStore(this.env.DB);

    /*
     * The step returns a PLAIN GenerationSpec, not the branded NormalizedGenerationSpec
     * the store hands back. The brand is a compile-time witness that the value came out
     * of generationSpecSchema; a step result is serialized into durable storage and read
     * back as JSON, so on the far side of this boundary that witness is no longer true.
     * Dropping it here is more honest than carrying it across -- and Rpc.Serializable
     * rejects the unique symbol anyway, which is the type system saying the same thing.
     */
    const loaded = await step.do<{ spec: GenerationSpec }>('load-job', LOAD_STEP_CONFIG, async () => {
      if (selectProvider(this.env) === null) {
        throw new NonRetryableError('provider_not_configured');
      }
      /*
       * Refuse BEFORE the first billable call, not at `finish`: this build can only finish
       * the fake path, so starting a paid render here would buy two candidates and then
       * fail. See canCompleteRender -- Task 11 is what makes 'lyria' finishable.
       */
      if (!canCompleteRender(this.env.TWI_PROVIDER_MODE)) {
        throw new NonRetryableError('finishing_not_implemented');
      }
      const frozen = await store.loadFrozenJob(payload);
      if (frozen.job.status !== 'queued' && frozen.job.status !== 'generating') {
        throw new Error('workflow job is not queued yet');
      }
      await store.transition(payload.jobId, payload.attempt, 'queued', 'generating', 'generating', now);
      return { spec: frozen.spec as GenerationSpec };
    });

    const generate = (label: CandidateLabel): Promise<RawCandidateManifest> =>
      step.do(`generate-${label}`, STEP_CONFIG, async () => {
        const candidate: ProviderCandidate = await this.callProvider(loaded.spec, label);
        const prefix = objectPrefix(payload, label);
        const key = `${prefix}/raw.wav`;
        const provenanceKey = `${prefix}/provenance.json`;
        const sha256 = await sha256Hex(candidate.bytes);
        await this.env.FILES.put(key, candidate.bytes, {
          httpMetadata: { contentType: candidate.contentType },
          customMetadata: {
            provider: candidate.provider,
            model: candidate.model,
            providerRequestId: candidate.providerRequestId,
          },
        });
        return {
          id: assetId(payload, label, 'raw'),
          key,
          contentType: candidate.contentType,
          sizeBytes: candidate.bytes.byteLength,
          sha256,
          durationSeconds: candidate.durationSeconds,
          label,
          provider: candidate.provider,
          model: candidate.model,
          providerCostUsd: candidate.providerCostUsd,
          providerRequestId: candidate.providerRequestId,
          provenanceKey,
        };
      });

    const rawA = await generate('A');
    const rawB = await generate('B');
    const raws: [RawCandidateManifest, RawCandidateManifest] = [rawA, rawB];

    await step.do('persist-raw', STEP_CONFIG, async () => {
      for (const raw of raws) {
        await store.registerAsset(registerInput(payload, raw.label, 'generation-raw', raw, raw.provenanceKey, now));
        await store.appendProviderCost({
          jobId: payload.jobId,
          idempotencyKey: `${payload.jobId}:${payload.attempt}:provider:${raw.label}`,
          category: 'provider',
          provider: raw.provider,
          model: raw.model,
          amountUsd: raw.providerCostUsd,
          quantity: raw.durationSeconds,
          detailJson: JSON.stringify({
            schemaVersion: 1,
            attempt: payload.attempt,
            label: raw.label,
            providerRequestId: raw.providerRequestId,
          }),
          createdAt: now,
        });
      }
      await store.transition(payload.jobId, payload.attempt, 'generating', 'ingesting', 'ingesting', now);
      return { persisted: raws.map(({ label, id }) => ({ label, rawAssetId: id })) };
    });

    const finished = await step.do('finish', STEP_CONFIG, async () => {
      if (this.env.TWI_PROVIDER_MODE !== 'fake') {
        throw new NonRetryableError('fake finishing is disabled outside explicit fake mode');
      }
      const candidates: FinishedCandidateManifest[] = [];
      for (const raw of raws) {
        const bytes = await getObjectBytes(this.env.FILES, raw);
        assertWavHeader(bytes);
        const prefix = objectPrefix(payload, raw.label);
        const master: ObjectManifest = {
          id: assetId(payload, raw.label, 'master'),
          key: `${prefix}/master.wav`,
          contentType: 'audio/wav',
          sizeBytes: bytes.byteLength,
          sha256: raw.sha256,
          durationSeconds: raw.durationSeconds,
        };
        const preview: ObjectManifest = {
          ...master,
          id: assetId(payload, raw.label, 'preview'),
          key: `${prefix}/preview.wav`,
        };
        const provenanceDocument = {
          schemaVersion: 1,
          label: raw.label,
          provider: raw.provider,
          model: raw.model,
          durationSeconds: raw.durationSeconds,
          providerCostUsd: raw.providerCostUsd,
          providerRequestId: raw.providerRequestId,
          specSha256: payload.specSha256,
        };
        const provenanceBytes = encoder.encode(JSON.stringify(provenanceDocument));
        const provenance: ObjectManifest = {
          id: assetId(payload, raw.label, 'provenance'),
          key: raw.provenanceKey,
          contentType: 'application/json',
          sizeBytes: provenanceBytes.byteLength,
          sha256: await sha256Hex(provenanceBytes),
          durationSeconds: null,
        };

        await Promise.all([
          this.env.FILES.put(master.key, bytes, { httpMetadata: { contentType: master.contentType } }),
          this.env.FILES.put(preview.key, bytes, { httpMetadata: { contentType: preview.contentType } }),
          this.env.FILES.put(provenance.key, provenanceBytes, { httpMetadata: { contentType: provenance.contentType } }),
        ]);
        await store.registerAsset(registerInput(payload, raw.label, 'generation-master', master, provenance.key, now));
        await store.registerAsset(registerInput(payload, raw.label, 'generation-preview', preview, provenance.key, now));
        await store.registerAsset(registerInput(payload, raw.label, 'provenance', provenance, null, now));
        candidates.push({
          label: raw.label,
          provider: raw.provider,
          model: raw.model,
          providerCostUsd: raw.providerCostUsd,
          providerRequestId: raw.providerRequestId,
          raw,
          master,
          preview,
          provenance,
        });
      }
      await store.transition(payload.jobId, payload.attempt, 'ingesting', 'finishing', 'finishing', now);
      return { candidates: candidates as [FinishedCandidateManifest, FinishedCandidateManifest] };
    });

    const validated = await step.do('validate', STEP_CONFIG, async () => {
      await store.transition(payload.jobId, payload.attempt, 'finishing', 'validating', 'validating', now);
      const assetIds: string[] = [];
      for (const candidate of finished.candidates) {
        const raw = await getObjectBytes(this.env.FILES, candidate.raw);
        const master = await getObjectBytes(this.env.FILES, candidate.master);
        const preview = await getObjectBytes(this.env.FILES, candidate.preview);
        assertCandidateAudio({
          raw: { bytes: raw, sha256: candidate.raw.sha256 },
          master: { bytes: master, sha256: candidate.master.sha256 },
          preview: { bytes: preview, sha256: candidate.preview.sha256 },
        });
        const provenanceObject = await this.env.FILES.get(candidate.provenance.key);
        assertProvenance({
          contentType: provenanceObject?.httpMetadata?.contentType,
          text: provenanceObject ? await provenanceObject.text() : null,
          label: candidate.label,
          providerRequestId: candidate.providerRequestId,
          specSha256: payload.specSha256,
        });
        assetIds.push(candidate.raw.id, candidate.master.id, candidate.preview.id, candidate.provenance.id);
      }
      await store.assertAssetsProvisional(payload.projectId, payload.jobId, assetIds);
      return { labels: ['A', 'B'] as [CandidateLabel, CandidateLabel], assetIds };
    });

    return step.do('publish', STEP_CONFIG, async () => {
      assertBothCandidatesValidated(validated.labels);
      const candidates = finished.candidates.map((candidate): CandidatePublicationEntry => ({
        label: candidate.label,
        rawAssetId: candidate.raw.id,
        masterAssetId: candidate.master.id,
        previewAssetId: candidate.preview.id,
        provenanceAssetId: candidate.provenance.id,
      })) as [CandidatePublicationEntry, CandidatePublicationEntry];
      const publication = await store.publish({
        projectId: payload.projectId,
        jobId: payload.jobId,
        candidates,
        eventKey: `${payload.jobId}:${payload.attempt}:complete`,
        eventDetailJson: JSON.stringify({ schemaVersion: 1, attempt: payload.attempt, candidateCount: 2 }),
        now,
      });
      return {
        schemaVersion: 1,
        jobId: payload.jobId,
        attempt: payload.attempt,
        status: publication.job.status,
        candidateAssetIds: candidates,
      };
    });
  }

  /*
   * The provider seam. A ProviderError that might already have been paid for is promoted to
   * NonRetryableError so the step policy cannot buy the same render a second time; anything
   * else keeps the retries it was configured for.
   */
  private async callProvider(spec: GenerationSpec, label: CandidateLabel): Promise<ProviderCandidate> {
    const provider = selectProvider(this.env);
    if (provider === null) throw new NonRetryableError('provider_not_configured');
    try {
      return await provider.generate(spec, label);
    } catch (error) {
      if (mustNotRetry(error)) throw new NonRetryableError((error as { code: string }).code);
      throw error;
    }
  }
}
