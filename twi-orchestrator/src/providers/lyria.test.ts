import { describe, expect, it } from 'vitest';

import { compileLyriaPrompt, normalizeGenerationSpec } from '../../../src/twi/domain/prompt';
import { draft } from '../../../src/twi/domain/spec.fixture';
import type { GenerationSpec } from '../../../src/twi/domain/types';
import { createSineWav } from '../audio/wav';
import { LYRIA_ENDPOINT, LYRIA_MAX_DURATION_SECONDS, LYRIA_MODEL, LyriaMusicProvider, ProviderError } from './lyria';

const spec = draft as GenerationSpec;

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** A three-second WAV, deliberately unlike the spec's 150-second request. */
const returnedWav = createSineWav({ seconds: 3, frequencyHz: 440, sampleRate: 8_000 });

interface Capture {
  url: string;
  init: RequestInit;
}

const respondingWith = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
  const calls: Capture[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const audioResponse = (bytes: Uint8Array, id = 'ir_abc123') => ({
  id,
  steps: [
    { model_output: { content: [{ audio: { data: base64(bytes), mime_type: 'audio/wav' } }] } },
  ],
});

describe('LyriaMusicProvider request contract', () => {
  it('posts the compiled prompt to the official Interactions endpoint with the key in the header', async () => {
    const { calls, fetchImpl } = respondingWith(audioResponse(returnedWav));
    const provider = new LyriaMusicProvider({ apiKey: 'test-key', fetchImpl });

    await provider.generate(spec, 'A');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(LYRIA_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');

    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('x-goog-api-key')).toBe('test-key');
    expect(headers.get('content-type')).toBe('application/json');

    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: LYRIA_MODEL,
      input: compileLyriaPrompt(normalizeGenerationSpec(spec)),
      response_format: { type: 'audio' },
    });
  });

  it('reports the duration measured from the returned WAV, not the duration that was requested', async () => {
    const { fetchImpl } = respondingWith(audioResponse(returnedWav));
    const provider = new LyriaMusicProvider({ apiKey: 'test-key', fetchImpl, costUsdPerCandidate: 0.08 });

    const candidate = await provider.generate(spec, 'B');

    expect(spec.intent.durationSeconds).toBe(150);
    expect(candidate).toEqual({
      label: 'B',
      bytes: returnedWav,
      contentType: 'audio/wav',
      provider: 'lyria',
      model: LYRIA_MODEL,
      durationSeconds: 3,
      providerCostUsd: 0.08,
      providerRequestId: 'ir_abc123',
    });
  });
});

