import { TwiWorkflowStore } from './db';
import { assertCallbackAuthentic, secretsMatch } from './finishing/callback-auth';
import { parseFinishCallback } from './finishing/manifest';
import { readFinishingConfig } from './finishing/modal';
import { canCompleteRender, createProvider } from './providers/select';
import type { OrchestratorEnv, StartPayload } from './workflow';
import { TwiRenderWorkflow } from './workflow';

export { TwiRenderWorkflow };

export const START_PAYLOAD_KEYS = [
  'schemaVersion',
  'jobId',
  'projectId',
  'specId',
  'specSha256',
  'idempotencyKey',
  'attempt',
  'estimate',
] as const;

const CANCEL_PAYLOAD_KEYS = ['schemaVersion', 'jobId', 'projectId', 'attempt'] as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const response = (body: Record<string, unknown>, status = 200): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const errorResponse = (status: number, code: string, message: string): Response =>
  response({ ok: false, error: { code, message } }, status);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const observed = Object.keys(value);
  return observed.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};

const isNonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isAttempt = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

const readObject = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await request.json();
    if (!isObject(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'invalid_request', 'invalid request envelope');
  }
};

export const parseStartPayload = (value: unknown): StartPayload => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, START_PAYLOAD_KEYS) ||
    value.schemaVersion !== 1 ||
    !isNonBlank(value.jobId) ||
    !isNonBlank(value.projectId) ||
    !isNonBlank(value.specId) ||
    !isNonBlank(value.specSha256) ||
    !isNonBlank(value.idempotencyKey) ||
    !isAttempt(value.attempt) ||
    !(value.estimate === null || isObject(value.estimate))
  ) {
    throw new HttpError(400, 'invalid_request', 'invalid request envelope');
  }
  return value as unknown as StartPayload;
};

const parseCancelPayload = (value: unknown, pathJobId: string): { attempt: number } => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, CANCEL_PAYLOAD_KEYS) ||
    value.schemaVersion !== 1 ||
    value.jobId !== pathJobId ||
    !isNonBlank(value.projectId) ||
    !isAttempt(value.attempt)
  ) {
    throw new HttpError(400, 'invalid_request', 'invalid request envelope');
  }
  return { attempt: value.attempt };
};

const requireMethod = (request: Request, expected: 'GET' | 'POST'): void => {
  if (request.method !== expected) throw new HttpError(405, 'method_not_allowed', 'method not allowed');
};

/**
 * THE SEPARATOR IS AN UNDERSCORE, NOT THE COLON THE PLAN'S AMENDMENT WROTE, and the
 * reason is a hard runtime constraint rather than taste. Cloudflare validates a Workflow
 * instance id against `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, capped at 100 characters
 * (ALLOWED_STRING_ID_PATTERN / MAX_WORKFLOW_INSTANCE_ID_LENGTH in the workflows binding).
 * A colon is not in that set, so `${jobId}:${attempt}` is REJECTED by create() with an
 * opaque "Workflow instance has invalid id" -- the amendment prescribed an id the
 * platform cannot store.
 *
 * The amendment's actual requirement survives untouched: identity is the PAIR (job,
 * attempt), so a retry gets its own instance instead of being handed back the failed
 * first run. Only the character carrying that pair changes. Underscore is preferred over
 * hyphen because a UUID job id contains hyphens and never underscores, so the last-
 * separator split stays obvious to a reader as well as to a parser.
 *
 * NOTE the D1 event key in db.ts keeps its colons. `${jobId}:${attempt}:${status}` must
 * match src/twi/server/jobs.ts:120 byte for byte; it is a database key with no character
 * restriction, and it is a different identifier from this one.
 *
 * An id that cannot be represented is REFUSED here, by name, rather than left to fail
 * deep inside create(): a 400 that says which field is unusable beats a 500 that says
 * nothing.
 */
const WORKFLOW_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;
const MAX_WORKFLOW_INSTANCE_ID_LENGTH = 100;

