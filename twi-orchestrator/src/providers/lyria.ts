import { compileLyriaPrompt, normalizeGenerationSpec } from '../../../src/twi/domain/prompt';
import type { NormalizedGenerationSpec } from '../../../src/twi/domain/schemas';
import type { GenerationSpec } from '../../../src/twi/domain/types';
import { readWavProperties } from '../audio/wav';
import type { CandidateLabel, MusicProvider, ProviderCandidate } from './types';

export const LYRIA_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const LYRIA_MODEL = 'lyria-3-pro-preview';

/*
 * Lyria 3 Pro renders up to roughly 184 seconds while TWI's own schema accepts 240
 * (src/twi/domain/schemas.ts). Sending the difference would be paid for and then refused,
 * so the gap is closed here, before the billable call, and never by silently cropping.
 */
export const LYRIA_MAX_DURATION_SECONDS = 184;

const DEFAULT_COST_USD_PER_CANDIDATE = 0.08;

export type ProviderErrorCode =
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'provider_invalid_audio'
  | 'provider_capability_mismatch';

/*
 * `charged` is the caller's only safe basis for deciding whether a retry can duplicate a
 * payment: false means the money path was never entered, true means it certainly was, and
 * null means the call is AMBIGUOUS and must not be retried without provider-side identity.
 * Messages are fixed strings: no prompt, no key and no response body ever reaches a log.
 */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly charged: boolean | null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface LyriaProviderOptions {
  apiKey: string;
  fetchImpl: typeof fetch;
  costUsdPerCandidate?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/*
 * Walk every `model_output` step and collect EVERY audio block rather than reaching for a
 * fixed path. The envelope below is the shape the plan documents; it has not been confirmed
 * against a live paid call, so an unexpected response reports "no audio" instead of failing
 * somewhere unrecognisable, and two blocks are called ambiguous rather than guessed at.
 */
const audioPayloads = (body: unknown): string[] => {
  const steps = asRecord(body)?.steps;
  if (!Array.isArray(steps)) return [];
  const found: string[] = [];
  for (const step of steps) {
    const content = asRecord(asRecord(step)?.model_output)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const data = asRecord(asRecord(block)?.audio)?.data;
      if (typeof data === 'string' && data.length > 0) found.push(data);
    }
  }
  return found;
};

/*
 * Block markers follow the Gemini generateContent convention. They are UNVERIFIED for the
 * Interactions surface; if they never appear, a refusal simply surfaces as an audio-less
 * success (`provider_invalid_audio`), which is still fail-closed. The canary resolves it.
 */
const blockReason = (body: unknown): string | null => {
  const record = asRecord(body);
  const direct = record?.blockReason;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const feedback = asRecord(record?.promptFeedback)?.blockReason;
  return typeof feedback === 'string' && feedback.length > 0 ? feedback : null;
};

const assertLyriaCanRender = (spec: NormalizedGenerationSpec): void => {
  if (spec.intent.durationSeconds > LYRIA_MAX_DURATION_SECONDS) {
    throw new ProviderError(
      'provider_capability_mismatch',
      `this provider renders at most ${LYRIA_MAX_DURATION_SECONDS} seconds`,
      false,
    );
  }
  if (spec.sound.imageAssetIds.length > 0) {
    throw new ProviderError(
      'provider_capability_mismatch',
      'this provider adapter cannot carry image references yet',
      false,
    );
  }
};

/*
 * The statuses this adapter can POSITIVELY argue are pre-billing: the request was refused before
 * anything was rendered. Nothing else may claim `charged: false`.
 *
 * `charged: false` is not a shrug -- it settles the ledger row as abandoned/not_charged, which is
 * the one verdict that stops blocking a retry, so a wrong `false` here is what buys a second
 * render with no human consulted. A 408 Request Timeout, a 425 Too Early and a 499 from an
 * intermediary are the shapes a front door returns WHILE the upstream render proceeds; they prove
 * nothing about billing, which is exactly the reasoning the 5xx branch below already applies.
 * An unrecognised status proves less still. Both therefore answer `null` -> ambiguous -> blocked
 * until a human resolves it.
 */
const PRE_BILLING_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