const throwingFetch = () => {
  const calls: Capture[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    throw new TypeError('network is unreachable');
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const withDuration = (durationSeconds: number): GenerationSpec =>
  ({ ...draft, intent: { ...draft.intent, durationSeconds } }) as GenerationSpec;

const generateFailure = async (
  fetchImpl: typeof fetch,
  target: GenerationSpec = spec,
): Promise<ProviderError> => {
  const provider = new LyriaMusicProvider({ apiKey: 'test-key', fetchImpl });
  try {
    await provider.generate(target, 'A');
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected the provider to reject');
};

describe('LyriaMusicProvider capability preflight', () => {
  it('refuses a longer render than Lyria supports without ever making the billable call', async () => {
    const { calls, fetchImpl } = respondingWith(audioResponse(returnedWav));

    const error = await generateFailure(fetchImpl, withDuration(LYRIA_MAX_DURATION_SECONDS + 1));

    expect(error.code).toBe('provider_capability_mismatch');
    expect(error.charged).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('accepts a render at exactly the supported maximum', async () => {
    const { calls, fetchImpl } = respondingWith(audioResponse(returnedWav));
    const provider = new LyriaMusicProvider({ apiKey: 'test-key', fetchImpl });

    await provider.generate(withDuration(LYRIA_MAX_DURATION_SECONDS), 'A');

    expect(calls).toHaveLength(1);
  });

  it('refuses image-conditioned specs rather than silently dropping the references', async () => {
    const { calls, fetchImpl } = respondingWith(audioResponse(returnedWav));
    const withImages = { ...draft, sound: { ...draft.sound, imageAssetIds: ['33333333-3333-4333-8333-333333333333'] } } as GenerationSpec;

    const error = await generateFailure(fetchImpl, withImages);

    expect(error.code).toBe('provider_capability_mismatch');
    expect(error.charged).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('LyriaMusicProvider failure taxonomy', () => {
  it('maps a rejected request to provider_rejected and states it was not billed', async () => {
    const { fetchImpl } = respondingWith({ error: { message: 'bad request' } }, 400);
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_rejected');
    expect(error.charged).toBe(false);
  });

  it('maps rate limiting to provider_unavailable and states it was not billed', async () => {
    const { fetchImpl } = respondingWith({ error: { message: 'slow down' } }, 429);
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_unavailable');
    expect(error.charged).toBe(false);
  });

  it('leaves a server error ambiguous, because the render may already have been billed', async () => {
    const { fetchImpl } = respondingWith({ error: { message: 'boom' } }, 503);
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_unavailable');
    expect(error.charged).toBeNull();
  });

  /*
   * The 4xx catch-all. `charged: false` is the verdict that lets the retry gate spend again with
   * no human consulted (an `abandoned`/`not_charged` row does not block), so only statuses the
   * adapter can positively argue are PRE-BILLING may claim it. A 408 Request Timeout, a 425 Too
   * Early and a 499 from an intermediary are the shapes a front door returns while the upstream
   * render proceeds -- they prove nothing about billing, exactly as the 5xx comment says of 5xx.
   */
  it.each([408, 425, 499, 402, 418, 451] as const)(
    'leaves an unrecognised %s ambiguous: below 500 is not by itself proof that nothing was billed',
    async (status) => {
      const { fetchImpl } = respondingWith({ error: { message: 'no verdict' } }, status);
      const error = await generateFailure(fetchImpl);
      expect(error.charged).toBeNull();
    },
  );

  it.each([
    [400, 'a malformed request'],
    [401, 'a rejected key'],
    [403, 'a forbidden key'],
    [404, 'an unknown model'],
    [422, 'a request the provider would not process'],
  ] as const)('still states %s (%s) was not billed, because it never reached a render', async (status, _why) => {
    const { fetchImpl } = respondingWith({ error: { message: 'nope' } }, status);
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_rejected');
    expect(error.charged).toBe(false);
  });

  it('leaves a transport failure ambiguous, because the request may still have been served', async () => {
    const { fetchImpl } = throwingFetch();
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_unavailable');
    expect(error.charged).toBeNull();
  });

  it('maps a safety block to provider_rejected with an unknown charge', async () => {
    const { fetchImpl } = respondingWith({ id: 'ir_1', promptFeedback: { blockReason: 'SAFETY' }, steps: [] });
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_rejected');
    expect(error.charged).toBeNull();
  });

  it('treats a successful response that carries no audio as billed and invalid', async () => {
    const { fetchImpl } = respondingWith({ id: 'ir_1', steps: [{ model_output: { content: [{ text: 'hello' }] } }] });
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_invalid_audio');
    expect(error.charged).toBe(true);
  });

  it('refuses to guess when a response carries more than one audio block', async () => {
    const { fetchImpl } = respondingWith({
      id: 'ir_1',
      steps: [
        { model_output: { content: [{ audio: { data: base64(returnedWav) } }] } },
        { model_output: { content: [{ audio: { data: base64(returnedWav) } }] } },
      ],
    });
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_invalid_audio');
    expect(error.charged).toBe(true);
  });

  it('rejects malformed base64 as invalid audio', async () => {
    const { fetchImpl } = respondingWith({
      id: 'ir_1',
      steps: [{ model_output: { content: [{ audio: { data: 'not!valid!base64' } }] } }],
    });
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_invalid_audio');
    expect(error.charged).toBe(true);
  });

  it('rejects a decodable payload that is not a RIFF/WAVE container', async () => {
    const { fetchImpl } = respondingWith({
      id: 'ir_1',
      steps: [{ model_output: { content: [{ audio: { data: base64(new Uint8Array([1, 2, 3, 4])) } }] } }],
    });
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_invalid_audio');
    expect(error.charged).toBe(true);
  });

  it('refuses a billed response that carries no request id, which could never be reconciled', async () => {
    const { fetchImpl } = respondingWith({
      steps: [{ model_output: { content: [{ audio: { data: base64(returnedWav) } }] } }],
    });
    const error = await generateFailure(fetchImpl);
    expect(error.code).toBe('provider_invalid_audio');
    expect(error.charged).toBe(true);
  });

  it('refuses a blank request id for the same reason', async () => {
    const { fetchImpl } = respondingWith({
      id: '   ',
      steps: [{ model_output: { content: [{ audio: { data: base64(returnedWav) } }] } }],
    });
    expect((await generateFailure(fetchImpl)).code).toBe('provider_invalid_audio');
  });

  it('never leaks the prompt, the api key or the response body into a failure', async () => {
    const { fetchImpl } = respondingWith({ error: { message: 'SECRET-BODY-MARKER' } }, 400);
    const error = await generateFailure(fetchImpl);
    const rendered = `${error.message} ${error.stack ?? ''}`;
    expect(rendered).not.toContain('test-key');
    expect(rendered).not.toContain('SECRET-BODY-MARKER');
    expect(rendered).not.toContain('leaving home');
  });
});