export const workflowInstanceId = (jobId: string, attempt: number): string => {
  if (!isNonBlank(jobId) || !isAttempt(attempt)) throw new HttpError(400, 'invalid_request', 'invalid request envelope');
  const id = `${jobId}_${attempt}`;
  if (id.length > MAX_WORKFLOW_INSTANCE_ID_LENGTH || !WORKFLOW_INSTANCE_ID_PATTERN.test(id)) {
    throw new HttpError(400, 'unrepresentable_instance_id', 'job id cannot form a workflow instance id');
  }
  return id;
};

/**
 * The local Workflow runtime does NOT represent an absent instance as a status -- it
 * throws. Two distinct messages mean the same thing, and both are taken from the
 * runtime's own source rather than guessed: `instance.not_found` is thrown by
 * WorkflowBinding.get when no instance exists, and `Engine was never started` by
 * Engine.getStatus when an instance exists but its engine has not spun up yet.
 * miniflare's own explorer worker treats exactly this pair as "not found"
 * (miniflare/dist/src/workers/local-explorer/explorer.worker.js).
 *
 * ONLY those two map to `unknown`, and the narrowness is load-bearing. A generic
 * infrastructure failure swallowed here would read as "no instance exists", send
 * /start on to create(), and produce a SECOND paid render for a job that already has
 * one. Everything else is rethrown so it surfaces as a 500 rather than as money.
 */
const ABSENT_INSTANCE_MESSAGES = new Set(['instance.not_found', 'Engine was never started']);

const isAbsentInstance = (error: unknown): boolean =>
  error instanceof Error && ABSENT_INSTANCE_MESSAGES.has(error.message);

const statusOf = async (workflow: Workflow<StartPayload>, id: string): Promise<InstanceStatus['status']> => {
  try {
    return (await (await workflow.get(id)).status()).status;
  } catch (error) {
    if (isAbsentInstance(error)) return 'unknown';
    throw error;
  }
};

/**
 * A just-created instance is KNOWN to exist, so an absent-engine throw here is a race
 * with start-up, not a missing instance. Reporting `queued` states what is true; a
 * rethrow would 500 on a render that was successfully created and is about to run.
 */
const createdStatus = async (instance: WorkflowInstance): Promise<InstanceStatus['status']> => {
  try {
    return (await instance.status()).status;
  } catch (error) {
    if (isAbsentInstance(error)) return 'queued';
    throw error;
  }
};

const startWorkflow = async (request: Request, env: OrchestratorEnv): Promise<Response> => {
  requireMethod(request, 'POST');
  const payload = parseStartPayload(await readObject(request));
  if (createProvider({ mode: env.TWI_PROVIDER_MODE, apiKey: env.GEMINI_API_KEY }) === null) {
    throw new HttpError(503, 'provider_not_configured', 'music provider is not configured');
  }
  // Refuse a render this build cannot finish before the caller can be billed for it.
  if (!canCompleteRender(env.TWI_PROVIDER_MODE, readFinishingConfig(env))) {
    throw new HttpError(503, 'finishing_not_configured', 'this deployment cannot finish a render');
  }

  const id = workflowInstanceId(payload.jobId, payload.attempt);
  const existingStatus = await statusOf(env.TWI_RENDER_WORKFLOW, id);
  if (existingStatus !== 'unknown') {
    return response({ ok: true, created: false, instance: { id, status: existingStatus } });
  }

  try {
    const instance = await env.TWI_RENDER_WORKFLOW.create({ id, params: payload });
    const status = await createdStatus(instance);
    return response({ ok: true, created: true, instance: { id, status } }, 202);
  } catch (error) {
    const racedStatus = await statusOf(env.TWI_RENDER_WORKFLOW, id);
    if (racedStatus !== 'unknown') {
      return response({ ok: true, created: false, instance: { id, status: racedStatus } });
    }
    throw error;
  }
};

