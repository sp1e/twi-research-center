// @vitest-environment node
/// <reference types="node" />
//
// POST /api/twi/jobs/:id/resolve-provider-call — the reconciliation route.
//
// This is the operator surface the D1 provider-call round left open: the retry gate
// refuses while any provider call is not provably uncharged and unresolved, and until
// this route existed the only way to clear one was to run a repository method against
// the real database by hand.
//
// TWO CLASSES OF TEST HERE, and the second is the point.
//
//  * The happy paths: an unknown charge becomes known and stops blocking; a known charge
//    is acknowledged and stops blocking; a second identical call changes nothing.
//  * THE BOUNDARY. `resolveProviderCall` on the repository enforces its own rules by
//    throwing `TwiRepositoryValidationError`, which is NOT an `HttpError` — so anything
//    the route fails to check first reaches the owner as `internal_error` with a
//    correlation id and no way to tell what was wrong with the request. Every rule the
//    repository enforces is therefore checked HERE too, and asserted to answer 4xx. That
//    is the same reasoning `parseProjectName` records: a name of zero-width spaces would
//    otherwise reach a CHECK constraint as a 500 instead of a 400.
//
// The route never lets the ledger be rewritten: `to` may only ever be `accepted` or
// `abandoned`, and only on a row whose charge is still unknown. A resolution acknowledges
// a known charge; it does not relabel one. Both halves are asserted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draft } from '../domain/spec.fixture';

import { HttpError } from './http';
import { submitJob, type JobDeps } from './jobs';
import { retryJob } from './jobs-cancel-retry';
import { listProviderCallsRoute, resolveProviderCallRoute } from './jobs-provider-calls';
import {
  OWNER_PROJECT_ID,
  UNKNOWN_JOB_ID,
  jobsWorld,
  jsonRequest,
  readJson,
  repoWith,
  type JobsWorld,
} from './jobs.harness';
import type { ProviderCallRecord } from './provider-call-types';
import type { JobRecord } from './repository-types';

const FIRST_KEY = '22222222-2222-4222-8222-222222222222';
const SUBMIT_URL = 'https://sp1e.se/api/twi/jobs';
const RESOLVE_URL = 'https://sp1e.se/api/twi/jobs/x/resolve-provider-call';

type Settled = 'accepted' | 'completed' | 'ambiguous' | 'abandoned';

interface ResolveBody {
  call: ProviderCallRecord;
  outcome: string;
}

interface ListBody {
  calls: ProviderCallRecord[];
  blocking: ProviderCallRecord[];
  retryBlocked: boolean;
}

let world: JobsWorld;

const deps = (overrides: Partial<JobDeps> = {}): JobDeps => ({
  repo: world.repo,
  orchestrator: world.orchestrator,
  clock: world.clock,
  ...overrides,
});

/** A job in `error`, the only status a retry acts on, so the gate is observable. */
const failedJob = async (): Promise<JobRecord> => {
  world.orchestrator.status = 503;
  const response = await submitJob(
    jsonRequest(SUBMIT_URL, { projectId: OWNER_PROJECT_ID, idempotencyKey: FIRST_KEY, spec: draft }),
    deps(),
  );
  world.orchestrator.status = 202;
  world.orchestrator.calls.length = 0;
  return (await readJson<{ job: JobRecord }>(response)).job;
};

const priorCall = async (job: JobRecord, attempt: number, label: 'A' | 'B', state?: Settled): Promise<void> => {
  await world.repo.claimProviderCall({ jobId: job.id, attempt, label, providerMode: 'fake', now: world.clock.now() });
  if (state) {
    await world.repo.settleProviderCall({
      jobId: job.id,
      attempt,
      label,
      state,
      providerRequestId: state === 'completed' ? `req-${attempt}-${label}` : undefined,
      now: world.clock.now(),
    });
  }
};

const resolve = (jobId: string, body: unknown): Promise<Response> =>
  resolveProviderCallRoute(jobId, jsonRequest(RESOLVE_URL, body), deps());

const rejection = async (call: Promise<Response>): Promise<HttpError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected the route to refuse, but it answered');
};

beforeEach(async () => {
  world = await jobsWorld();
});

afterEach(() => {
  world.close();
  vi.restoreAllMocks();
});

