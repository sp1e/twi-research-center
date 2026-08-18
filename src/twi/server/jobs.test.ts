// @vitest-environment node
/// <reference types="node" />
//
// The money path. Every assertion here is about a request that costs the owner real
// provider money, so what is pinned is not a response shape — it is a COUNT: how many
// jobs exist, how many estimate cost rows exist, how many times the Workflow was
// started. A green suite over a duplicated submission is a financial defect, and the
// only instrument that can see it is a `SELECT COUNT(*)` against a real database.
// That is why `jobsWorld()` loads the actual migration instead of scripting a driver.
//
// Four inherited contracts are exercised rather than trusted (HANDOVER §6):
//
//   1. `spec_sha256` comes from `specSha256()`. Asserted by VALUE against the digest
//      the repository stored, because an independently hashed digest turns a
//      legitimate replay into a collision — that is, into a second paid submission.
//   2. Every written timestamp is `YYYY-MM-DDTHH:MM:SS.sssZ`, generated in JS. The
//      schema rejects anything else at write time, so a wrong shape is a runtime
//      failure and not a type error; the fixed clock is what lets it be asserted.
//   3. The repository's replay-capable methods return `{ job, outcome }`, and the
//      outcome is USED: 201 only for a job this call created. A suite that always
//      accepted 201 is exactly how Task 6's API-62 gap stayed green.
//   4. `twi_job_events.event_key` and `twi_cost_events.idempotency_key` are NOT NULL
//      with no DEFAULT, so every insert supplies one — and the job-event key carries
//      the attempt ordinal, which `jobs-lifecycle.test.ts` drives through a retry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draft, instrumentalDraft } from '../domain/spec.fixture';
import type { CostEstimate } from '../domain/types';

import { MAX_IMAGE_REFERENCES_PER_SPEC } from './assets';
import { PROVIDER_ESTIMATE_VARIABLE, fixedCreationCoreEstimate, providerEstimateUsd } from './estimates';
import { HttpError } from './http';
import { RIGHTS_ASSERTION_VERSION, estimateJob, submitJob, type JobDeps } from './jobs';
import {
  FIXED_NOW,
  OTHER_PROJECT_ID,
  OWNER_PROJECT_ID,
  UNKNOWN_PROJECT_ID,
  jobsWorld,
  jsonRequest,
  missingAssetId,
  readJson,
  repoWith,
  type JobsWorld,
} from './jobs.harness';
import { specSha256 } from './repository';
import type { JobRecord } from './repository-types';

const IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222';
const SECOND_KEY = '66666666-6666-4666-8666-666666666666';

const ESTIMATE_URL = 'https://sp1e.se/api/twi/jobs/estimate';
const SUBMIT_URL = 'https://sp1e.se/api/twi/jobs';

let world: JobsWorld;

const deps = (overrides: Partial<JobDeps> = {}): JobDeps => ({
  repo: world.repo,
  orchestrator: world.orchestrator,
  clock: world.clock,
  ...overrides,
});

const submit = (overrides: Record<string, unknown> = {}, extra: Partial<JobDeps> = {}): Promise<Response> =>
  submitJob(
    jsonRequest(SUBMIT_URL, { projectId: OWNER_PROJECT_ID, idempotencyKey: IDEMPOTENCY_KEY, spec: draft, ...overrides }),
    deps(extra),
  );

const quote = (overrides: Record<string, unknown> = {}, extra: Partial<JobDeps> = {}): Promise<Response> =>
  estimateJob(jsonRequest(ESTIMATE_URL, { projectId: OWNER_PROJECT_ID, spec: draft, ...overrides }), deps(extra));

interface SubmitBody {
  job: JobRecord;
  outcome: string;
  transition: string | null;
}

const rejection = async (call: Promise<Response>): Promise<HttpError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with an HttpError');
};

beforeEach(async () => {
  world = await jobsWorld();
});

afterEach(() => {
  world.close();
  vi.restoreAllMocks();
});

// ── Estimate, which must happen BEFORE submission ────────────────────────────
//
// "No hard budget cap, but every job shows ESTIMATED cost BEFORE submission and
// records ACTUAL cost after." That is a locked product decision and it is the reason
// the cost tables exist. This endpoint is the "before" half; the estimate COST ROW
// `createEstimatedJob` writes is what makes the "after" half comparable to it.

