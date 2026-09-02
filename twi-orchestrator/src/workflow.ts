import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

import type { CostEstimate, GenerationSpec } from '../../src/twi/domain/types';
import type { CandidatePublicationEntry, RegisterAssetInput } from '../../src/twi/server/repository-types';
import { TwiWorkflowStore } from './db';
import {
  assertCallbackBindsCall,
  assertFinishManifest,
  expectedFinishKeys,
  parseFinishCallback,
  type FinishCallRecord,
  type RenditionName,
  type ValidatedRendition,
} from './finishing/manifest';
import { readFinishingConfig, submitFinish } from './finishing/modal';
import { canCompleteRender, createProvider, mustNotRetry } from './providers/select';
import {
  assertBothCandidatesValidated,
  assertProvenance,
  assertRawWavIntegrity,
  assertStoredObject,
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
  /** Absolute https URL of Modal's `POST /finish/jobs`. */
  TWI_MODAL_FINISH_URL?: string;
  /** This Worker's public https origin, which Modal fetches the raw from and posts back to. */
  TWI_CALLBACK_ORIGIN?: string;
  /** The `X-Stems-Secret` shared with the Modal app, both directions. */
  STEMS_PROXY_SECRET?: string;
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
  ffmpegVersion: string;
  commandDigest: string;
  archive: ObjectManifest;
  review: ObjectManifest;
}

const STEP_CONFIG = { retries: { limit: 0, delay: '1 second' as const } };
const LOAD_STEP_CONFIG = { retries: { limit: 5, delay: '1 second' as const, backoff: 'exponential' as const } };
/*
 * The submission is the ONE step here that talks to a third party over the network, so it is
 * the one step that gets a retry policy: a transient 502 from Modal's front door must not cost
 * a paid render. Three attempts with exponential backoff is what the plan specifies.
 */
const SUBMIT_FINISH_CONFIG = {
  retries: { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const },
};
/*
 * How long a finishing callback may take to arrive. `finish_job` is declared with a 30-minute
 * timeout on the Modal side (stems-gpu/app.py), so waiting longer than that would be waiting
 * for a call that can no longer be running.
 */
const FINISH_EVENT_TIMEOUT = '30 minutes' as const;
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

/**
 * Reads an object a DIFFERENT machine wrote, checks it against what the finishing manifest
 * claimed, and derives the digest the asset row needs.
 *
 * The manifest carries no checksum -- `stems-gpu/finish.py` probes duration, size, rate and
 * loudness and never hashes -- and `twi_assets.sha256` is NOT NULL. So the digest is computed
 * HERE, over the bytes actually stored, which also makes it a digest of the object that will
 * be served rather than of one Modal says it uploaded.
 */
