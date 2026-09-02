import { describe, expect, it } from 'vitest';

import { createSineWav } from './audio/wav';
import {
  assertAllProvisional,
  assertBothCandidatesValidated,
  assertFrozenJobMatchesPayload,
  assertProvenance,
  assertRawWavIntegrity,
  assertStoredObject,
} from './publication-guards';

const WAV = createSineWav({ seconds: 1, frequencyHz: 220, sampleRate: 8_000 });
const OTHER = createSineWav({ seconds: 1, frequencyHz: 440, sampleRate: 8_000 });

/** A legal WAV whose `data` chunk is NOT at offset 36, which the old fixed-offset check rejected. */
const withLeadingListChunk = (source: Uint8Array): Uint8Array => {
  const listBody = new TextEncoder().encode('INFOISFT');
  const inserted = 8 + listBody.byteLength;
  const bytes = new Uint8Array(source.byteLength + inserted);
  bytes.set(source.slice(0, 36), 0);
  bytes.set(new TextEncoder().encode('LIST'), 36);
  const view = new DataView(bytes.buffer);
  view.setUint32(40, listBody.byteLength, true);
  bytes.set(listBody, 44);
  bytes.set(source.slice(36), 44 + listBody.byteLength);
  view.setUint32(4, bytes.byteLength - 8, true);
  return bytes;
};

describe('assertRawWavIntegrity', () => {
  it('accepts a well-formed RIFF/WAVE payload', () => {
    expect(() => assertRawWavIntegrity(WAV)).not.toThrow();
  });

  it('reads the audio properties rather than assuming them', () => {
    expect(assertRawWavIntegrity(WAV)).toMatchObject({ sampleRate: 8_000, channels: 1, durationSeconds: 1 });
  });

  it('accepts a legal file whose data chunk is NOT at offset 36 — the whole reason for the change', () => {
    const padded = withLeadingListChunk(WAV);
    expect(() => assertRawWavIntegrity(padded)).not.toThrow();
    expect(assertRawWavIntegrity(padded).durationSeconds).toBe(1);
  });

  it('rejects a payload too short to hold a header', () => {
    expect(() => assertRawWavIntegrity(WAV.slice(0, 43))).toThrow('too short');
  });

  it('rejects a payload whose RIFF marker was overwritten', () => {
    const broken = WAV.slice();
    broken[0] = 0x52 + 1;
    expect(() => assertRawWavIntegrity(broken)).toThrow('not a RIFF/WAVE container');
  });

  it('rejects a payload whose declared RIFF length disagrees with its size', () => {
    const broken = WAV.slice();
    new DataView(broken.buffer).setUint32(4, 12, true);
    expect(() => assertRawWavIntegrity(broken)).toThrow('length is invalid');
  });

  it('rejects a payload with a header but no audio in it', () => {
    const empty = createSineWav({ seconds: 1, frequencyHz: 220, sampleRate: 8_000 }).slice(0, 44);
    new DataView(empty.buffer, empty.byteOffset, empty.byteLength).setUint32(4, empty.byteLength - 8, true);
    new DataView(empty.buffer, empty.byteOffset, empty.byteLength).setUint32(40, 0, true);
    expect(() => assertRawWavIntegrity(empty)).toThrow('carries no audio');
  });

  it('rejects a payload that is not audio at all', () => {
    expect(() => assertRawWavIntegrity(OTHER.slice(0, 60))).toThrow();
  });
});

