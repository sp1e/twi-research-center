import { describe, expect, it } from 'vitest';

import { createSineWav } from './audio/wav';
import {
  assertAllProvisional,
  assertBothCandidatesValidated,
  assertCandidateAudio,
  assertFrozenJobMatchesPayload,
  assertProvenance,
  assertWavHeader,
} from './publication-guards';

const WAV = createSineWav({ seconds: 1, frequencyHz: 220, sampleRate: 8_000 });
const OTHER = createSineWav({ seconds: 1, frequencyHz: 440, sampleRate: 8_000 });

const triple = (over: Partial<Record<'raw' | 'master' | 'preview', { bytes: Uint8Array; sha256: string }>> = {}) => ({
  raw: { bytes: WAV, sha256: 'hash-1' },
  master: { bytes: WAV, sha256: 'hash-1' },
  preview: { bytes: WAV, sha256: 'hash-1' },
  ...over,
});

describe('assertWavHeader', () => {
  it('accepts a well-formed RIFF/WAVE payload', () => {
    expect(() => assertWavHeader(WAV)).not.toThrow();
  });

  it('rejects a payload too short to hold a header', () => {
    expect(() => assertWavHeader(WAV.slice(0, 43))).toThrow('too short');
  });

  it('rejects a payload whose RIFF marker was overwritten', () => {
    const broken = WAV.slice();
    broken[0] = 0x52 + 1;
    expect(() => assertWavHeader(broken)).toThrow('header is invalid');
  });

  it('rejects a payload whose declared length disagrees with its size', () => {
    const broken = WAV.slice();
    new DataView(broken.buffer).setUint32(4, 12, true);
    expect(() => assertWavHeader(broken)).toThrow('length is invalid');
  });
});

describe('assertCandidateAudio', () => {
  it('accepts three identical, well-formed candidates', () => {
    expect(() => assertCandidateAudio(triple())).not.toThrow();
  });

  it('rejects a master whose digest differs from the raw it came from', () => {
    expect(() => assertCandidateAudio(triple({ master: { bytes: WAV, sha256: 'hash-2' } }))).toThrow('differ');
  });

  it('rejects a preview whose digest differs from the raw it came from', () => {
    expect(() => assertCandidateAudio(triple({ preview: { bytes: WAV, sha256: 'hash-2' } }))).toThrow('differ');
  });

  it('rejects a master that is not playable audio at all', () => {
    expect(() => assertCandidateAudio(triple({ master: { bytes: new Uint8Array(8), sha256: 'hash-1' } }))).toThrow();
  });

  it('rejects a preview that is not playable audio at all', () => {
    expect(() => assertCandidateAudio(triple({ preview: { bytes: new Uint8Array(8), sha256: 'hash-1' } }))).toThrow();
  });

  it('rejects a raw that is not playable audio at all', () => {
    expect(() => assertCandidateAudio(triple({ raw: { bytes: OTHER.slice(0, 20), sha256: 'hash-1' } }))).toThrow();
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
