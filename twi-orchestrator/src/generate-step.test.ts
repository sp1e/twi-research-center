import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { draft } from '../../src/twi/domain/spec.fixture';
import type { GenerationSpec } from '../../src/twi/domain/types';
import type { ClaimProviderCallInput, SettleProviderCallInput } from '../../src/twi/server/provider-call-types';
import { specSha256 } from '../../src/twi/server/spec-digest';
import { TwiWorkflowStore } from './db';
import { PROVIDER_CALL_ALREADY_CLAIMED, runGenerateStep, type GenerateStepStore } from './generate-step';
import { DeterministicFakeMusicProvider } from './providers/fake';
import { ProviderError } from './providers/lyria';
import type { CandidateLabel, MusicProvider, ProviderCandidate } from './providers/types';

/*
 * The order inside the billable step, proven against the REAL ledger. The store is the real
 * TwiWorkflowStore over the test worker's D1 (migrations applied by test/apply-migrations.ts),
 * wrapped only to record the ORDER of the calls; the provider is a double because the thing under
 * test is what the step does around it, not what it renders. Every "the row is ..." assertion is a
 * SELECT, so a double cannot tell this suite what it wants to hear.
 */

const NOW = '2026-08-29T12:00:00.000Z';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SPEC_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const SPEC: GenerationSpec = { ...draft, intent: { ...draft.intent, durationSeconds: 2 } };
const payload = { jobId: JOB_ID, projectId: PROJECT_ID, attempt: 0 };

interface Row {
  state: string;
  charge_certainty: string;
  provider_request_id: string | null;
  provider: string | null;
  model: string | null;
  settled_at: string | null;
}

const row = async (label: CandidateLabel = 'A'): Promise<Row | null> =>
  env.DB.prepare(
    `SELECT state, charge_certainty, provider_request_id, provider, model, settled_at
     FROM twi_provider_calls WHERE job_id = ? AND attempt = 0 AND label = ?`,
  )
    .bind(JOB_ID, label)
    .first<Row>();

const rowCount = async (): Promise<number> =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM twi_provider_calls').first<{ n: number }>())!.n;

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM twi_provider_calls'),
    env.DB.prepare('DELETE FROM twi_jobs'),
    env.DB.prepare('DELETE FROM twi_generation_specs'),
    env.DB.prepare('DELETE FROM twi_projects'),
  ]);
  const specJson = JSON.stringify(SPEC);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO twi_projects (id, name, lifecycle_state, created_at, updated_at) VALUES (?, 'Step test', 'active', ?, ?)`,
    ).bind(PROJECT_ID, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO twi_generation_specs (id, project_id, spec_json, spec_sha256, rights_assertion_version, created_at)
       VALUES (?, ?, ?, ?, 'v1', ?)`,
    ).bind(SPEC_ID, PROJECT_ID, specJson, await specSha256(specJson), NOW),
    env.DB.prepare(
      `INSERT INTO twi_jobs
         (id, project_id, spec_id, kind, status, phase, provider, model, idempotency_key, estimate_json, actual_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, 'full-song', 'generating', 'generating', 'fake', 'deterministic-sine-v1', ?, '{}', 0, ?, ?)`,
    ).bind(JOB_ID, PROJECT_ID, SPEC_ID, '44444444-4444-4444-8444-444444444444', NOW, NOW),
  ]);
  const listed = await env.FILES.list();
  await Promise.all(listed.objects.map(({ key }) => env.FILES.delete(key)));
}

/** The real store, with the order of its two ledger writes recorded. */
const recordingStore = (order: string[]): GenerateStepStore => {
  const real = new TwiWorkflowStore(env.DB);
  return {
    claimProviderCall: (input: ClaimProviderCallInput) => {
      order.push('claim');
      return real.claimProviderCall(input);
    },
    settleProviderCall: (input: SettleProviderCallInput) => {
      order.push(`settle:${input.state}`);
      return real.settleProviderCall(input);
    },
  };
};

const recordingProvider = (order: string[], inner: MusicProvider): MusicProvider => ({
  generate: (spec, label) => {
    order.push('generate');
    return inner.generate(spec, label);
  },
});

const throwingProvider = (error: unknown): MusicProvider => ({
  generate: async (): Promise<ProviderCandidate> => {
    throw error;
  },
});

const run = (order: string[], provider: MusicProvider, store: GenerateStepStore = recordingStore(order)) =>
  runGenerateStep({
    store,
    provider: recordingProvider(order, provider),
    providerMode: 'fake',
    payload,
    spec: SPEC,
    label: 'A',
    files: env.FILES,
    now: NOW,
  });

