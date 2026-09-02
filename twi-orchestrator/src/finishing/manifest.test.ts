import { describe, expect, it } from 'vitest';

import {
  assertCallbackBindsCall,
  assertFinishManifest,
  expectedFinishKeys,
  parseFinishCallback,
  REVIEW_MAX_TRUE_PEAK_DBTP,
  REVIEW_TARGET_LUFS,
  REVIEW_TOLERANCE_LUFS,
  DURATION_TOLERANCE_SECONDS,
  type FinishCallRecord,
} from './manifest';

const PREFIX = 'twi/11111111-1111-4111-8111-111111111111/jobs/33333333-3333-4333-8333-333333333333/attempt-0/A';

const CALL: FinishCallRecord = {
  label: 'A',
  prefix: PREFIX,
  callId: 'fc-01',
  callbackId: '55555555-5555-4555-8555-555555555555',
  nonce: '66666666-6666-4666-8666-666666666666',
  jobId: '33333333-3333-4333-8333-333333333333',
  attempt: 0,
  rawSizeBytes: 480_044,
  rawDurationSeconds: 30,
};

const manifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  prefix: PREFIX,
  raw: {
    r2_key: `${PREFIX}/raw.wav`,
    content_type: 'audio/wav',
    bytes: 480_044,
    duration_seconds: 30,
    sample_rate: 8_000,
    channels: 1,
    loudness_target_lufs: null,
  },
  archive: {
    r2_key: `${PREFIX}/archive.flac`,
    content_type: 'audio/flac',
    bytes: 220_000,
    duration_seconds: 30,
    sample_rate: 8_000,
    channels: 1,
    loudness_target_lufs: null,
    integrated_lufs: -21.4,
    true_peak_dbtp: -6.1,
    loudness_range: 9.2,
  },
  review: {
    r2_key: `${PREFIX}/review.mp3`,
    content_type: 'audio/mpeg',
    bytes: 1_200_000,
    duration_seconds: 30,
    sample_rate: 48_000,
    channels: 1,
    loudness_target_lufs: -14,
    integrated_lufs: -14.1,
    true_peak_dbtp: -1.3,
    loudness_range: 9.2,
  },
  ffmpeg_version: 'ffmpeg version 7.1',
  command_digest: 'a'.repeat(64),
  ...overrides,
});

const withRendition = (name: 'raw' | 'archive' | 'review', patch: Record<string, unknown>) => {
  const base = manifest();
  return manifest({ [name]: { ...(base[name] as Record<string, unknown>), ...patch } });
};

const callback = (overrides: Record<string, unknown> = {}): unknown => ({
  schemaVersion: 1,
  callbackId: CALL.callbackId,
  nonce: CALL.nonce,
  timestamp: '2026-08-30T10:00:00.000Z',
  callId: CALL.callId,
  jobId: CALL.jobId,
  attempt: CALL.attempt,
  label: CALL.label,
  prefix: PREFIX,
  status: 'done',
  manifest: manifest(),
  ...overrides,
});

describe('expectedFinishKeys', () => {
  it('names the three renditions Task 10 actually writes, and never a "master"', () => {
    expect(expectedFinishKeys(PREFIX)).toEqual({
      raw: `${PREFIX}/raw.wav`,
      archive: `${PREFIX}/archive.flac`,
      review: `${PREFIX}/review.mp3`,
    });
  });
});

describe('the gate constants agree with stems-gpu/finish.py', () => {
  it('re-validates against the shipped constants rather than the plan\'s superseded range', () => {
    expect(REVIEW_TARGET_LUFS).toBe(-14);
    expect(REVIEW_MAX_TRUE_PEAK_DBTP).toBe(-1);
    expect(REVIEW_TOLERANCE_LUFS).toBe(0.5);
    expect(DURATION_TOLERANCE_SECONDS).toBe(0.25);
  });
});