describe('assertStoredObject', () => {
  const claim = (over: Partial<Parameters<typeof assertStoredObject>[0]> = {}) => ({
    key: 'twi/p/jobs/j/attempt-0/A/archive.flac',
    contentType: 'audio/flac',
    sizeBytes: 1_024,
    storedContentType: 'audio/flac',
    storedSizeBytes: 1_024,
    ...over,
  });

  it('accepts an object that is exactly what the manifest reported', () => {
    expect(() => assertStoredObject(claim())).not.toThrow();
  });

  it('refuses an object that was never written, naming the key', () => {
    expect(() => assertStoredObject(claim({ storedSizeBytes: null, storedContentType: null })))
      .toThrow('finished object is missing from storage: twi/p/jobs/j/attempt-0/A/archive.flac');
  });

  it('refuses an object stored without a content type at all', () => {
    expect(() => assertStoredObject(claim({ storedContentType: undefined }))).toThrow('missing from storage');
  });

  it('refuses an object stored under a different content type', () => {
    expect(() => assertStoredObject(claim({ storedContentType: 'audio/wav' }))).toThrow('wrong content type');
  });

  it('refuses an object whose size disagrees with what the manifest measured', () => {
    expect(() => assertStoredObject(claim({ storedSizeBytes: 1_023 }))).toThrow('size disagrees with the manifest');
  });
});

const provenance = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, label: 'A', providerRequestId: 'req-1', specSha256: 'spec-1', ...over });

const provenanceInput = (over: Partial<{ contentType: string | undefined; text: string | null }> = {}) => ({
  contentType: 'application/json',
  text: provenance(),
  label: 'A',
  providerRequestId: 'req-1',
  specSha256: 'spec-1',
  ...over,
});

describe('assertProvenance', () => {
  it('accepts a document that names the same candidate, request and spec', () => {
    expect(() => assertProvenance(provenanceInput())).not.toThrow();
  });

  it('rejects a provenance object that was never stored', () => {
    expect(() => assertProvenance(provenanceInput({ text: null }))).toThrow('missing');
  });

  it('rejects a provenance object stored under the wrong content type', () => {
    expect(() => assertProvenance(provenanceInput({ contentType: 'audio/wav' }))).toThrow('missing');
  });

  it('rejects provenance that points at a different specification', () => {
    expect(() => assertProvenance({ ...provenanceInput(), text: provenance({ specSha256: 'spec-2' }) })).toThrow('invalid');
  });

  it('rejects provenance that claims the other candidate', () => {
    expect(() => assertProvenance({ ...provenanceInput(), text: provenance({ label: 'B' }) })).toThrow('invalid');
  });

  it('rejects provenance that names a different provider request', () => {
    expect(() => assertProvenance({ ...provenanceInput(), text: provenance({ providerRequestId: 'req-2' }) })).toThrow('invalid');
  });
});

describe('assertBothCandidatesValidated', () => {
  it('accepts exactly A then B', () => {
    expect(() => assertBothCandidatesValidated(['A', 'B'])).not.toThrow();
  });

  it.each([[['A', 'A']], [['B', 'A']], [['A']], [[]], [['A', 'B', 'A']]])('refuses to publish %j', (labels) => {
    expect(() => assertBothCandidatesValidated(labels)).toThrow('both candidates');
  });
});

describe('assertAllProvisional', () => {
  it('accepts a count that covers every asset', () => {
    expect(() => assertAllProvisional(8, 8)).not.toThrow();
  });

  it('refuses when even one asset is not provisional', () => {
    expect(() => assertAllProvisional(7, 8)).toThrow('not all provisional');
  });

  it('refuses when the count could not be read at all', () => {
    expect(() => assertAllProvisional(undefined, 8)).toThrow('not all provisional');
  });
});

const identity = { projectId: 'p', specId: 's', specSha256: 'd', idempotencyKey: 'k' };

describe('assertFrozenJobMatchesPayload', () => {
  it('accepts a job whose identity matches the payload exactly', () => {
    expect(() => assertFrozenJobMatchesPayload(identity, { ...identity })).not.toThrow();
  });

  it.each(['projectId', 'specId', 'specSha256', 'idempotencyKey'] as const)(
    'refuses a payload whose %s does not match the frozen job',
    (field) => {
      expect(() => assertFrozenJobMatchesPayload(identity, { ...identity, [field]: 'other' })).toThrow(
        'does not match the frozen job',
      );
    },
  );
});
