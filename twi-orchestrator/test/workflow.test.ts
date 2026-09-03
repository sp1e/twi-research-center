import { env, exports } from 'cloudflare:workers';
import { introspectWorkflow } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { draft } from '../../src/twi/domain/spec.fixture';
import { specSha256 } from '../../src/twi/server/spec-digest';
import { createSineWav } from '../src/audio/wav';
import type { StartPayload } from '../src/workflow';

const NOW = '2026-08-29T12:00:00.000Z';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SPEC_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';
const ESTIMATE = { currency: 'USD', provider: 0, finishing: 0, storage: 0, total: 0, estimatedSeconds: 30 };
const SPEC = { ...draft, intent: { ...draft.intent, durationSeconds: 30 } };

/** Mirrors the three values vitest.config.ts hands the Worker and the outbound stub. */
const SECRET = 'test-stems-proxy-secret-0123456789';
const ORIGIN = 'https://twi-orchestrator.invalid';

const RAW = {
  A: createSineWav({ seconds: 30, frequencyHz: 220, sampleRate: 8_000 }),
  B: createSineWav({ seconds: 30, frequencyHz: 277.18, sampleRate: 8_000 }),
} as const;

type CandidateLabel = 'A' | 'B';

type WorkerFetcher = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  (exports.default as unknown as WorkerFetcher).fetch(`https://twi-orchestrator.internal${path}`, init);

const json = async <T>(response: Response): Promise<T> => response.json<T>();

async function clearBindings(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM twi_provider_calls'),
    env.DB.prepare('DELETE FROM twi_job_events'),
    env.DB.prepare('DELETE FROM twi_cost_events'),
    env.DB.prepare('DELETE FROM twi_assets'),
    env.DB.prepare('DELETE FROM twi_jobs'),
    env.DB.prepare('DELETE FROM twi_generation_specs'),
    env.DB.prepare('DELETE FROM twi_project_revisions'),
    env.DB.prepare('DELETE FROM twi_projects'),
  ]);
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ cursor });
    await Promise.all(page.objects.map(({ key }) => env.FILES.delete(key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function seedJob(status: 'estimated' | 'queued' = 'queued'): Promise<StartPayload> {
  const specJson = JSON.stringify(SPEC);
  const digest = await specSha256(specJson);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at)
       VALUES (?, 'Workflow test', 'active', ?, ?)`,
    ).bind(PROJECT_ID, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO twi_generation_specs
         (id, project_id, spec_json, spec_sha256, rights_assertion_version, created_at)
       VALUES (?, ?, ?, ?, 'v1', ?)`,
    ).bind(SPEC_ID, PROJECT_ID, specJson, digest, NOW),
    env.DB.prepare(
      `INSERT INTO twi_jobs
         (id, project_id, spec_id, kind, status, phase, provider, model, idempotency_key,
          estimate_json, actual_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, 'full-song', ?, ?, 'fake', 'deterministic-sine-v1', ?, ?, 0, ?, ?)`,
    ).bind(
      JOB_ID,
      PROJECT_ID,
      SPEC_ID,
      status,
      status === 'queued' ? 'queued' : null,
      IDEMPOTENCY_KEY,
      JSON.stringify(ESTIMATE),
      NOW,
      NOW,
    ),
  ]);
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    specId: SPEC_ID,
    specSha256: digest,
    idempotencyKey: IDEMPOTENCY_KEY,
    attempt: 0,
    estimate: ESTIMATE,
  };
}

const start = (payload: StartPayload): Promise<Response> =>
  fetchWorker('/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

const queryAll = async <T>(sql: string): Promise<T[]> => (await env.DB.prepare(sql).all<T>()).results;

/* -------------------------------------------------------------------------------------------
 * Standing in for Modal.
 *
 * The outbound stub in vitest.config.ts accepts the submission; everything a real finishing job
 * would do AFTER that -- write archive.flac and review.mp3 to R2, then POST the callback -- is
 * done here, in the test, so a test can choose to do it wrong.
 * ---------------------------------------------------------------------------------------- */

interface SubmittedCall {
  jobId: string;
  attempt: number;
  label: CandidateLabel;
  prefix: string;
  callId: string;
  callbackId: string;
  nonce: string;
  rawSizeBytes: number;
  rawDurationSeconds: number | null;
}

const bytesOf = (size: number, seed: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_value, index) => (index * 31 + seed) % 251);