/** `/status/:id` takes the exact Workflow instance id, including its `_attempt` suffix. */
const workflowStatus = async (request: Request, env: OrchestratorEnv, encodedId: string): Promise<Response> => {
  requireMethod(request, 'GET');
  const id = decodeURIComponent(encodedId);
  const status = await statusOf(env.TWI_RENDER_WORKFLOW, id);
  if (status === 'unknown') throw new HttpError(404, 'instance_not_found', 'workflow instance was not found');
  return response({ ok: true, instance: { id, status } });
};

const cancelWorkflow = async (
  request: Request,
  env: OrchestratorEnv,
  encodedJobId: string,
): Promise<Response> => {
  requireMethod(request, 'POST');
  const jobId = decodeURIComponent(encodedJobId);
  const { attempt } = parseCancelPayload(await readObject(request), jobId);
  const id = workflowInstanceId(jobId, attempt);
  const instance = await env.TWI_RENDER_WORKFLOW.get(id);
  const before = await instance.status();
  if (before.status === 'unknown') throw new HttpError(404, 'instance_not_found', 'workflow instance was not found');
  if (['complete', 'errored', 'terminated'].includes(before.status)) {
    throw new HttpError(409, 'instance_not_cancellable', 'workflow instance cannot be cancelled');
  }
  await instance.terminate();
  return response({ ok: true, instance: { id, status: (await instance.status()).status } });
};

/*
 * THE ONLY R2 KEY THIS WORKER WILL SERVE, and it is a whole-string match on purpose.
 *
 * Modal's finishing job downloads the raw over HTTP, so this route exists. It is also, by
 * construction, a read oracle over the bucket, and the bucket holds every project's audio. So
 * it serves EXACTLY the shape Task 8 writes -- `raw.wav` under a job attempt's candidate
 * prefix -- and nothing else: no provenance, no archive, no review, no traversal, no other
 * project's key spelled to look like one. The same layout `stems-gpu/finish.py` validates
 * (OUTPUT_PREFIX_PATTERN), extended by the one file name it is allowed to fetch.
 */
const RAW_OBJECT_KEY_PATTERN =
  /^twi\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/attempt-\d+\/[AB]\/raw\.wav$/;

/**
 * `GET /internal/raw/<key>` — the raw candidate, for the Modal finishing job only.
 *
 * Gated on the shared secret before anything else, and on the key pattern before R2 is touched
 * at all, so an unauthenticated caller cannot even use the 404/200 difference to probe which
 * keys exist.
 */
const serveRawObject = async (request: Request, env: OrchestratorEnv, encodedKey: string): Promise<Response> => {
  requireMethod(request, 'GET');
  const config = readFinishingConfig(env);
  if (config === null) throw new HttpError(503, 'finishing_not_configured', 'this deployment cannot finish a render');
  if (!secretsMatch(request.headers.get('X-Stems-Secret'), config.secret)) {
    throw new HttpError(401, 'callback_unauthorized', 'unauthorized');
  }

  const key = decodeURIComponent(encodedKey);
  if (!RAW_OBJECT_KEY_PATTERN.test(key)) throw new HttpError(404, 'not_found', 'route not found');

  const object = await env.FILES.get(key);
  if (!object) throw new HttpError(404, 'not_found', 'route not found');
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
};

/**
 * `POST /callback/modal` — the finishing callback, and the ONLY way an event reaches a
 * Workflow from outside.
 *
 * It must satisfy every one of these before `sendEvent`, in this order, and each answers with
 * a code rather than a description:
 *
 *   1. the deployment has Modal finishing configured at all;
 *   2. the `X-Stems-Secret` shared secret, compared without an early return;
 *   3. an envelope this build fully understands -- exact keys, exact types;
 *   4. a replay TIMESTAMP inside a five-minute window, plus a NONCE and a CALLBACK ID that are
 *      two distinct opaque tokens;
 *   5. a Workflow instance for `${jobId}_${attempt}` that actually exists;
 *   6. a callback id this job has never seen, refused BY THE DATABASE -- `event_key` is
 *      `UNIQUE (job_id, event_key)`, so a replay cannot insert and is answered 200 with
 *      `outcome: 'replayed'` and NO second event.
 *
 * What it deliberately does NOT do is decide whether the callback answers the call the
 * Workflow is waiting on. That needs the submitted call's own identity, which lives in the
 * Workflow's durable step result and not in any table this route can read; `validate-{label}`
 * checks it there (`assertCallbackBindsCall`). So a holder of the shared secret can make a
 * render FAIL, but cannot make one publish audio it did not commission.
 */
