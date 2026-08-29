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

export const workflowInstanceId = (jobId: string, attempt: number): string => {
  if (!isNonBlank(jobId) || !isAttempt(attempt)) throw new HttpError(400, 'invalid_request', 'invalid request envelope');
  return `${jobId}:${attempt}`;
};

const statusOf = async (workflow: Workflow<StartPayload>, id: string): Promise<InstanceStatus> =>
  (await (await workflow.get(id)).status()).status;

const startWorkflow = async (request: Request, env: OrchestratorEnv): Promise<Response> => {
  requireMethod(request, 'POST');
  const payload = parseStartPayload(await readObject(request));
  if (env.TWI_PROVIDER_MODE !== 'fake') {
    throw new HttpError(503, 'provider_not_configured', 'music provider is not configured');
  }

  const id = workflowInstanceId(payload.jobId, payload.attempt);
  const existingStatus = await statusOf(env.TWI_RENDER_WORKFLOW, id);
  if (existingStatus !== 'unknown') {
    return response({ ok: true, created: false, instance: { id, status: existingStatus } });
  }

  try {
    const instance = await env.TWI_RENDER_WORKFLOW.create({ id, params: payload });
    const status = (await instance.status()).status;
    return response({ ok: true, created: true, instance: { id, status } }, 202);
  } catch (error) {
    const racedStatus = await statusOf(env.TWI_RENDER_WORKFLOW, id);
    if (racedStatus !== 'unknown') {
      return response({ ok: true, created: false, instance: { id, status: racedStatus } });
    }
    throw error;
  }
};

/** `/status/:id` takes the exact Workflow instance id, including its `:attempt` suffix. */
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

const fetchHandler = async (request: Request, env: OrchestratorEnv): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (pathname === '/start') return startWorkflow(request, env);
  if (pathname === '/callback/modal') {
    requireMethod(request, 'POST');
    return errorResponse(501, 'modal_callback_not_configured', 'Modal callback is not configured');
  }
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