/** Writes what Modal would have uploaded, and returns the manifest it would have reported. */
async function finishOnFakeModal(
  call: SubmittedCall,
  options: { manifest?: (base: Record<string, unknown>) => Record<string, unknown>; skipReview?: boolean } = {},
): Promise<Record<string, unknown>> {
  const archive = bytesOf(2_048, call.label === 'A' ? 3 : 7);
  const review = bytesOf(4_096, call.label === 'A' ? 11 : 13);
  await env.FILES.put(`${call.prefix}/archive.flac`, archive, { httpMetadata: { contentType: 'audio/flac' } });
  if (!options.skipReview) {
    await env.FILES.put(`${call.prefix}/review.mp3`, review, { httpMetadata: { contentType: 'audio/mpeg' } });
  }

  const base: Record<string, unknown> = {
    schema_version: 1,
    prefix: call.prefix,
    raw: {
      r2_key: `${call.prefix}/raw.wav`,
      content_type: 'audio/wav',
      bytes: call.rawSizeBytes,
      duration_seconds: 30,
      sample_rate: 8_000,
      channels: 1,
      loudness_target_lufs: null,
    },
    archive: {
      r2_key: `${call.prefix}/archive.flac`,
      content_type: 'audio/flac',
      bytes: archive.byteLength,
      duration_seconds: 30,
      sample_rate: 8_000,
      channels: 1,
      loudness_target_lufs: null,
      integrated_lufs: -23.7,
      true_peak_dbtp: -7.2,
      loudness_range: 12.5,
    },
    review: {
      r2_key: `${call.prefix}/review.mp3`,
      content_type: 'audio/mpeg',
      bytes: review.byteLength,
      duration_seconds: 30,
      sample_rate: 48_000,
      channels: 1,
      loudness_target_lufs: -14,
      integrated_lufs: -14.05,
      true_peak_dbtp: -1.4,
      loudness_range: 9.9,
    },
    ffmpeg_version: 'ffmpeg version 7.1 Copyright (c) 2000-2026',
    command_digest: 'b'.repeat(64),
  };
  return options.manifest ? options.manifest(base) : base;
}

const callbackBody = (call: SubmittedCall, manifest: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  callbackId: call.callbackId,
  nonce: call.nonce,
  timestamp: new Date().toISOString(),
  callId: call.callId,
  jobId: call.jobId,
  attempt: call.attempt,
  label: call.label,
  prefix: call.prefix,
  status: manifest === null ? 'error' : 'done',
  manifest,
  error: manifest === null ? 'finishing failed' : null,
  ...over,
});

const postCallback = (body: unknown, secret: string | null = SECRET): Promise<Response> =>
  fetchWorker('/callback/modal', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'X-Stems-Secret': secret }),
    },
    body: JSON.stringify(body),
  });