describe('POST /api/twi/jobs/estimate', () => {
  it('reports a total that is exactly its components', async () => {
    const { estimate } = await readJson<{ estimate: CostEstimate }>(await quote());

    expect(estimate.total).toBeCloseTo(estimate.provider + estimate.finishing + estimate.storage, 8);
    expect(estimate.finishing).toBe(0.04);
    expect(estimate.storage).toBe(0.01);
    expect(estimate.estimatedSeconds).toBe(360);
  });

  it('labels the provider component unavailable — not zero — when pricing is not configured', async () => {
    const body = await readJson<{
      estimate: { provider: number };
      provider: { status: string; amountUsd: number };
      confirmation: string;
    }>(await quote());

    expect(body.provider.status).toBe('unavailable');
    expect(body.estimate.provider).toBe(0);
    expect(body.confirmation).toMatch(/actual provider cost/i);
    expect(body.confirmation).toMatch(/recorded/i);
  });

  it('parses a configured non-negative provider rate and includes it in the total', async () => {
    const body = await readJson<{
      estimate: { provider: number; total: number };
      provider: { status: string };
    }>(await quote({}, { providerEstimateUsd: '1.25' }));

    expect(body.provider.status).toBe('estimated');
    expect(body.estimate.provider).toBe(1.25);
    expect(body.estimate.total).toBeCloseTo(1.3, 8);
  });

  it.each([['-1'], ['not-a-number'], ['Infinity'], ['1e999']])(
    'refuses to quote at all when %s is configured, rather than quoting zero',
    async (raw) => {
      const failure = await rejection(quote({}, { providerEstimateUsd: raw }));

      expect(failure.status).toBe(500);
      expect(failure.code).toBe('estimate_misconfigured');
      expect(failure.message).toContain(PROVIDER_ESTIMATE_VARIABLE);
    },
  );

  it('treats an absent or blank variable as unconfigured rather than as an error', () => {
    expect(providerEstimateUsd(undefined)).toBe(0);
    expect(providerEstimateUsd(null)).toBe(0);
    expect(providerEstimateUsd('   ')).toBe(0);
    expect(providerEstimateUsd('0')).toBe(0);
  });

  it('writes nothing and starts nothing — an estimate is a quote, not a submission', async () => {
    await quote();

    expect(world.jobCount()).toBe(0);
    expect(world.specCount()).toBe(0);
    expect(world.costCount()).toBe(0);
    expect(world.orchestrator.calls).toEqual([]);
  });

  it('answers 404 for a project that does not exist', async () => {
    expect((await rejection(quote({ projectId: UNKNOWN_PROJECT_ID }))).status).toBe(404);
  });

  it('quotes the same components through the exported fixed policy', async () => {
    const quoted = await fixedCreationCoreEstimate.estimate(draft);

    expect(quoted.currency).toBe('USD');
    expect(quoted.total).toBeCloseTo(quoted.provider + quoted.finishing + quoted.storage, 8);
  });
});

// ── The locked owner rule, as one test per half ──────────────────────────────
//
// "No hard budget cap, but every job shows ESTIMATED cost BEFORE submission and
// records ACTUAL cost after." Both halves were previously only asserted OBLIQUELY —
// the estimate route was tested and the cost-row COUNT was tested, but nothing tied
// the number the owner was shown to the number stored on the job, and nothing at all
// covered the "after" half. A cost row whose category drifted off `estimate` would
// have inflated `actual_cost_usd` on submission with the whole suite still green.

