import { describe, expect, it } from 'vitest';

import { readFinishingConfig, submitFinish } from './modal';

const CONFIGURED = {
  TWI_MODAL_FINISH_URL: 'https://modal.example/finish/jobs',
  TWI_CALLBACK_ORIGIN: 'https://orchestrator.example',
  STEMS_PROXY_SECRET: 'a-long-random-shared-secret-value',
};

const REQUEST = {
  jobId: '33333333-3333-4333-8333-333333333333',
  attempt: 0,
  label: 'A' as const,
  prefix: 'twi/p/jobs/j/attempt-0/A',
  rawKey: 'twi/p/jobs/j/attempt-0/A/raw.wav',
  callbackId: '55555555-5555-4555-8555-555555555555',
  nonce: '66666666-6666-4666-8666-666666666666',
};

describe('readFinishingConfig', () => {
  it('reads a fully configured deployment', () => {
    expect(readFinishingConfig(CONFIGURED)).toEqual({
      finishUrl: CONFIGURED.TWI_MODAL_FINISH_URL,
      callbackOrigin: CONFIGURED.TWI_CALLBACK_ORIGIN,
      secret: CONFIGURED.STEMS_PROXY_SECRET,
    });
  });

  for (const missing of ['TWI_MODAL_FINISH_URL', 'TWI_CALLBACK_ORIGIN', 'STEMS_PROXY_SECRET'] as const) {
    it(`returns null when ${missing} is absent, so an unconfigured deployment refuses work`, () => {
      const env = { ...CONFIGURED, [missing]: undefined };
      expect(readFinishingConfig(env)).toBeNull();
    });

    it(`returns null when ${missing} is blank rather than trusting whitespace`, () => {
      expect(readFinishingConfig({ ...CONFIGURED, [missing]: '   ' })).toBeNull();
    });
  }

  it('refuses a finish URL that is not https, because the shared secret rides in a header', () => {
    expect(readFinishingConfig({ ...CONFIGURED, TWI_MODAL_FINISH_URL: 'http://modal.example/finish/jobs' })).toBeNull();
  });

  it('refuses a callback origin that is not https', () => {
    expect(readFinishingConfig({ ...CONFIGURED, TWI_CALLBACK_ORIGIN: 'http://orchestrator.example' })).toBeNull();
  });
});

describe('submitFinish', () => {
  const config = readFinishingConfig(CONFIGURED)!;

  it('sends the secret header and the identity Modal must echo, and returns the call id', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const call = await submitFinish(config, REQUEST, async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return Response.json({ call_id: 'fc-01' });
    });

    expect(call).toEqual({ callId: 'fc-01' });
    expect(seen!.url).toBe(CONFIGURED.TWI_MODAL_FINISH_URL);
    const headers = new Headers(seen!.init.headers);
    expect(headers.get('X-Stems-Secret')).toBe(CONFIGURED.STEMS_PROXY_SECRET);
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      job_id: REQUEST.jobId,
      attempt: 0,
      label: 'A',
      output_prefix: REQUEST.prefix,
      input_url: `${CONFIGURED.TWI_CALLBACK_ORIGIN}/internal/raw/${REQUEST.rawKey}`,
      callback_url: `${CONFIGURED.TWI_CALLBACK_ORIGIN}/callback/modal`,
      callback_context: { callback_id: REQUEST.callbackId, nonce: REQUEST.nonce },
    });
  });

  it('refuses a response that names no call id, rather than waiting forever on a call it cannot identify', async () => {
    await expect(submitFinish(config, REQUEST, async () => Response.json({}))).rejects.toThrow('finishing submission was not accepted');
  });

  it('refuses a non-2xx response', async () => {
    await expect(submitFinish(config, REQUEST, async () => new Response('nope', { status: 502 })))
      .rejects.toThrow('finishing submission was not accepted');
  });

  it('refuses a response that is not JSON', async () => {
    await expect(submitFinish(config, REQUEST, async () => new Response('<html>', { status: 200 })))
      .rejects.toThrow('finishing submission was not accepted');
  });
});