describe('runGenerateStep', () => {
  beforeEach(seed);

  it('claims BEFORE calling the provider and settles completed IMMEDIATELY after, request id and all', async () => {
    const order: string[] = [];
    const manifest = await run(order, new DeterministicFakeMusicProvider());

    expect(order).toEqual(['claim', 'generate', 'settle:completed']);
    const expectedRequestId = `${await specSha256(JSON.stringify(SPEC))}-A`;
    expect(await row()).toEqual({
      state: 'completed',
      charge_certainty: 'charged',
      provider_request_id: expectedRequestId,
      provider: 'fake',
      model: 'deterministic-sine-v1',
      settled_at: NOW,
    });
    expect(manifest).toMatchObject({
      label: 'A',
      key: `twi/${PROJECT_ID}/jobs/${JOB_ID}/attempt-0/A/raw.wav`,
      providerRequestId: expectedRequestId,
    });
    expect(await env.FILES.get(manifest.key)).not.toBeNull();
  });

  it('never calls the provider when the identity is already claimed, and says so as a non-retryable error', async () => {
    const order: string[] = [];
    const store = recordingStore(order);
    await store.claimProviderCall({ jobId: JOB_ID, attempt: 0, label: 'A', providerMode: 'fake', now: NOW });
    order.length = 0;

    const failure = await run(order, new DeterministicFakeMusicProvider(), store).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure).not.toBeNull();
    expect(failure!.name).toBe('NonRetryableError');
    expect(failure!.message.startsWith('NonRetryableError')).toBe(true);
    expect(failure!.message).toContain(PROVIDER_CALL_ALREADY_CLAIMED);
    expect(order).toEqual(['claim']);
    expect(await row()).toMatchObject({ state: 'submitting', charge_certainty: 'unknown' });
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it.each([
    [false, 'abandoned', 'not_charged'],
    [true, 'accepted', 'charged'],
    [null, 'ambiguous', 'unknown'],
  ] as const)('settles a ProviderError with charged=%s as %s', async (charged, state, certainty) => {
    const order: string[] = [];
    const error = new ProviderError('provider_unavailable', 'the provider failed', charged);

    await expect(run(order, throwingProvider(error))).rejects.toBeDefined();

    expect(order).toEqual(['claim', 'generate', `settle:${state}`]);
    expect(await row()).toMatchObject({ state, charge_certainty: certainty, settled_at: NOW, provider_request_id: null });
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it('promotes a possibly-paid ProviderError to NonRetryableError and lets a proven-unpaid one keep its retry policy', async () => {
    const paid = await run([], throwingProvider(new ProviderError('provider_unavailable', 'server error', null))).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(paid!.name).toBe('NonRetryableError');
    expect(paid!.message).toBe('provider_unavailable');

    await seed();
    const unpaid = await run([], throwingProvider(new ProviderError('provider_unavailable', 'rate limited', false))).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(unpaid).toBeInstanceOf(ProviderError);
    expect(unpaid!.name).toBe('ProviderError');
  });

  it('settles NOTHING on an error that is not a ProviderError: the row stays submitting, which is the truth', async () => {
    const order: string[] = [];
    await expect(run(order, throwingProvider(new TypeError('fetch is not a function')))).rejects.toThrow(TypeError);

    expect(order).toEqual(['claim', 'generate']);
    expect(await row()).toMatchObject({ state: 'submitting', charge_certainty: 'unknown', settled_at: null });
  });

  it('carries a settlement failure on the rethrown provider error instead of masking or swallowing it', async () => {
    const order: string[] = [];
    const real = recordingStore(order);
    const broken: GenerateStepStore = {
      claimProviderCall: (input) => real.claimProviderCall(input),
      settleProviderCall: async () => {
        order.push('settle:threw');
        throw new Error('D1 is unavailable');
      },
    };
    const failure = await run(order, throwingProvider(new ProviderError('provider_rejected', 'refused', false)), broken).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure!.name).toBe('NonRetryableError');
    expect(failure!.message).toBe('provider_rejected');
    expect((failure!.cause as Error).message).toBe('D1 is unavailable');
    expect(order).toEqual(['claim', 'generate', 'settle:threw']);
    expect(await row()).toMatchObject({ state: 'submitting' });
  });

  it('fails the step, leaving the row submitting, when the settlement after a successful call throws', async () => {
    const order: string[] = [];
    const real = recordingStore(order);
    const broken: GenerateStepStore = {
      claimProviderCall: (input) => real.claimProviderCall(input),
      settleProviderCall: async () => {
        throw new Error('D1 is unavailable');
      },
    };
    await expect(run(order, new DeterministicFakeMusicProvider(), broken)).rejects.toThrow('D1 is unavailable');
    expect(await row()).toMatchObject({ state: 'submitting' });
    // Nothing reached R2: the settlement precedes the put.
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it('records the provider mode on the claim, before the call, from the mode it was handed', async () => {
    await runGenerateStep({
      store: new TwiWorkflowStore(env.DB),
      provider: new DeterministicFakeMusicProvider(),
      providerMode: 'lyria',
      payload,
      spec: SPEC,
      label: 'B',
      files: env.FILES,
      now: NOW,
    });
    const mode = await env.DB.prepare(`SELECT provider_mode FROM twi_provider_calls WHERE label = 'B'`).first<{ provider_mode: string }>();
    expect(mode?.provider_mode).toBe('lyria');
    expect(await rowCount()).toBe(1);
  });
});