const adoptFinishedObject = async (
  bucket: R2Bucket,
  id: string,
  rendition: ValidatedRendition,
): Promise<ObjectManifest> => {
  const object = await bucket.get(rendition.key);
  const bytes = object ? new Uint8Array(await object.arrayBuffer()) : null;
  assertStoredObject({
    key: rendition.key,
    contentType: rendition.contentType,
    sizeBytes: rendition.sizeBytes,
    storedContentType: object ? (object.httpMetadata?.contentType ?? null) : null,
    storedSizeBytes: bytes ? bytes.byteLength : null,
  });
  return {
    id,
    key: rendition.key,
    contentType: rendition.contentType,
    sizeBytes: bytes!.byteLength,
    sha256: await sha256Hex(bytes!),
    durationSeconds: rendition.durationSeconds,
  };
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
       * Refuse BEFORE the first billable call, not at `finish`. Finishing now runs on Modal,
       * so a deployment with no Modal finishing configured would otherwise buy two candidates
       * and then have nowhere to send them.
       */
      if (!canCompleteRender(this.env.TWI_PROVIDER_MODE, readFinishingConfig(this.env))) {
        throw new NonRetryableError('finishing_not_configured');
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

    await step.do('begin-finishing', STEP_CONFIG, async () => {
      await store.transition(payload.jobId, payload.attempt, 'ingesting', 'finishing', 'finishing', now);
      return { phase: 'finishing' as const };
    });

    /*
     * ONE CPU JOB PER CANDIDATE, ON SEPARATE PATHS. Both submissions go out before either wait
     * begins, so A and B are finished CONCURRENTLY on Modal; a submit-wait-submit-wait shape
     * would read the same in the plan and serialise them. The paths are coupled only at
     * `publish`, which is atomic.
     */
    const submit = (raw: RawCandidateManifest): Promise<FinishCallRecord> =>
      step.do(`submit-finish-${raw.label}`, SUBMIT_FINISH_CONFIG, async () => {
        const config = readFinishingConfig(this.env);
        if (config === null) throw new NonRetryableError('finishing_not_configured');
        const prefix = objectPrefix(payload, raw.label);
        /*
         * Minted HERE, once, and durable: a step result is replayed rather than recomputed, so
         * a retried Workflow addresses the same callback identity instead of orphaning one.
         */
        const callbackId = crypto.randomUUID();
        const nonce = crypto.randomUUID();
        const { callId } = await submitFinish(config, {
          jobId: payload.jobId,
          attempt: payload.attempt,
          label: raw.label,
          prefix,
          rawKey: raw.key,
          callbackId,
          nonce,
        });
        return {
          jobId: payload.jobId,
          attempt: payload.attempt,
          label: raw.label,
          prefix,
          callId,
          callbackId,
          nonce,
          rawSizeBytes: raw.sizeBytes,
          rawDurationSeconds: raw.durationSeconds,
        };
      });

    const calls = { A: await submit(rawA), B: await submit(rawB) };

    const awaitCandidate = async (label: CandidateLabel): Promise<FinishedCandidateManifest> => {
      const call = calls[label];
      /*
       * The event payload is the callback envelope as JSON TEXT, not as an object. Two
       * reasons, and the second is the load-bearing one: `waitForEvent` is typed over
       * `Rpc.Serializable`, which an open `Record<string, unknown>` does not satisfy; and the
       * Workflow re-parses and re-validates the envelope itself rather than trusting the shape
       * the route happened to forward. The route's checks are about AUTHENTICITY; these are
       * about whether this is the call we are waiting on.
       */
      const event = await step.waitForEvent<{ envelopeJson: string }>(`wait-finish-${label}`, {
        type: `modal-finished-${label}`,
        timeout: FINISH_EVENT_TIMEOUT,
      });
      return step.do(`validate-${label}`, STEP_CONFIG, async () => {
        const envelope = parseFinishCallback(JSON.parse(event.payload.envelopeJson) as unknown);
        assertCallbackBindsCall(call, envelope);
        const renditions = assertFinishManifest(call, envelope.manifest!);
        const finishedKeys: Record<RenditionName, string> = expectedFinishKeys(call.prefix);
        if (renditions.raw.key !== finishedKeys.raw) throw new Error('finish manifest is invalid');
        return {
          label,
          ffmpegVersion: String(envelope.manifest!.ffmpeg_version),
          commandDigest: String(envelope.manifest!.command_digest),
          archive: await adoptFinishedObject(this.env.FILES, assetId(payload, label, 'master'), renditions.archive),
          review: await adoptFinishedObject(this.env.FILES, assetId(payload, label, 'preview'), renditions.review),
        };
      });
    };

    const finishedA = await awaitCandidate('A');
    const finishedB = await awaitCandidate('B');
    const finished: [FinishedCandidateManifest, FinishedCandidateManifest] = [finishedA, finishedB];

    const validated = await step.do('persist-finished', STEP_CONFIG, async () => {
      const assetIds: string[] = [];
      const entries: CandidatePublicationEntry[] = [];
      for (const [index, candidate] of finished.entries()) {
        const raw = raws[index]!;
        const rawBytes = await getObjectBytes(this.env.FILES, raw);
        assertRawWavIntegrity(rawBytes);

        const provenanceDocument = {
          schemaVersion: 1,
          label: raw.label,
          provider: raw.provider,
          model: raw.model,
          durationSeconds: raw.durationSeconds,
          providerCostUsd: raw.providerCostUsd,
          providerRequestId: raw.providerRequestId,
          specSha256: payload.specSha256,
          finishing: {
            callId: calls[raw.label].callId,
            ffmpegVersion: candidate.ffmpegVersion,
            commandDigest: candidate.commandDigest,
            archiveKey: candidate.archive.key,
            reviewKey: candidate.review.key,
          },
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
        await this.env.FILES.put(provenance.key, provenanceBytes, {
          httpMetadata: { contentType: provenance.contentType },
        });

        await store.registerAsset(
          registerInput(payload, raw.label, 'generation-master', candidate.archive, provenance.key, now),
        );
        await store.registerAsset(
          registerInput(payload, raw.label, 'generation-preview', candidate.review, provenance.key, now),
        );
        await store.registerAsset(registerInput(payload, raw.label, 'provenance', provenance, null, now));

        const provenanceObject = await this.env.FILES.get(provenance.key);
        assertProvenance({
          contentType: provenanceObject?.httpMetadata?.contentType,
          text: provenanceObject ? await provenanceObject.text() : null,
          label: candidate.label,
          providerRequestId: raw.providerRequestId,
          specSha256: payload.specSha256,
        });

        assetIds.push(raw.id, candidate.archive.id, candidate.review.id, provenance.id);
        entries.push({
          label: candidate.label,
          rawAssetId: raw.id,
          masterAssetId: candidate.archive.id,
          previewAssetId: candidate.review.id,
          provenanceAssetId: provenance.id,
        });
      }
      await store.assertAssetsProvisional(payload.projectId, payload.jobId, assetIds);
      await store.transition(payload.jobId, payload.attempt, 'finishing', 'validating', 'validating', now);
      return {
        labels: finished.map(({ label }) => label) as [CandidateLabel, CandidateLabel],
        candidates: entries as [CandidatePublicationEntry, CandidatePublicationEntry],
      };
    });

    return step.do('publish', STEP_CONFIG, async () => {
      assertBothCandidatesValidated(validated.labels);
      const candidates = validated.candidates;
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