const httpFailure = (status: number): ProviderError => {
  if (status === 429) {
    return new ProviderError('provider_unavailable', 'the provider rate limited this request', false);
  }
  if (PRE_BILLING_STATUSES.has(status)) {
    return new ProviderError('provider_rejected', 'the provider rejected this request', false);
  }
  if (status >= 500) {
    // The render may have completed and been billed before the failure surfaced.
    return new ProviderError('provider_unavailable', 'the provider failed to serve this request', null);
  }
  return new ProviderError('provider_unavailable', 'the provider did not answer this request conclusively', null);
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new ProviderError('provider_invalid_audio', 'the provider returned an unreadable body', true);
  }
};

const decodeAudio = (payloads: string[]): Uint8Array => {
  if (payloads.length === 0) {
    throw new ProviderError('provider_invalid_audio', 'the provider returned no audio', true);
  }
  if (payloads.length > 1) {
    throw new ProviderError('provider_invalid_audio', 'the provider returned more than one audio block', true);
  }
  try {
    return decodeBase64(payloads[0]);
  } catch {
    throw new ProviderError('provider_invalid_audio', 'the provider returned undecodable audio', true);
  }
};

/*
 * A paid call whose provider request id we cannot record is unreconcilable: there would be
 * a charge on the account with nothing in provenance to match it against. The audio is
 * discarded rather than published unattributable -- and because the provenance guard
 * compares this value on both sides, a blank one would otherwise compare equal to itself.
 */
const requireRequestId = (value: unknown): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (id.length === 0) {
    throw new ProviderError('provider_invalid_audio', 'the provider returned no request id', true);
  }
  return id;
};

const measureWav = (bytes: Uint8Array): { durationSeconds: number } => {
  try {
    return readWavProperties(bytes);
  } catch {
    throw new ProviderError('provider_invalid_audio', 'the provider returned audio that is not a WAV', true);
  }
};

export class LyriaMusicProvider implements MusicProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly costUsdPerCandidate: number;

  constructor({ apiKey, fetchImpl, costUsdPerCandidate }: LyriaProviderOptions) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.costUsdPerCandidate = costUsdPerCandidate ?? DEFAULT_COST_USD_PER_CANDIDATE;
  }

  async generate(spec: GenerationSpec, label: CandidateLabel): Promise<ProviderCandidate> {
    /*
     * `normalizeGenerationSpec` throws a ZodError, not a ProviderError, so nothing settles the
     * claim row this call was made under: it stays `submitting`, the retry gate blocks the job,
     * and only a human resolution can free it. That is the correct failure for MONEY (an
     * unsettled claim always blocks) and the wrong one for a defect that cost nothing -- so it
     * matters that it is unreachable in production. The specification is FROZEN and parsed
     * through this same schema at submit (src/twi/server/jobs.ts), and the Workflow's load-job
     * step reads that stored document; a spec that reaches here has already parsed once. If a
     * schema change ever makes a stored document unparseable, validate it in load-job -- BEFORE
     * the claim -- the way `canCompleteRender` already gates the finishing configuration.
     */
    const normalized = normalizeGenerationSpec(spec);
    assertLyriaCanRender(normalized);

    const response = await this.post(compileLyriaPrompt(normalized));
    if (!response.ok) throw httpFailure(response.status);

    const body = await readJson(response);
    if (blockReason(body) !== null) {
      throw new ProviderError('provider_rejected', 'the provider refused to render this request', null);
    }

    const bytes = decodeAudio(audioPayloads(body));
    return {
      label,
      bytes,
      contentType: 'audio/wav',
      provider: 'lyria',
      model: LYRIA_MODEL,
      durationSeconds: measureWav(bytes).durationSeconds,
      providerCostUsd: this.costUsdPerCandidate,
      providerRequestId: requireRequestId(asRecord(body)?.id),
    };
  }

  private async post(prompt: string): Promise<Response> {
    try {
      return await this.fetchImpl(LYRIA_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({ model: LYRIA_MODEL, input: prompt, response_format: { type: 'audio' } }),
      });
    } catch {
      // The request may have reached the provider and been served; the charge is unknown.
      throw new ProviderError('provider_unavailable', 'the provider could not be reached', null);
    }
  }
}