describe('the estimate-before / actual-cost-after rule', () => {
  it('records on the job the SAME total the estimate route quotes, before anything is dispatched', async () => {
    const quoted = await readJson<{ estimate: CostEstimate }>(await quote());

    const body = await readJson<SubmitBody>(await submit());
    const storedEstimate = body.job.estimate as unknown as CostEstimate;
    const chargedRow = world.db.value<number>('SELECT amount_usd FROM twi_cost_events');

    // What was shown, what was stored on the job, and what was charged are one number.
    expect(storedEstimate.total).toBeCloseTo(quoted.estimate.total, 8);
    expect(chargedRow).toBeCloseTo(quoted.estimate.total, 8);
    expect(storedEstimate.provider).toBe(quoted.estimate.provider);
  });

  it('exists before the orchestrator is asked — a refused dispatch still leaves the estimate recorded', async () => {
    world.orchestrator.status = 503;

    const body = await readJson<SubmitBody>(await submit());

    // The dispatch never landed, so anything written here was written BEFORE it.
    expect(world.orchestrator.starts).toBe(1);
    expect(world.costCategories()).toEqual(['estimate']);
    expect((body.job.estimate as unknown as CostEstimate).total).toBeGreaterThan(0);
  });

  it('does NOT count the estimate as an actual cost — that is what makes the two comparable', async () => {
    const body = await readJson<SubmitBody>(await submit());

    // One estimate row exists, and actual cost is still zero. If Task 7's row were
    // written under any other category, `actual_cost_usd` would already be charged.
    expect(world.costCount()).toBe(1);
    expect(world.costCategories()).toEqual(['estimate']);
    expect((await world.job(body.job.id))?.actualCostUsd).toBe(0);
  });

  it('records the ACTUAL cost after, from the non-estimate rows only', async () => {
    const body = await readJson<SubmitBody>(await submit());

    await world.repo.appendCost({
      jobId: body.job.id,
      idempotencyKey: `${body.job.id}:0:provider`,
      category: 'provider',
      provider: 'lyria-3-pro',
      model: 'lyria-3-pro',
      amountUsd: 2.5,
      quantity: null,
      detailJson: JSON.stringify({ schemaVersion: 1 }),
      createdAt: FIXED_NOW,
    });

    const stored = await world.job(body.job.id);

    // 2.5, not 2.55: the estimate row is excluded from the actual total, so the
    // estimate can never be mistaken for a charge and a charge can never hide in it.
    expect(stored?.actualCostUsd).toBeCloseTo(2.5, 8);
    expect(world.costCategories()).toEqual(['estimate', 'provider']);
  });
});

// ── Idempotent submission ────────────────────────────────────────────────────

describe('POST /api/twi/jobs — idempotency', () => {
  it('submitted twice with the same key: one job, one charge, one start', async () => {
    const first = await submit();
    const second = await submit();

    const firstBody = await readJson<SubmitBody>(first);
    const secondBody = await readJson<SubmitBody>(second);

    expect({
      firstJobId: firstBody.job.id,
      secondJobId: secondBody.job.id,
      starts: world.orchestrator.starts,
    }).toEqual({ firstJobId: firstBody.job.id, secondJobId: firstBody.job.id, starts: 1 });

    expect(first.status).toBe(201);
    expect(firstBody.outcome).toBe('created');
    expect(second.status).toBe(200);
    expect(secondBody.outcome).toBe('replayed');

    expect(world.jobCount()).toBe(1);
    expect(world.costCount()).toBe(1);
    expect(world.costCategories()).toEqual(['estimate']);
  });

  it('replays a cosmetically different retry of the same submission rather than charging twice', async () => {
    await submit();

    // The same spec with its keys in a different ORDER. The digest is taken over the
    // canonical form, so this is the same submission and must not be a second paid one.
    const reordered = {
      rightsAccepted: draft.rightsAccepted,
      performance: draft.performance,
      sound: draft.sound,
      composition: draft.composition,
      intent: draft.intent,
    };
    const again = await submit({ spec: reordered });

    expect(again.status).toBe(200);
    expect((await readJson<SubmitBody>(again)).outcome).toBe('replayed');
    expect(world.jobCount()).toBe(1);
    expect(world.orchestrator.starts).toBe(1);
  });

  it('stores the digest specSha256() derives — the value findJobByIdempotencyKey looks up', async () => {
    const body = await readJson<SubmitBody>(await submit());
    const stored = world.db.value<string>('SELECT spec_sha256 FROM twi_generation_specs');

    expect(body.job.specSha256).toBe(stored);
    expect(stored).toBe(await specSha256(JSON.stringify(draft)));
  });

  it('refuses a key reused for a DIFFERENT spec, and writes nothing new', async () => {
    await submit();

    const failure = await rejection(submit({ spec: { ...draft, sound: { ...draft.sound, novelty: 3 } } }));

    expect(failure.status).toBe(409);
    expect(failure.code).toBe('idempotency_key_reused');
    expect(world.jobCount()).toBe(1);
    expect(world.costCount()).toBe(1);
    expect(world.orchestrator.starts).toBe(1);
  });

  it('treats a different key as a different submission — two jobs, two charges, two starts', async () => {
    await submit();
    await submit({ idempotencyKey: SECOND_KEY });

    expect(world.jobCount()).toBe(2);
    expect(world.costCount()).toBe(2);
    expect(world.orchestrator.starts).toBe(2);
  });

  it('does not dispatch when createEstimatedJob reports that a concurrent submission won', async () => {
    const created = await readJson<SubmitBody>(await submit({ idempotencyKey: SECOND_KEY }));
    world.orchestrator.calls.length = 0;

    const response = await submit(
      {},
      { repo: repoWith(world.repo, { createEstimatedJob: async () => ({ job: created.job, outcome: 'replayed' }) }) },
    );

    expect(response.status).toBe(200);
    expect((await readJson<SubmitBody>(response)).outcome).toBe('replayed');
    expect(world.orchestrator.starts).toBe(0);
  });

  it('refuses to continue if the stored digest disagrees with the fingerprint it looked up', async () => {
    const lying = repoWith(world.repo, {
      saveSpec: async (input) => ({
        id: input.id,
        projectId: input.projectId,
        spec: {},
        specSha256: 'f'.repeat(64),
        rightsAssertionVersion: input.rightsAssertionVersion,
        createdAt: input.createdAt,
      }),
    });

    const failure = await rejection(submit({}, { repo: lying }));

    expect(failure.status).toBe(500);
    expect(failure.code).toBe('spec_digest_mismatch');
    expect(world.jobCount()).toBe(0);
    expect(world.orchestrator.starts).toBe(0);
  });
});