describe('parseFinishCallback', () => {
  it('accepts a well-formed done envelope', () => {
    const parsed = parseFinishCallback(callback());
    expect(parsed.label).toBe('A');
    expect(parsed.callId).toBe('fc-01');
  });

  // The route forwards the PARSED envelope to the Workflow, which parses it again. An
  // envelope this function will not accept back from itself would make every callback die in
  // `validate-{label}` with a message about the envelope rather than about the call.
  it('produces an envelope it will itself accept, so the route-to-Workflow round trip survives', () => {
    const once = parseFinishCallback(callback());
    expect(parseFinishCallback(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('refuses an envelope with an unexpected extra key', () => {
    expect(() => parseFinishCallback(callback({ extra: true }))).toThrow('invalid callback envelope');
  });

  for (const missing of ['callbackId', 'nonce', 'timestamp', 'callId', 'jobId', 'attempt', 'label', 'prefix']) {
    it(`refuses an envelope with no ${missing}`, () => {
      const body = callback() as Record<string, unknown>;
      delete body[missing];
      expect(() => parseFinishCallback(body)).toThrow('invalid callback envelope');
    });
  }

  it('refuses a label that is neither A nor B', () => {
    expect(() => parseFinishCallback(callback({ label: 'C' }))).toThrow('invalid callback envelope');
  });

  it('refuses a non-object manifest on a done callback', () => {
    expect(() => parseFinishCallback(callback({ manifest: 'ok' }))).toThrow('invalid callback envelope');
  });

  it('accepts an error callback that carries a message instead of a manifest', () => {
    const parsed = parseFinishCallback(callback({ status: 'error', manifest: null, error: 'finishing failed' }));
    expect(parsed.status).toBe('error');
  });
});

describe('assertCallbackBindsCall', () => {
  it('accepts the callback that answers the exact call', () => {
    expect(() => assertCallbackBindsCall(CALL, parseFinishCallback(callback()))).not.toThrow();
  });

  for (const [field, wrong] of [
    ['callId', 'fc-02'],
    ['callbackId', '99999999-9999-4999-8999-999999999999'],
    ['nonce', '99999999-9999-4999-8999-999999999999'],
    ['jobId', '99999999-9999-4999-8999-999999999999'],
    ['label', 'B'],
    ['prefix', PREFIX.replace('/A', '/B')],
  ] as const) {
    it(`refuses a callback whose ${field} names a different call`, () => {
      const parsed = parseFinishCallback(callback({ [field]: wrong }));
      expect(() => assertCallbackBindsCall(CALL, parsed)).toThrow('callback does not answer this finishing call');
    });
  }

  it('refuses a callback for a different attempt', () => {
    const parsed = parseFinishCallback(callback({ attempt: 1 }));
    expect(() => assertCallbackBindsCall(CALL, parsed)).toThrow('callback does not answer this finishing call');
  });

  it('refuses a callback reporting an error, naming the failure', () => {
    const parsed = parseFinishCallback(callback({ status: 'error', manifest: null, error: 'ffmpeg died' }));
    expect(() => assertCallbackBindsCall(CALL, parsed)).toThrow('finishing failed');
  });
});

describe('assertFinishManifest', () => {
  it('accepts a manifest shaped exactly as stems-gpu/finish.py builds one', () => {
    expect(() => assertFinishManifest(CALL, manifest())).not.toThrow();
  });

  it('refuses a manifest whose prefix is not the one that was submitted', () => {
    expect(() => assertFinishManifest(CALL, manifest({ prefix: PREFIX.replace('/A', '/B') })))
      .toThrow('finish manifest is invalid');
  });

  it('refuses a manifest that renamed a rendition back to "master"', () => {
    const base = manifest();
    const renamed = manifest({ archive: { ...(base.archive as Record<string, unknown>), r2_key: `${PREFIX}/master.flac` } });
    expect(() => assertFinishManifest(CALL, renamed)).toThrow('finish manifest is invalid');
  });

  // THE ARCHIVE IS NEVER MASTERED. finish.py records archive.loudness_target_lufs = None and
  // mutants F1/F2/F10 exist to catch anyone putting a target back on it. This is the
  // orchestrator-side half of that: a manifest claiming a targeted archive is refused.
  it('refuses an archive that carries a loudness target at all', () => {
    expect(() => assertFinishManifest(CALL, withRendition('archive', { loudness_target_lufs: -14 })))
      .toThrow('archive must never carry a loudness target');
  });

  it('refuses a raw that carries a loudness target at all', () => {
    expect(() => assertFinishManifest(CALL, withRendition('raw', { loudness_target_lufs: -14 })))
      .toThrow('raw must never carry a loudness target');
  });

  it('accepts a quiet, wide-range archive, which is a legitimate archive', () => {
    expect(() => assertFinishManifest(CALL, withRendition('archive', { integrated_lufs: -31.7, true_peak_dbtp: -18.2, loudness_range: 22 })))
      .not.toThrow();
  });

  it('accepts a review true peak of -2.0 dBTP, which the plan\'s superseded range would have rejected', () => {
    expect(() => assertFinishManifest(CALL, withRendition('review', { true_peak_dbtp: -2 }))).not.toThrow();
  });

  it('refuses a review true peak of -0.7 dBTP, which the plan\'s superseded range would have accepted', () => {
    expect(() => assertFinishManifest(CALL, withRendition('review', { true_peak_dbtp: -0.7 })))
      .toThrow('review true peak exceeds the ceiling');
  });

  it('refuses a review that missed its loudness target by more than the tolerance', () => {
    expect(() => assertFinishManifest(CALL, withRendition('review', { integrated_lufs: -13.4 })))
      .toThrow('review is off its loudness target');
  });

  it('accepts a review exactly at the tolerance edge', () => {
    expect(() => assertFinishManifest(CALL, withRendition('review', { integrated_lufs: -14.5 }))).not.toThrow();
  });

  it('refuses a review whose declared target is not the shipped one', () => {
    expect(() => assertFinishManifest(CALL, withRendition('review', { loudness_target_lufs: -16 })))
      .toThrow('finish manifest is invalid');
  });

  it('refuses a rendition whose duration drifted from the raw', () => {
    expect(() => assertFinishManifest(CALL, withRendition('review', { duration_seconds: 27 })))
      .toThrow('rendition duration drifted from the raw');
  });

  it('refuses a raw whose size is not the object the Workflow stored', () => {
    expect(() => assertFinishManifest(CALL, withRendition('raw', { bytes: 12 })))
      .toThrow('finished raw is not the object that was submitted');
  });

  it('refuses a raw whose duration is not the one the Workflow recorded', () => {
    expect(() => assertFinishManifest(CALL, withRendition('raw', { duration_seconds: 12 })))
      .toThrow('finished raw is not the object that was submitted');
  });

  for (const name of ['raw', 'archive', 'review'] as const) {
    it(`refuses a ${name} with a non-positive byte count`, () => {
      expect(() => assertFinishManifest(CALL, withRendition(name, { bytes: 0 }))).toThrow('finish manifest is invalid');
    });
  }

  it('refuses a manifest with no ffmpeg version', () => {
    expect(() => assertFinishManifest(CALL, manifest({ ffmpeg_version: '' }))).toThrow('finish manifest is invalid');
  });

  it('refuses a manifest whose command digest is not a sha256', () => {
    expect(() => assertFinishManifest(CALL, manifest({ command_digest: 'nope' }))).toThrow('finish manifest is invalid');
  });

  it('refuses a manifest of a schema version this build does not know', () => {
    expect(() => assertFinishManifest(CALL, manifest({ schema_version: 2 }))).toThrow('finish manifest is invalid');
  });

  it('refuses a rendition with the wrong content type', () => {
    expect(() => assertFinishManifest(CALL, withRendition('review', { content_type: 'audio/wav' })))
      .toThrow('finish manifest is invalid');
  });
});