describe('GET /api/twi/jobs/:id/provider-calls', () => {
  const list = (jobId: string): Promise<Response> => listProviderCallsRoute(jobId, deps());

  it('answers an empty ledger for a job that never reached a provider', async () => {
    const job = await failedJob();

    const body = await readJson<ListBody>(await list(job.id));

    expect(body.calls).toEqual([]);
    expect(body.blocking).toEqual([]);
    expect(body.retryBlocked).toBe(false);
  });

  it('returns every call in (attempt, label) order, whatever order they were written in', async () => {
    const job = await failedJob();
    await priorCall(job, 1, 'B', 'ambiguous');
    await priorCall(job, 0, 'B', 'abandoned');
    await priorCall(job, 1, 'A', 'completed');
    await priorCall(job, 0, 'A', 'completed');

    const body = await readJson<ListBody>(await list(job.id));

    expect(body.calls.map(({ attempt, label }) => `${attempt}${label}`)).toEqual(['0A', '0B', '1A', '1B']);
  });

  it('discloses the fields an operator needs to resolve a call, and no binding or secret', async () => {
    const job = await failedJob();
    await priorCall(job, 0, 'A', 'ambiguous');

    const response = await list(job.id);
    const raw = await response.text();
    const [call] = (JSON.parse(raw) as ListBody).calls;

    expect(response.status).toBe(200);
    expect(call).toMatchObject({
      attempt: 0,
      label: 'A',
      state: 'ambiguous',
      chargeCertainty: 'unknown',
      providerMode: 'fake',
      resolvedAt: null,
      resolutionNote: null,
    });
    expect(call?.claimedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The ledger carries no credential, but a route that grew one would be the place it leaked.
    expect(raw).not.toMatch(/secret|Authorization|accessKey|TWI_ORCHESTRATOR|DB\b/i);
  });

  it('answers 404 for an unknown job rather than an empty ledger', async () => {
    const failure = await rejection(list(UNKNOWN_JOB_ID));
    expect(failure.status).toBe(404);
  });

  /**
   * THE POINT OF THIS ROUTE, and the assertion that makes it worth having.
   *
   * `blocking` is derived with `isUnreconciledProviderCall` — the SAME function `retryJob`
   * filters with — so what this route shows an operator cannot disagree with what the gate
   * actually refuses. A second, independently written predicate here would be free to drift,
   * and the drift would surface as a retry that fails for a call the UI reported as fine.
   * So the two are paired directly: for every fixture, `retryBlocked` must equal whether
   * `retryJob` refuses.
   */
  it.each([
    ['no calls', [] as const, false],
    ['one abandoned call', [['A', 'abandoned']] as const, false],
    ['one submitting call', [['A', undefined]] as const, true],
    ['one ambiguous call', [['A', 'ambiguous']] as const, true],
    ['one completed call', [['A', 'completed']] as const, true],
    ['one accepted call', [['A', 'accepted']] as const, true],
    ['abandoned plus ambiguous', [['A', 'abandoned'], ['B', 'ambiguous']] as const, true],
    ['two abandoned calls', [['A', 'abandoned'], ['B', 'abandoned']] as const, false],
  ])('agrees with the retry gate about %s', async (_case, fixture, expectedBlocked) => {
    const job = await failedJob();
    for (const [label, settle] of fixture) {
      await priorCall(job, 0, label as 'A' | 'B', settle as Settled | undefined);
    }

    const body = await readJson<ListBody>(await list(job.id));
    expect(body.retryBlocked).toBe(expectedBlocked);
    expect(body.blocking.length > 0).toBe(expectedBlocked);

    // The oracle: whatever this route says, the gate must do.
    if (expectedBlocked) {
      const failure = await rejection(retryJob(job.id, deps()));
      expect(failure.code).toBe('unreconciled_provider_call');
      // and it must name a call this route reported as blocking, not some other one
      expect(body.blocking.some(({ attempt, label }) => failure.message.includes(`attempt ${attempt}`) && failure.message.includes(label))).toBe(true);
    } else {
      expect((await readJson<{ attempt: number }>(await retryJob(job.id, deps()))).attempt).toBe(1);
    }
  });

  it('stops reporting a call as blocking once the resolve route has cleared it', async () => {
    const job = await failedJob();
    await priorCall(job, 0, 'A', 'ambiguous');
    expect((await readJson<ListBody>(await list(job.id))).retryBlocked).toBe(true);

    await resolve(job.id, { attempt: 0, label: 'A', to: 'accepted', note: 'the invoice shows this charge' });

    const body = await readJson<ListBody>(await list(job.id));
    expect(body.retryBlocked).toBe(false);
    expect(body.blocking).toEqual([]);
    // The row is still THERE — a resolution is an acknowledgement, not a deletion.
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]?.state).toBe('accepted');
    expect(body.calls[0]?.resolutionNote).toBe('the invoice shows this charge');
  });
});