describe('TWI render Workflow', () => {
  beforeEach(clearBindings);

  const submittedCalls = async (
    instance: { waitForStepResult(step: { name: string }): Promise<unknown> },
  ): Promise<Record<CandidateLabel, SubmittedCall>> => ({
    A: (await instance.waitForStepResult({ name: 'submit-finish-A' })) as SubmittedCall,
    B: (await instance.waitForStepResult({ name: 'submit-finish-B' })) as SubmittedCall,
  });

  it('finishes each candidate on its own Modal call and atomically publishes the pair', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);

    const response = await start(payload);
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({ ok: true, created: true, instance: { id: `${JOB_ID}_0` } });

    const [instance] = await introspector.get();
    expect(instance).toBeDefined();
    const calls = await submittedCalls(instance!);

    // One finishing job per candidate, each identified by its own Modal call and its own
    // callback identity. Nothing is shared between the two paths.
    expect(calls.A.callId).toBe(`fc-${JOB_ID}-0-A`);
    expect(calls.B.callId).toBe(`fc-${JOB_ID}-0-B`);
    expect(calls.A.callbackId).not.toBe(calls.B.callbackId);
    expect(calls.A.nonce).not.toBe(calls.B.nonce);
    expect(calls.A.nonce).not.toBe(calls.A.callbackId);
    expect(calls.A.prefix).toBe(`twi/${PROJECT_ID}/jobs/${JOB_ID}/attempt-0/A`);

    for (const label of ['A', 'B'] as const) {
      const manifest = await finishOnFakeModal(calls[label]);
      const accepted = await postCallback(callbackBody(calls[label], manifest));
      expect(accepted.status).toBe(200);
      expect(await json(accepted)).toEqual({ ok: true, outcome: 'accepted' });
    }

    for (const name of [
      'load-job',
      'generate-A',
      'generate-B',
      'persist-raw',
      'begin-finishing',
      'submit-finish-A',
      'submit-finish-B',
      'validate-A',
      'validate-B',
      'persist-finished',
      'publish',
    ]) {
      await expect(instance!.waitForStepResult({ name })).resolves.toBeDefined();
    }
    await instance!.waitForStatus('complete');

    for (const label of ['A', 'B'] as const) {
      const manifest = (await instance!.waitForStepResult({ name: `generate-${label}` })) as Record<string, unknown>;
      expect(manifest).not.toHaveProperty('bytes');
      expect(manifest).not.toHaveProperty('audio');
      expect(JSON.stringify(manifest).length).toBeLessThan(1_024);
      const finished = (await instance!.waitForStepResult({ name: `validate-${label}` })) as Record<string, unknown>;
      expect(finished).not.toHaveProperty('audio');
      expect(JSON.stringify(finished).length).toBeLessThan(1_024);
    }

    const [job] = await queryAll<{ status: string; output_manifest_json: string }>(
      `SELECT status, output_manifest_json FROM twi_jobs WHERE id = '${JOB_ID}'`,
    );
    expect(job).toMatchObject({ status: 'complete' });
    expect(JSON.parse(job!.output_manifest_json)).toMatchObject({
      schemaVersion: 1,
      candidates: [{ label: 'A' }, { label: 'B' }],
    });

    const assets = await queryAll<{
      label: 'A' | 'B'; kind: string; r2_key: string; content_type: string; bytes: number;
      duration_seconds: number | null; lifecycle_state: string;
    }>('SELECT label, kind, r2_key, content_type, bytes, duration_seconds, lifecycle_state FROM twi_assets ORDER BY label, kind');
    expect(assets).toHaveLength(8);
    expect(new Set(assets.map(({ lifecycle_state }) => lifecycle_state))).toEqual(new Set(['active']));

    for (const label of ['A', 'B'] as const) {
      const prefix = `twi/${PROJECT_ID}/jobs/${JOB_ID}/attempt-0/${label}`;
      const byKind = Object.fromEntries(assets.filter((a) => a.label === label).map((a) => [a.kind, a]));

      // The three renditions, one purpose each. NOTE the names: archive.flac and review.mp3,
      // never "master" and never "preview" — Task 10 removed that word deliberately.
      expect(byKind['generation-raw']).toMatchObject({ r2_key: `${prefix}/raw.wav`, content_type: 'audio/wav' });
      expect(byKind['generation-master']).toMatchObject({ r2_key: `${prefix}/archive.flac`, content_type: 'audio/flac', bytes: 2_048, duration_seconds: 30 });
      expect(byKind['generation-preview']).toMatchObject({ r2_key: `${prefix}/review.mp3`, content_type: 'audio/mpeg', bytes: 4_096, duration_seconds: 30 });
      expect(byKind['provenance']).toMatchObject({ content_type: 'application/json' });

      const raw = await env.FILES.get(`${prefix}/raw.wav`);
      expect(new Uint8Array(await raw!.arrayBuffer())).toEqual(RAW[label]);
      expect(await env.FILES.get(`${prefix}/master.wav`)).toBeNull();
      expect(await env.FILES.get(`${prefix}/preview.wav`)).toBeNull();

      const provenanceObject = await env.FILES.get(byKind['provenance']!.r2_key);
      expect(JSON.parse(await provenanceObject!.text())).toMatchObject({
        schemaVersion: 1,
        label,
        provider: 'fake',
        providerRequestId: `${payload.specSha256}-${label}`,
        specSha256: payload.specSha256,
        finishing: {
          callId: `fc-${JOB_ID}-0-${label}`,
          ffmpegVersion: 'ffmpeg version 7.1 Copyright (c) 2000-2026',
          commandDigest: 'b'.repeat(64),
          archiveKey: `${prefix}/archive.flac`,
          reviewKey: `${prefix}/review.mp3`,
        },
      });
    }

    // Both callbacks are recorded as their own audit rows, keyed on the callback id, and the
    // status transitions are unchanged.
    const events = await queryAll<{ event_key: string; from_status: string | null; to_status: string }>(
      'SELECT event_key, from_status, to_status FROM twi_job_events ORDER BY id',
    );
    const receipts = events.filter(({ event_key }) => event_key.includes(':finish-callback:'));
    expect(receipts).toHaveLength(2);
    expect(receipts.map(({ event_key }) => event_key).sort()).toEqual(
      [calls.A.callbackId, calls.B.callbackId].map((id) => `${JOB_ID}:0:finish-callback:${id}`).sort(),
    );
    expect(receipts.every(({ from_status }) => from_status === null)).toBe(true);
    expect(events.filter(({ event_key }) => !event_key.includes(':finish-callback:')).map(({ to_status }) => to_status))
      .toEqual(['generating', 'ingesting', 'finishing', 'validating', 'complete']);
  });

  it('treats a duplicate callback as a no-op the database refuses, not a second event', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);

    const manifestA = await finishOnFakeModal(calls.A);
    const body = callbackBody(calls.A, manifestA);
    expect(await json(await postCallback(body))).toEqual({ ok: true, outcome: 'accepted' });

    const replay = await postCallback({ ...body, timestamp: new Date().toISOString() });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual({ ok: true, outcome: 'replayed' });

    expect(await json(await postCallback(callbackBody(calls.B, await finishOnFakeModal(calls.B)))))
      .toEqual({ ok: true, outcome: 'accepted' });
    await instance!.waitForStatus('complete');

    const receipts = await queryAll<{ event_key: string }>(
      `SELECT event_key FROM twi_job_events WHERE event_key LIKE '%:finish-callback:%'`,
    );
    expect(receipts).toHaveLength(2);
  });

  it('refuses a callback that does not present the shared secret, and stays blocked', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);
    const body = callbackBody(calls.A, await finishOnFakeModal(calls.A));

    for (const secret of [null, 'wrong-secret', SECRET.slice(0, -1)]) {
      const refused = await postCallback(body, secret);
      expect(refused.status).toBe(401);
      expect(await json(refused)).toEqual({
        ok: false,
        error: { code: 'callback_unauthorized', message: 'unauthorized' },
      });
    }

    const stale = await postCallback({ ...body, timestamp: '2026-08-29T12:00:00.000Z' });
    expect(stale.status).toBe(401);
    expect(await json(stale)).toMatchObject({ error: { code: 'callback_stale' } });

    expect(await queryAll(`SELECT event_key FROM twi_job_events WHERE event_key LIKE '%:finish-callback:%'`))
      .toHaveLength(0);
    expect(await queryAll(`SELECT id FROM twi_jobs WHERE status = 'complete'`)).toHaveLength(0);
  });

  it('refuses to publish when a callback names a different Modal call than the one submitted', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);

    const forged = callbackBody(calls.A, await finishOnFakeModal(calls.A), { callId: 'fc-somebody-elses-call' });
    expect(await json(await postCallback(forged))).toEqual({ ok: true, outcome: 'accepted' });

    await instance!.waitForStatus('errored');
    expect((await instance!.getError()).message).toContain('callback does not answer this finishing call');
    expect(await queryAll(`SELECT id FROM twi_jobs WHERE status = 'complete'`)).toHaveLength(0);
    expect(await queryAll(`SELECT id FROM twi_assets WHERE lifecycle_state = 'active'`)).toHaveLength(0);
  });

  it('refuses to publish when only one of the two callbacks ever arrives', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.forceEventTimeout({ name: 'wait-finish-B' });
    });
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);

    expect(await json(await postCallback(callbackBody(calls.A, await finishOnFakeModal(calls.A)))))
      .toEqual({ ok: true, outcome: 'accepted' });

    await instance!.waitForStatus('errored');
    expect(await queryAll(`SELECT id FROM twi_jobs WHERE status = 'complete'`)).toHaveLength(0);
    // The raw pair is registered and provisional; nothing finished was ever adopted.
    const assets = await queryAll<{ kind: string; lifecycle_state: string }>('SELECT kind, lifecycle_state FROM twi_assets');
    expect(assets).toHaveLength(2);
    expect(assets.every(({ kind, lifecycle_state }) => kind === 'generation-raw' && lifecycle_state === 'provisional')).toBe(true);
  });

  it('refuses to publish an archive that was given a loudness target', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);

    const mastered = await finishOnFakeModal(calls.A, {
      manifest: (base) => ({ ...base, archive: { ...(base.archive as object), loudness_target_lufs: -14 } }),
    });
    expect(await json(await postCallback(callbackBody(calls.A, mastered)))).toEqual({ ok: true, outcome: 'accepted' });

    await instance!.waitForStatus('errored');
    expect((await instance!.getError()).message).toContain('archive must never carry a loudness target');
    expect(await queryAll(`SELECT id FROM twi_assets WHERE lifecycle_state = 'active'`)).toHaveLength(0);
  });

  it('refuses to publish a review that overshot the true-peak ceiling the shipped code enforces', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);

    // -0.7 dBTP is INSIDE the plan's superseded `-1.5 .. -0.5` window and OUTSIDE what
    // stems-gpu/finish.py accepts. The shipped constant wins.
    const hot = await finishOnFakeModal(calls.A, {
      manifest: (base) => ({ ...base, review: { ...(base.review as object), true_peak_dbtp: -0.7 } }),
    });
    expect(await json(await postCallback(callbackBody(calls.A, hot)))).toEqual({ ok: true, outcome: 'accepted' });

    await instance!.waitForStatus('errored');
    expect((await instance!.getError()).message).toContain('review true peak exceeds the ceiling');
  });

  it('refuses to publish when the manifest describes an object Modal never uploaded', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);

    const manifest = await finishOnFakeModal(calls.A, { skipReview: true });
    expect(await json(await postCallback(callbackBody(calls.A, manifest)))).toEqual({ ok: true, outcome: 'accepted' });

    await instance!.waitForStatus('errored');
    expect((await instance!.getError()).message).toContain('finished object is missing from storage');
  });

  it('refuses to publish a candidate whose finishing job reported an error', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);

    expect(await json(await postCallback(callbackBody(calls.A, null)))).toEqual({ ok: true, outcome: 'accepted' });
    await instance!.waitForStatus('errored');
    expect((await instance!.getError()).message).toContain('finishing failed');
  });

  it('serves the raw candidate to the finishing job, and to nothing else', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);
    const rawPath = `/internal/raw/${calls.A.prefix}/raw.wav`;

    const served = await fetchWorker(rawPath, { headers: { 'X-Stems-Secret': SECRET } });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(RAW.A);

    expect((await fetchWorker(rawPath)).status).toBe(401);
    expect((await fetchWorker(rawPath, { headers: { 'X-Stems-Secret': 'wrong' } })).status).toBe(401);
    expect((await fetchWorker(rawPath, { method: 'POST', headers: { 'X-Stems-Secret': SECRET } })).status).toBe(405);

    // Nothing else in the bucket is reachable through it — not the other renditions, not an
    // escaped traversal, not another product's keys.
    //
    // A LITERAL `../` is deliberately NOT in this list: `new URL()` resolves dot segments
    // before the route ever sees a pathname, so `attempt-0/A/../B/raw.wav` arrives as
    // `attempt-0/B/raw.wav` — a legitimate key that this route is right to serve. The attack
    // that has to be refused is the PERCENT-ENCODED one, which survives normalisation and
    // reaches `decodeURIComponent` intact.
    for (const key of [
      `${calls.A.prefix}/provenance.json`,
      `${calls.A.prefix}/archive.flac`,
      `twi/${PROJECT_ID}/jobs/${JOB_ID}/attempt-0/A/%2E%2E/%2E%2E/%2E%2E/raw.wav`,
      'stems/anything/raw.wav',
      `${calls.A.prefix}/raw.wav.bak`,
    ]) {
      const refused = await fetchWorker(`/internal/raw/${key}`, { headers: { 'X-Stems-Secret': SECRET } });
      expect(refused.status).toBe(404);
    }
  });

  it('keeps every artifact provisional and the job validating when publication fails', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.mockStepError({ name: 'publish' }, new Error('publication unavailable'));
    });

    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);
    for (const label of ['A', 'B'] as const) {
      await postCallback(callbackBody(calls[label], await finishOnFakeModal(calls[label])));
    }
    await instance!.waitForStatus('errored');

    const assets = await queryAll<{ lifecycle_state: string }>('SELECT lifecycle_state FROM twi_assets');
    expect(assets).toHaveLength(8);
    expect(assets.every(({ lifecycle_state }) => lifecycle_state === 'provisional')).toBe(true);
    expect(await queryAll(`SELECT id FROM twi_jobs WHERE status = 'complete'`)).toHaveLength(0);
    expect(await queryAll(`SELECT id FROM twi_jobs WHERE status = 'validating'`)).toHaveLength(1);
  });

  /*
   * The provider-call ledger (research P0), against the REAL Workflow, D1 and R2. Neither test
   * uses introspector.mockStepError: that replaces the step body and would prove nothing about
   * what the body does. The first drives the happy path and reads the ledger back; the second
   * plants the row a crashed earlier execution would have left and shows the re-run refusing to
   * pay -- no provider call reached R2, no cost row, the row untouched.
   */
  it('records both billable calls in twi_provider_calls as completed and charged, request ids included', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    const calls = await submittedCalls(instance!);
    for (const label of ['A', 'B'] as const) {
      await postCallback(callbackBody(calls[label], await finishOnFakeModal(calls[label])));
    }
    await instance!.waitForStatus('complete');

    const ledger = await queryAll<{
      attempt: number; label: string; claim_key: string; state: string; charge_certainty: string;
      provider_mode: string; provider: string; model: string; provider_request_id: string;
      claimed_at: string; settled_at: string; resolved_at: string | null;
    }>('SELECT * FROM twi_provider_calls ORDER BY attempt, label');
    expect(ledger).toHaveLength(2);
    expect(ledger).toEqual(
      ['A', 'B'].map((label) =>
        expect.objectContaining({
          attempt: 0,
          label,
          claim_key: `${JOB_ID}:0:provider-call:${label}`,
          state: 'completed',
          charge_certainty: 'charged',
          provider_mode: 'fake',
          provider: 'fake',
          model: 'deterministic-sine-v1',
          provider_request_id: `${payload.specSha256}-${label}`,
          resolved_at: null,
        }),
      ),
    );
    // Both timestamps are the Workflow's event timestamp -- real, not the seed's NOW -- in the one
    // shape the schema admits, and the settlement never precedes the claim.
    for (const call of ledger) {
      expect(call.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(call.settled_at >= call.claimed_at).toBe(true);
    }
  });

  /*
   * WHAT THIS TEST CAN AND CANNOT SEE. It proves the CONSEQUENCES of the refusal: no R2 object,
   * no cost row, no asset, the planted claim row byte-for-byte as planted, and the job still
   * `generating`. It does NOT prove the ORDER -- the fake provider is a pure function, so this
   * suite has no way to observe whether `generate()` was invoked. Moving the claim to AFTER the
   * provider call leaves every assertion below true (the call is made, the claim then reports
   * already-claimed, the step throws, and the R2 put -- which comes after the settlement -- never
   * runs), and it leaves this whole file green: measured as mutant PCS-06.
   *
   * The order is proven by src/generate-step.test.ts, which records the call sequence against the
   * real ledger, and pinned in the call graph by contract-check section 16
   * ('inside runGenerateStep the claim is written BEFORE the provider is called').
   */
  it('leaves no artifact, no cost row and the planted claim row untouched when the identity is already claimed', async () => {
    const payload = await seedJob();
    // What a crashed earlier execution of generate-A leaves behind: the claim, unsettled.
    await env.DB.prepare(
      `INSERT INTO twi_provider_calls
         (job_id, attempt, label, claim_key, state, charge_certainty, provider_mode, detail_json, claimed_at)
       VALUES (?, 0, 'A', ?, 'submitting', 'unknown', 'fake', '{"planted":true}', ?)`,
    )
      .bind(JOB_ID, `${JOB_ID}:0:provider-call:A`, '2026-08-29T11:59:00.000Z')
      .run();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);

    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    await instance!.waitForStatus('errored');
    // The local engine reports a NonRetryableError generically ("a step threw an NonRetryableError
    // and it was not handled") rather than echoing its message, so the refusal's CODE is proven by
    // the unit suite (generate-step.test.ts) and by the facts below; here only its KIND is visible.
    expect((await instance!.getError()).message).toContain('NonRetryableError');

    // No render was bought: nothing in R2, no cost row, B never claimed.
    expect((await env.FILES.list()).objects.map(({ key }) => key)).toEqual([]);
    expect(await queryAll('SELECT id FROM twi_cost_events')).toHaveLength(0);
    expect(await queryAll('SELECT id FROM twi_assets')).toHaveLength(0);
    const ledger = await queryAll<{ label: string; state: string; charge_certainty: string; claimed_at: string; detail_json: string }>(
      'SELECT label, state, charge_certainty, claimed_at, detail_json FROM twi_provider_calls',
    );
    expect(ledger).toEqual([
      { label: 'A', state: 'submitting', charge_certainty: 'unknown', claimed_at: '2026-08-29T11:59:00.000Z', detail_json: '{"planted":true}' },
    ]);
    expect(await queryAll(`SELECT id FROM twi_jobs WHERE status = 'generating'`)).toHaveLength(1);
  });

  it('does not register or publish a partial generation when candidate B fails', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.mockStepError({ name: 'generate-B' }, new Error('provider failure'));
    });

    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    await instance!.waitForStatus('errored');
    expect(await queryAll('SELECT id FROM twi_assets')).toHaveLength(0);
    expect(await queryAll(`SELECT id FROM twi_jobs WHERE status = 'generating'`)).toHaveLength(1);
    const objects = await env.FILES.list();
    expect(objects.objects.map(({ key }) => key)).toEqual([expect.stringContaining('/A/raw.wav')]);
  });

  it('collapses the same job and attempt while a higher attempt creates a distinct instance', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      // The mocked error must be TERMINAL. load-job retries 5 times with exponential
      // backoff (~31 s), which is right in production for a transient D1 read failure
      // and would blow this test's 20 s budget for a fault that is not transient. The
      // engine skips retries when the error's name is NonRetryableError (or its message
      // starts with it) -- the same escape hatch production code would use for a fatal
      // fault. The production retry policy is deliberately NOT lowered for this test.
      // The name alone does not survive the RPC hop into the binding worker, so the
      // MESSAGE carries the marker too -- the engine accepts either (binding.worker.js:
      // name === 'NonRetryableError' || message.startsWith('NonRetryableError')).
      const fatal = new Error('NonRetryableError: stop after identity');
      fatal.name = 'NonRetryableError';
      await modifier.mockStepError({ name: 'load-job' }, fatal);
    });

    const first = await start(payload);
    const duplicate = await start(payload);
    const higher = await start({ ...payload, attempt: 1 });
    expect(first.status).toBe(202);
    expect(await json(duplicate)).toMatchObject({ ok: true, created: false, instance: { id: `${JOB_ID}_0` } });
    expect(higher.status).toBe(202);

    const instances = await introspector.get();
    expect(instances).toHaveLength(2);
    await Promise.all(instances.map((instance) => instance.waitForStatus('errored')));
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it('rejects malformed attempts before Workflow creation', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    const malformed = [
      (({ attempt: _attempt, ...rest }) => rest)(payload),
      { ...payload, attempt: -1 },
      { ...payload, attempt: 0.5 },
      { ...payload, attempt: '0' },
      { ...payload, extra: true },
    ];

    for (const body of malformed) {
      const response = await fetchWorker('/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ ok: false, error: { code: 'invalid_request', message: 'invalid request envelope' } });
    }
    expect(await introspector.get()).toHaveLength(0);
  });

  it('terminates the exact job-attempt identity requested by cancel', async () => {
    const payload = await seedJob('estimated');
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    expect((await start(payload)).status).toBe(202);
    expect((await start({ ...payload, attempt: 1 })).status).toBe(202);

    const response = await fetchWorker(`/cancel/${encodeURIComponent(JOB_ID)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, jobId: JOB_ID, projectId: PROJECT_ID, attempt: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, instance: { id: `${JOB_ID}_1`, status: 'terminated' } });

    const attempt0 = await env.TWI_RENDER_WORKFLOW.get(`${JOB_ID}_0`);
    const attempt1 = await env.TWI_RENDER_WORKFLOW.get(`${JOB_ID}_1`);
    expect((await attempt1.status()).status).toBe('terminated');
    expect((await attempt0.status()).status).not.toBe('terminated');
  });

  it('validates the callback route before it can reach a Workflow at all', async () => {
    const wrongMethod = await fetchWorker('/start', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(await json(wrongMethod)).toEqual({ ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } });

    expect((await fetchWorker('/callback/modal', { method: 'GET' })).status).toBe(405);

    const noBody = await postCallback('not-an-object');
    expect(noBody.status).toBe(400);
    expect(await json(noBody)).toEqual({ ok: false, error: { code: 'invalid_request', message: 'invalid request envelope' } });

    const unknownCall: SubmittedCall = {
      jobId: JOB_ID,
      attempt: 0,
      label: 'A',
      prefix: `twi/${PROJECT_ID}/jobs/${JOB_ID}/attempt-0/A`,
      callId: 'fc-nothing',
      callbackId: '55555555-5555-4555-8555-555555555555',
      nonce: '66666666-6666-4666-8666-666666666666',
      rawSizeBytes: 1,
      rawDurationSeconds: 30,
    };
    const absent = await postCallback(callbackBody(unknownCall, await finishOnFakeModal(unknownCall)));
    expect(absent.status).toBe(404);
    expect(await json(absent)).toMatchObject({ error: { code: 'instance_not_found' } });

    // Two tokens that are the same token are one token wearing two names.
    const sameTokens = await postCallback(
      callbackBody({ ...unknownCall, nonce: unknownCall.callbackId }, await finishOnFakeModal(unknownCall)),
    );
    expect(sameTokens.status).toBe(401);
    expect(await json(sameTokens)).toMatchObject({ error: { code: 'callback_unidentified' } });
  });
});
