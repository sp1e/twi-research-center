import { NonRetryableError, WorkflowEntrypoint } from 'cloudflare:workers';

import type { CostEstimate } from '../../src/twi/domain/types';
import type { CandidatePublicationEntry, RegisterAssetInput } from '../../src/twi/server/repository-types';
import { TwiWorkflowStore } from './db';
import { DeterministicFakeMusicProvider } from './providers/fake';
import type { CandidateLabel, ProviderCandidate } from './providers/types';

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

const assertWav = (bytes: Uint8Array): void => {
  if (bytes.byteLength < 44) throw new Error('candidate WAV is too short');
  const text = (from: number, to: number) => new TextDecoder().decode(bytes.slice(from, to));
  if (text(0, 4) !== 'RIFF' || text(8, 12) !== 'WAVE' || text(36, 40) !== 'data') {
    throw new Error('candidate WAV header is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(40, true) !== bytes.byteLength - 44) {
    throw new Error('candidate WAV length is invalid');
  }
};

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

export class TwiRenderWorkflow extends WorkflowEntrypoint<OrchestratorEnv, StartPayload> {
  async run(event: Readonly<WorkflowEvent<StartPayload>>, step: WorkflowStep): Promise<unknown> {
    const payload = event.payload;
    const now = event.timestamp.toISOString();
    const store = new TwiWorkflowStore(this.env.DB);

    const loaded = await step.do('load-job', LOAD_STEP_CONFIG, async () => {
      if (this.env.TWI_PROVIDER_MODE !== 'fake') {
        throw new NonRetryableError('provider_not_configured');
      }
      const frozen = await store.loadFrozenJob(payload);
      if (frozen.job.status !== 'queued' && frozen.job.status !== 'generating') {
        throw new Error('workflow job is not queued yet');
      }
      await store.transition(payload.jobId, payload.attempt, 'queued', 'generating', 'generating', now);
      return { spec: frozen.spec };
    });

    const generate = (label: CandidateLabel): Promise<RawCandidateManifest> =>
      step.do(`generate-${label}`, STEP_CONFIG, async () => {
        const candidate: ProviderCandidate = await new DeterministicFakeMusicProvider().generate(loaded.spec, label);
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
        assertWav(bytes);
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
        assertWav(raw);
        assertWav(master);
        assertWav(preview);
        if (candidate.raw.sha256 !== candidate.master.sha256 || candidate.raw.sha256 !== candidate.preview.sha256) {
          throw new Error('fake candidate audio outputs differ');
        }
        const provenanceObject = await this.env.FILES.get(candidate.provenance.key);
        if (!provenanceObject || provenanceObject.httpMetadata?.contentType !== 'application/json') {
          throw new Error('candidate provenance is missing');
        }
        const provenance = JSON.parse(await provenanceObject.text()) as Record<string, unknown>;
        if (
          provenance.providerRequestId !== candidate.providerRequestId ||
          provenance.specSha256 !== payload.specSha256 ||
          provenance.label !== candidate.label
        ) {
          throw new Error('candidate provenance is invalid');
        }
        assetIds.push(candidate.raw.id, candidate.master.id, candidate.preview.id, candidate.provenance.id);
      }
      await store.assertAssetsProvisional(payload.projectId, payload.jobId, assetIds);
      return { labels: ['A', 'B'] as [CandidateLabel, CandidateLabel], assetIds };
    });

    return step.do('publish', STEP_CONFIG, async () => {
      if (validated.labels.join('') !== 'AB') throw new Error('both candidates must validate before publication');
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
}