// ── Validation, all of it before anything is written ─────────────────────────

describe('POST /api/twi/jobs — validation', () => {
  it('rejects a submission whose rights assertion is missing', async () => {
    const { intent, composition, sound, performance } = draft;
    const failure = await rejection(submit({ spec: { intent, composition, sound, performance } }));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('invalid_spec');
    expect(failure.message).toContain('rightsAccepted');
    expect(world.jobCount()).toBe(0);
    expect(world.orchestrator.calls).toEqual([]);
  });

  it('rejects an instrumental submission that still carries lyrics, rather than dropping them', async () => {
    const failure = await rejection(
      submit({
        spec: {
          ...instrumentalDraft,
          composition: { ...instrumentalDraft.composition, lyrics: '[Verse]\nstill here' },
        },
      }),
    );

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('invalid_spec');
    expect(failure.message).toContain('composition.lyrics');
  });

  it('rejects an unknown top-level field instead of discarding it', async () => {
    const failure = await rejection(submit({ surprise: true }));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('invalid_spec');
  });

  it('accepts an instrumental submission with the vocal fields cleared', async () => {
    expect((await submit({ spec: instrumentalDraft })).status).toBe(201);
  });

  it('records the rights assertion version against the stored spec', async () => {
    await submit();

    expect(world.db.value<string>('SELECT rights_assertion_version FROM twi_generation_specs')).toBe(
      RIGHTS_ASSERTION_VERSION,
    );
  });
});

// ── Image references: the ten-per-specification cap, and what a reference IS ──
//
// `assertImageReferenceSelection` shipped in Task 6 with NO production caller, so the
// cap it describes did not exist. This is that caller. The cap runs before any
// repository read, for the reason the ingestion path already states in prose: a bound
// applied after the work is an amplifier, not a guard.

