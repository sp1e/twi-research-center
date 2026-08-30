/*
 * The invariants that stand between a finished render and a published one.
 *
 * They live here, pure and separately testable, because a guard that only ever runs on the
 * happy path is indistinguishable from no guard at all: a mutation campaign against the
 * Workflow proved that deleting ANY of these checks left the integration suite green.
 * Buried inside a 200-line step there was no way to forge a violation; as functions there is.
 */

export interface AudioPart {
  bytes: Uint8Array;
  sha256: string;
}

export interface FrozenJobIdentity {
  projectId: string;
  specId: string;
  specSha256: string;
  idempotencyKey: string;
}

export interface ProvenanceClaim {
  contentType: string | undefined;
  /** The stored document, or null when the object was never written. */
  text: string | null;
  label: string;
  providerRequestId: string;
  specSha256: string;
}

/** Canonical 44-byte RIFF/WAVE layout, as written by this build's own fake renderer. */
export const assertWavHeader = (bytes: Uint8Array): void => {
  if (bytes.byteLength < 44) throw new Error('candidate WAV is too short');
  const text = (from: number, to: number) => new TextDecoder().decode(bytes.slice(from, to));
  if (text(0, 4) !== 'RIFF' || text(8, 12) !== 'WAVE' || text(36, 40) !== 'data') {
    throw new Error('candidate WAV header is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(40, true) !== bytes.byteLength - 44) {
    throw new Error('candidate WAV length is invalid');
  }
};

/*
 * Every rendition must be playable AND must be the same audio: on the fake path master and
 * preview are copies of raw, so a digest that drifts means an object was swapped or rewritten
 * between the step that made it and the step about to publish it.
 */
export const assertCandidateAudio = ({ raw, master, preview }: Record<'raw' | 'master' | 'preview', AudioPart>): void => {
  assertWavHeader(raw.bytes);
  assertWavHeader(master.bytes);
  assertWavHeader(preview.bytes);
  if (raw.sha256 !== master.sha256 || raw.sha256 !== preview.sha256) {
    throw new Error('fake candidate audio outputs differ');
  }
};

export const assertProvenance = ({ contentType, text, label, providerRequestId, specSha256 }: ProvenanceClaim): void => {
  if (text === null || contentType !== 'application/json') throw new Error('candidate provenance is missing');
  const provenance = JSON.parse(text) as Record<string, unknown>;
  if (
    provenance.providerRequestId !== providerRequestId ||
    provenance.specSha256 !== specSha256 ||
    provenance.label !== label
  ) {
    throw new Error('candidate provenance is invalid');
  }
};

/** Publication is all-or-nothing: exactly A then B, never a partial or reordered pair. */
export const assertBothCandidatesValidated = (labels: readonly string[]): void => {
  if (labels.join('') !== 'AB') throw new Error('both candidates must validate before publication');
};

export const assertAllProvisional = (count: number | undefined, expected: number): void => {
  if (count !== expected) throw new Error('candidate assets are not all provisional');
};

export const assertFrozenJobMatchesPayload = (job: FrozenJobIdentity, payload: FrozenJobIdentity): void => {
  if (
    job.projectId !== payload.projectId ||
    job.specId !== payload.specId ||
    job.specSha256 !== payload.specSha256 ||
    job.idempotencyKey !== payload.idempotencyKey
  ) {
    throw new Error('workflow identity does not match the frozen job');
  }
};
