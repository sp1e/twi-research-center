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

type WorkerFetcher = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  (exports.default as unknown as WorkerFetcher).fetch(`https://twi-orchestrator.internal${path}`, init);

const json = async <T>(response: Response): Promise<T> => response.json<T>();

async function clearBindings(): Promise<void> {
  await env.DB.batch([
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

describe('TWI render Workflow', () => {
  beforeEach(clearBindings);

  it('runs every named step on the fake path and atomically publishes deterministic playable artifacts', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);

    const response = await start(payload);
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({ ok: true, created: true, instance: { id: `${JOB_ID}_0` } });

    const [instance] = await introspector.get();
    expect(instance).toBeDefined();
    for (const name of ['load-job', 'generate-A', 'generate-B', 'persist-raw', 'finish', 'validate', 'publish']) {
      await expect(instance!.waitForStepResult({ name })).resolves.toBeDefined();
    }
    await instance!.waitForStatus('complete');

    for (const label of ['A', 'B'] as const) {
      const manifest = await instance!.waitForStepResult({ name: `generate-${label}` }) as Record<string, unknown>;
      expect(manifest).not.toHaveProperty('bytes');
      expect(manifest).not.toHaveProperty('audio');
      expect(JSON.stringify(manifest).length).toBeLessThan(1_024);
    }

    const status = await fetchWorker(`/status/${encodeURIComponent(`${JOB_ID}_0`)}`);
    expect(status.status).toBe(200);
    expect(await json(status)).toEqual({ ok: true, instance: { id: `${JOB_ID}_0`, status: 'complete' } });

    const [job] = await queryAll<{ status: string; actual_cost_usd: number; output_manifest_json: string }>(
      `SELECT status, actual_cost_usd, output_manifest_json FROM twi_jobs WHERE id = '${JOB_ID}'`,
    );
    expect(job).toMatchObject({ status: 'complete', actual_cost_usd: 0 });
    expect(JSON.parse(job!.output_manifest_json)).toMatchObject({ schemaVersion: 1, candidates: [{ label: 'A' }, { label: 'B' }] });

    const assets = await queryAll<{
      label: 'A' | 'B'; kind: string; r2_key: string; content_type: string; bytes: number;
      duration_seconds: number | null; lifecycle_state: string; sha256: string;
    }>('SELECT label, kind, r2_key, content_type, bytes, duration_seconds, lifecycle_state, sha256 FROM twi_assets ORDER BY label, kind');
    expect(assets).toHaveLength(8);
    expect(new Set(assets.map(({ lifecycle_state }) => lifecycle_state))).toEqual(new Set(['active']));

    for (const label of ['A', 'B'] as const) {
      const audioAssets = assets.filter((asset) => asset.label === label && asset.kind !== 'provenance');
      expect(audioAssets).toHaveLength(3);
      const expected = createSineWav({ seconds: 30, frequencyHz: label === 'A' ? 220 : 277.18, sampleRate: 8_000 });
      for (const asset of audioAssets) {
        expect(asset).toMatchObject({ content_type: 'audio/wav', bytes: expected.byteLength, duration_seconds: 30 });
        const object = await env.FILES.get(asset.r2_key);
        expect(object?.httpMetadata?.contentType).toBe('audio/wav');
        const bytes = new Uint8Array(await object!.arrayBuffer());
        expect(bytes).toEqual(expected);
        expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
        expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
      }

      const provenanceAsset = assets.find((asset) => asset.label === label && asset.kind === 'provenance')!;
      expect(provenanceAsset.content_type).toBe('application/json');
      const provenanceObject = await env.FILES.get(provenanceAsset.r2_key);
      const provenance = JSON.parse(await provenanceObject!.text());
      expect(provenance).toMatchObject({
        schemaVersion: 1,
        label,
        provider: 'fake',
        model: 'deterministic-sine-v1',
        providerCostUsd: 0,
        providerRequestId: `${payload.specSha256}-${label}`,
        specSha256: payload.specSha256,
      });
    }

    const costs = await queryAll<{ provider: string; model: string; amount_usd: number; idempotency_key: string }>(
      'SELECT provider, model, amount_usd, idempotency_key FROM twi_cost_events ORDER BY id',
    );
    expect(costs).toEqual([
      { provider: 'fake', model: 'deterministic-sine-v1', amount_usd: 0, idempotency_key: `${JOB_ID}:0:provider:A` },
      { provider: 'fake', model: 'deterministic-sine-v1', amount_usd: 0, idempotency_key: `${JOB_ID}:0:provider:B` },
    ]);

    const events = await queryAll<{ event_key: string; to_status: string }>(
      'SELECT event_key, to_status FROM twi_job_events ORDER BY id',
    );
    expect(events.map(({ to_status }) => to_status)).toEqual(['generating', 'ingesting', 'finishing', 'validating', 'complete']);
    expect(events.every(({ event_key }) => event_key.includes(':0:'))).toBe(true);
  });

  it('keeps every artifact provisional and the job validating when publication fails', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.mockStepError({ name: 'publish' }, new Error('publication unavailable'));
    });

    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    await instance!.waitForStatus('errored');

    const assets = await queryAll<{ lifecycle_state: string }>('SELECT lifecycle_state FROM twi_assets');
    expect(assets).toHaveLength(8);
    expect(assets.every(({ lifecycle_state }) => lifecycle_state === 'provisional')).toBe(true);
    expect(await queryAll('SELECT id FROM twi_assets WHERE lifecycle_state = \'active\'')).toHaveLength(0);
    expect(await queryAll('SELECT id FROM twi_jobs WHERE status = \'complete\'')).toHaveLength(0);
    expect(await queryAll('SELECT id FROM twi_jobs WHERE status = \'validating\'')).toHaveLength(1);
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
    expect(await queryAll('SELECT id FROM twi_jobs WHERE status = \'generating\'')).toHaveLength(1);
    const objects = await env.FILES.list();
    expect(objects.objects.map(({ key }) => key)).toEqual([expect.stringContaining('/A/raw.wav')]);
  });

  it('leaves finished artifacts provisional when validation itself fails', async () => {
    const payload = await seedJob();
    await using introspector = await introspectWorkflow(env.TWI_RENDER_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.mockStepError({ name: 'validate' }, new Error('invalid audio'));
    });

    expect((await start(payload)).status).toBe(202);
    const [instance] = await introspector.get();
    await instance!.waitForStatus('errored');
    const assets = await queryAll<{ lifecycle_state: string }>('SELECT lifecycle_state FROM twi_assets');
    expect(assets).toHaveLength(8);
    expect(assets.every(({ lifecycle_state }) => lifecycle_state === 'provisional')).toBe(true);
    expect(await queryAll('SELECT id FROM twi_jobs WHERE status = \'finishing\'')).toHaveLength(1);
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

  it('validates route methods and keeps the Modal callback closed', async () => {
    const wrongMethod = await fetchWorker('/start', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(await json(wrongMethod)).toEqual({ ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } });

    const callback = await fetchWorker('/callback/modal', { method: 'POST' });
    expect(callback.status).toBe(501);
    expect(await json(callback)).toEqual({
      ok: false,
      error: { code: 'modal_callback_not_configured', message: 'Modal callback is not configured' },
    });
  });
});