const modalCallback = async (request: Request, env: OrchestratorEnv): Promise<Response> => {
  requireMethod(request, 'POST');
  const config = readFinishingConfig(env);
  if (config === null) throw new HttpError(503, 'finishing_not_configured', 'this deployment cannot finish a render');

  const body = await readObject(request);
  const envelope = (() => {
    try {
      return parseFinishCallback(body);
    } catch {
      throw new HttpError(400, 'invalid_request', 'invalid request envelope');
    }
  })();

  try {
    assertCallbackAuthentic({
      presentedSecret: request.headers.get('X-Stems-Secret'),
      expectedSecret: config.secret,
      timestamp: envelope.timestamp,
      nonce: envelope.nonce,
      callbackId: envelope.callbackId,
      now: Date.now(),
    });
  } catch (error) {
    throw new HttpError(401, error instanceof Error ? error.message : 'callback_unauthorized', 'unauthorized');
  }

  const id = workflowInstanceId(envelope.jobId, envelope.attempt);
  if ((await statusOf(env.TWI_RENDER_WORKFLOW, id)) === 'unknown') {
    throw new HttpError(404, 'instance_not_found', 'workflow instance was not found');
  }

  const outcome = await new TwiWorkflowStore(env.DB).recordFinishCallback({
    jobId: envelope.jobId,
    attempt: envelope.attempt,
    label: envelope.label,
    callbackId: envelope.callbackId,
    nonce: envelope.nonce,
    callId: envelope.callId,
    now: new Date().toISOString(),
  });
  if (outcome === 'unknown-job') throw new HttpError(404, 'instance_not_found', 'workflow instance was not found');
  if (outcome === 'replayed') return response({ ok: true, outcome: 'replayed' });

  const instance = await env.TWI_RENDER_WORKFLOW.get(id);
  await instance.sendEvent({
    type: `modal-finished-${envelope.label}`,
    payload: { envelopeJson: JSON.stringify(envelope) },
  });
  return response({ ok: true, outcome: 'accepted' });
};

const fetchHandler = async (request: Request, env: OrchestratorEnv): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (pathname === '/start') return startWorkflow(request, env);
  if (pathname === '/callback/modal') return modalCallback(request, env);
  const raw = pathname.match(/^\/internal\/raw\/(.+)$/);
  if (raw) return serveRawObject(request, env, raw[1]!);
  const status = pathname.match(/^\/status\/([^/]+)$/);
  if (status) return workflowStatus(request, env, status[1]!);
  const cancel = pathname.match(/^\/cancel\/([^/]+)$/);
  if (cancel) return cancelWorkflow(request, env, cancel[1]!);
  throw new HttpError(404, 'not_found', 'route not found');
};

export default {
  async fetch(request: Request, env: OrchestratorEnv): Promise<Response> {
    try {
      return await fetchHandler(request, env);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
      console.error('[twi-orchestrator] request failed', { error: error instanceof Error ? error.name : typeof error });
      return errorResponse(500, 'internal_error', 'internal service error');
    }
  },

  queue(batch: MessageBatch): void {
    // Task 8 reserves the configured queue but starts Workflows through the service binding.
    // Unknown queued work is retried rather than acknowledged and lost.
    batch.retryAll();
  },
} satisfies ExportedHandler<OrchestratorEnv>;