describe('POST /api/twi/jobs/:id/resolve-provider-call', () => {
  describe('resolving an unknown charge', () => {
    it.each(['ambiguous', undefined] as const)(
      'makes a %s call known and stops it blocking a retry',
      async (settle) => {
        const job = await failedJob();
        await priorCall(job, 0, 'A', settle);
        expect((await rejection(retryJob(job.id, deps()))).code).toBe('unreconciled_provider_call');

        const body = await readJson<ResolveBody>(
          await resolve(job.id, { attempt: 0, label: 'A', to: 'accepted', note: 'the invoice shows this charge' }),
        );

        expect(body.outcome).toBe('resolved');
        expect(body.call.state).toBe('accepted');
        expect(body.call.chargeCertainty).toBe('charged');
        expect(body.call.resolvedAt).not.toBeNull();
        expect(body.call.resolutionNote).toBe('the invoice shows this charge');

        // The gate is the reason this route exists, so the release is asserted end to end.
        const retried = await readJson<{ attempt: number }>(await retryJob(job.id, deps()));
        expect(retried.attempt).toBe(1);
        expect(world.orchestrator.starts).toBe(1);
      },
    );

    it('can resolve an unknown charge to abandoned, which reads as not_charged', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');

      const body = await readJson<ResolveBody>(
        await resolve(job.id, { attempt: 0, label: 'A', to: 'abandoned', note: 'no charge on the account' }),
      );

      expect(body.call.state).toBe('abandoned');
      expect(body.call.chargeCertainty).toBe('not_charged');
    });

    it('refuses without `to`: an unknown charge must become known, not merely be noted', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');

      const failure = await rejection(resolve(job.id, { attempt: 0, label: 'A', note: 'looked at it' }));

      expect(failure.status).toBe(409);
      expect(failure.code).toBe('resolution_requires_charge');
      // Still blocking: a refused resolution must not have written anything.
      expect((await rejection(retryJob(job.id, deps()))).code).toBe('unreconciled_provider_call');
    });
  });

  describe('acknowledging a known charge', () => {
    it.each(['completed', 'accepted'] as const)('acknowledges a %s call without `to`', async (settle) => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', settle);

      const body = await readJson<ResolveBody>(
        await resolve(job.id, { attempt: 0, label: 'A', note: 'known charge, retrying anyway' }),
      );

      expect(body.outcome).toBe('resolved');
      expect(body.call.state).toBe(settle);
      expect(body.call.chargeCertainty).toBe('charged');
      expect(body.call.resolvedAt).not.toBeNull();
    });

    it.each(['completed', 'accepted', 'abandoned'] as const)(
      'refuses to relabel a %s call: a resolution acknowledges a charge, it does not rewrite one',
      async (settle) => {
        const job = await failedJob();
        await priorCall(job, 0, 'A', settle);

        const failure = await rejection(
          resolve(job.id, { attempt: 0, label: 'A', to: 'abandoned', note: 'call it unpaid' }),
        );

        expect(failure.status).toBe(409);
        expect(failure.code).toBe('resolution_cannot_rewrite_charge');
        const calls = await world.repo.listProviderCalls(job.id);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.state).toBe(settle);
        expect(calls[0]?.resolvedAt).toBeNull();
      },
    );
  });

  describe('idempotence', () => {
    it('answers already-resolved and changes nothing on a second call', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');
      const first = await readJson<ResolveBody>(
        await resolve(job.id, { attempt: 0, label: 'A', to: 'accepted', note: 'first word' }),
      );

      const second = await readJson<ResolveBody>(
        await resolve(job.id, { attempt: 0, label: 'A', note: 'second word' }),
      );

      expect(second.outcome).toBe('already-resolved');
      expect(second.call.resolutionNote).toBe('first word');
      expect(second.call.resolvedAt).toBe(first.call.resolvedAt);
    });

    it('refuses a second call that tries to relabel, rather than reporting already-resolved', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');
      await resolve(job.id, { attempt: 0, label: 'A', to: 'accepted', note: 'first word' });

      const failure = await rejection(
        resolve(job.id, { attempt: 0, label: 'A', to: 'abandoned', note: 'second word' }),
      );

      expect(failure.status).toBe(409);
      expect(failure.code).toBe('resolution_cannot_rewrite_charge');
    });
  });

  describe('what it refuses at the boundary, so no request reaches the repository as a 500', () => {
    it('answers 404 for an unknown job', async () => {
      const failure = await rejection(resolve(UNKNOWN_JOB_ID, { attempt: 0, label: 'A', note: 'x' }));
      expect(failure.status).toBe(404);
    });

    it('answers 404 when the job exists but that call was never claimed', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');

      const failure = await rejection(resolve(job.id, { attempt: 0, label: 'B', note: 'x' }));

      expect(failure.status).toBe(404);
      expect(failure.code).toBe('provider_call_not_found');
    });

    it.each([
      ['a non-integer attempt', { attempt: 1.5, label: 'A', note: 'x' }, 'invalid_provider_call_identity'],
      ['a negative attempt', { attempt: -1, label: 'A', note: 'x' }, 'invalid_provider_call_identity'],
      ['a numeric-string attempt', { attempt: '0', label: 'A', note: 'x' }, 'invalid_provider_call_identity'],
      ['a missing attempt', { label: 'A', note: 'x' }, 'invalid_provider_call_identity'],
      ['an unknown label', { attempt: 0, label: 'C', note: 'x' }, 'invalid_provider_call_identity'],
      ['a lowercase label', { attempt: 0, label: 'a', note: 'x' }, 'invalid_provider_call_identity'],
      ['a blank note', { attempt: 0, label: 'A', note: '   ' }, 'invalid_resolution_note'],
      ['a missing note', { attempt: 0, label: 'A' }, 'invalid_resolution_note'],
      ['a non-string note', { attempt: 0, label: 'A', note: 7 }, 'invalid_resolution_note'],
      ['an unknown resolution', { attempt: 0, label: 'A', to: 'completed', note: 'x' }, 'invalid_resolution'],
      ['a null resolution', { attempt: 0, label: 'A', to: null, note: 'x' }, 'invalid_resolution'],
      ['an unknown field', { attempt: 0, label: 'A', note: 'x', force: true }, 'unknown_field'],
    ])('refuses %s with 400 %s', async (_case, body, code) => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');

      const failure = await rejection(resolve(job.id, body));

      expect(failure.status).toBe(400);
      expect(failure.code).toBe(code);
    });

    /**
     * A note of only zero-width spaces survives `trim()`. Without normalization it would
     * reach the repository's own nonblank assertion and surface as `internal_error`; the
     * `twi_provider_calls_resolution_pair` CHECK would refuse it after that. Asserted here
     * because the 500 and the 400 are indistinguishable to a caller reading a status code.
     */
    it('refuses a note that is blank only after normalization', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');

      const failure = await rejection(
        resolve(job.id, { attempt: 0, label: 'A', to: 'accepted', note: '​​' }),
      );

      expect(failure.status).toBe(400);
      expect(failure.code).toBe('invalid_resolution_note');
    });

    it('stores the note normalized rather than as typed', async () => {
      const job = await failedJob();
      await priorCall(job, 0, 'A', 'ambiguous');

      const body = await readJson<ResolveBody>(
        await resolve(job.id, { attempt: 0, label: 'A', to: 'accepted', note: '  charge   confirmed \n by finance ' }),
      );

      expect(body.call.resolutionNote).toBe('charge confirmed by finance');
    });

    it('refuses a body that is not a JSON object', async () => {
      const job = await failedJob();
      const request = new Request(RESOLVE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://sp1e.se' },
        body: '[]',
      });

      const failure = await rejection(resolveProviderCallRoute(job.id, request, deps()));

      expect(failure.status).toBe(400);
      expect(failure.code).toBe('invalid_json');
    });
  });

  /**
   * The route reads the row, decides, and only then writes. A resolution that lands in
   * between makes the repository answer `already-resolved`, and that must reach the owner
   * as a 200 describing the row that won — never as a 500, and never as a second write.
   */
  it('reports the winning resolution when one lands between the read and the write', async () => {
    const job = await failedJob();
    await priorCall(job, 0, 'A', 'ambiguous');
    const rival = {
      jobId: job.id,
      attempt: 0,
      label: 'A' as const,
      to: 'abandoned' as const,
      note: 'the rival won',
      now: world.clock.now(),
    };
    // `repoWith` rather than a spread: `world.repo` is a class instance, so `{ ...repo }`
    // copies no prototype method and every call becomes `undefined` — the silent-pass shape
    // the harness exists to prevent, and which this test hit on its first run.
    const raced = repoWith(world.repo, {
      listProviderCalls: async (jobId: string) => {
        const calls = await world.repo.listProviderCalls(jobId);
        await world.repo.resolveProviderCall(rival);
        return calls;
      },
    });

    const body = await readJson<ResolveBody>(
      await resolveProviderCallRoute(
        job.id,
        jsonRequest(RESOLVE_URL, { attempt: 0, label: 'A', to: 'accepted', note: 'i lost' }),
        deps({ repo: raced }),
      ),
    );

    expect(body.outcome).toBe('already-resolved');
    expect(body.call.resolutionNote).toBe('the rival won');
    expect(body.call.state).toBe('abandoned');
  });
});