describe('POST /api/twi/jobs — image references', () => {
  const references = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => missingAssetId(index.toString(16)));

  const withReferences = (ids: string[]) => ({ spec: { ...draft, sound: { ...draft.sound, imageAssetIds: ids } } });

  it(`refuses more than ${MAX_IMAGE_REFERENCES_PER_SPEC} references per specification`, async () => {
    const failure = await rejection(submit(withReferences(references(MAX_IMAGE_REFERENCES_PER_SPEC + 1))));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('too_many_image_references');
  });

  it('applies the cap BEFORE it reads the database, so an over-count costs no query', async () => {
    const seen = { reads: 0 };
    const watched = repoWith(world.repo, {
      countProjectAssets: async (input) => {
        seen.reads += 1;
        return world.repo.countProjectAssets(input);
      },
    });

    await rejection(submit(withReferences(references(MAX_IMAGE_REFERENCES_PER_SPEC + 1)), { repo: watched }));

    expect(seen.reads).toBe(0);
  });

  it('accepts ten real references belonging to the project', async () => {
    const ids = references(MAX_IMAGE_REFERENCES_PER_SPEC);
    for (const id of ids) await world.asset({ id });

    expect((await submit(withReferences(ids))).status).toBe(201);
  });

  it('refuses a reference that belongs to another project', async () => {
    const id = missingAssetId('a1');
    await world.asset({ id, projectId: OTHER_PROJECT_ID });

    const failure = await rejection(submit(withReferences([id])));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('unknown_image_reference');
    expect(world.jobCount()).toBe(0);
  });

  it('refuses a reference that does not exist at all', async () => {
    const failure = await rejection(submit(withReferences([missingAssetId('b2')])));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('unknown_image_reference');
  });

  it('refuses an AUDIO asset offered as a reference — audio reference is unavailable', async () => {
    const id = missingAssetId('c3');
    await world.asset({ id, kind: 'generation-master' });

    const failure = await rejection(submit(withReferences([id])));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('unsupported_capability');
    expect(world.jobCount()).toBe(0);
    expect(world.orchestrator.calls).toEqual([]);
  });

  it('refuses a deleted reference rather than rendering against missing bytes', async () => {
    const id = missingAssetId('d4');
    await world.asset({ id, lifecycleState: 'deleted' });

    const failure = await rejection(submit(withReferences([id])));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('unknown_image_reference');
  });

  it('refuses the same reference twice rather than reading it as two', async () => {
    const id = missingAssetId('e5');
    await world.asset({ id });

    const failure = await rejection(submit(withReferences([id, id])));

    expect(failure.status).toBe(400);
    expect(failure.code).toBe('duplicate_image_reference');
  });
});

// ── Dispatch, and what happens when the orchestrator is not there ────────────

describe('POST /api/twi/jobs — dispatch', () => {
  it('queues the job only after the orchestrator accepts, with the attempt ordinal in the event key', async () => {
    const body = await readJson<SubmitBody>(await submit());
    const stored = await world.job(body.job.id);

    expect(stored?.status).toBe('queued');
    expect(stored?.phase).toBe('queued');
    expect(body.transition).toBe('applied');
    expect(world.eventKeys()).toEqual([`${body.job.id}:0:estimated`, `${body.job.id}:0:queued`]);
  });

  it('starts the Workflow at the internal origin, once, with the job identity and no lyric content', async () => {
    const body = await readJson<SubmitBody>(await submit());

    expect(world.orchestrator.calls).toHaveLength(1);
    expect(world.orchestrator.call().url).toBe('https://twi.internal/start');
    expect(world.orchestrator.call().method).toBe('POST');
    expect(world.orchestrator.payload()).toMatchObject({
      jobId: body.job.id,
      projectId: OWNER_PROJECT_ID,
      specSha256: body.job.specSha256,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(world.orchestrator.call().body).not.toContain('Northbound');
  });

  it('writes every timestamp in the one shape the schema accepts', async () => {
    const body = await readJson<SubmitBody>(await submit());

    for (const value of [body.job.createdAt, body.job.updatedAt]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(value).toBe(FIXED_NOW);
    }
    expect(world.db.value<string>('SELECT created_at FROM twi_cost_events')).toBe(FIXED_NOW);
  });

  it('lands a refused dispatch in error with orchestrator_unavailable, charged exactly once', async () => {
    world.orchestrator.status = 503;

    const response = await submit();
    const body = await readJson<SubmitBody>(response);
    const stored = await world.job(body.job.id);

    expect(response.status).toBe(502);
    expect(stored?.status).toBe('error');
    expect(stored?.errorCode).toBe('orchestrator_unavailable');
    expect(stored?.retryCheckpoint).toBe('queued');
    expect(world.costCount()).toBe(1);
    expect(world.jobCount()).toBe(1);
  });

  it('lands a THROWN dispatch in the same place, and never quotes the binding’s message', async () => {
    world.orchestrator.failWith = new Error('service binding unreachable: secret-connection-string');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await submit();
    const text = await response.text();
    const body = JSON.parse(text) as SubmitBody;

    expect(response.status).toBe(502);
    expect((await world.job(body.job.id))?.errorCode).toBe('orchestrator_unavailable');
    expect(text).not.toContain('secret-connection-string');
  });

  it('lets the failed submission be replayed without a second charge', async () => {
    world.orchestrator.status = 503;
    await submit();
    world.orchestrator.status = 202;

    const again = await submit();

    expect(again.status).toBe(200);
    expect(world.jobCount()).toBe(1);
    expect(world.costCount()).toBe(1);
  });
});
