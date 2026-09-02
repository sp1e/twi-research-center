/*
 * The Modal finishing seam: how the Workflow asks for a candidate to be finished, and what
 * it needs configured before it may ask at all.
 *
 * The submission mirrors `POST /finish/jobs` in stems-gpu/app.py exactly. One field is NEW in
 * Task 11: `callback_context`. Modal echoes it back verbatim on the callback, which is what
 * lets the Workflow prove a callback answers the exact call it is waiting on. Without it the
 * callback body carries no per-call secret at all and any holder of the shared secret could
 * answer for any call.
 */

import type { CandidateLabel } from '../providers/types';

export interface FinishingConfig {
  /** Absolute URL of Modal's `POST /finish/jobs`. */
  finishUrl: string;
  /** This Worker's public origin — Modal fetches the raw from it and posts the callback to it. */
  callbackOrigin: string;
  /** The `X-Stems-Secret` shared with the Modal app. */
  secret: string;
}

export interface FinishingEnv {
  TWI_MODAL_FINISH_URL?: string;
  TWI_CALLBACK_ORIGIN?: string;
  STEMS_PROXY_SECRET?: string;
}

export interface FinishSubmission {
  jobId: string;
  attempt: number;
  label: CandidateLabel;
  prefix: string;
  rawKey: string;
  callbackId: string;
  nonce: string;
}

export interface FinishCall {
  callId: string;
}

const isPresent = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/*
 * https ONLY, on both URLs. The shared secret rides in a request header to Modal and Modal
 * rides it back to us; over plaintext it is a secret in name only. An unconfigured or
 * plaintext deployment gets `null`, which the caller turns into a refusal BEFORE the first
 * billable call rather than a failure after two candidates have been paid for.
 */
const httpsUrl = (value: string | undefined): string | null => {
  if (!isPresent(value)) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

export const readFinishingConfig = (env: FinishingEnv): FinishingConfig | null => {
  const finishUrl = httpsUrl(env.TWI_MODAL_FINISH_URL);
  const callbackOrigin = httpsUrl(env.TWI_CALLBACK_ORIGIN);
  if (finishUrl === null || callbackOrigin === null || !isPresent(env.STEMS_PROXY_SECRET)) return null;
  return { finishUrl, callbackOrigin, secret: env.STEMS_PROXY_SECRET };
};

export const rawInputUrl = (config: FinishingConfig, rawKey: string): string =>
  `${config.callbackOrigin}/internal/raw/${rawKey}`;

export const callbackUrl = (config: FinishingConfig): string => `${config.callbackOrigin}/callback/modal`;

/**
 * Submits one finishing job and returns the Modal call id.
 *
 * Every failure is the SAME refusal — "finishing submission was not accepted" — because the
 * caller's only decision is retry-or-not, and the step's retry policy makes that decision. A
 * response this cannot read is treated as a failure rather than as an anonymous call: waiting
 * 30 minutes for an event from a call whose id we never learned is the worst outcome available.
 */
export const submitFinish = async (
  config: FinishingConfig,
  submission: FinishSubmission,
  fetchImpl: typeof fetch = fetch,
): Promise<FinishCall> => {
  const response = await fetchImpl(config.finishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Stems-Secret': config.secret },
    body: JSON.stringify({
      job_id: submission.jobId,
      attempt: submission.attempt,
      label: submission.label,
      output_prefix: submission.prefix,
      input_url: rawInputUrl(config, submission.rawKey),
      callback_url: callbackUrl(config),
      callback_context: { callback_id: submission.callbackId, nonce: submission.nonce },
    }),
  });

  if (!response.ok) throw new Error(`finishing submission was not accepted (HTTP ${response.status})`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('finishing submission was not accepted (response was not JSON)');
  }

  const callId = (body as { call_id?: unknown } | null)?.call_id;
  if (typeof callId !== 'string' || callId.trim().length === 0) {
    throw new Error('finishing submission was not accepted (no call id)');
  }
  return { callId };
};
