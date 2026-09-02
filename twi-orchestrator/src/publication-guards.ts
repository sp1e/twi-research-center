/*
 * The invariants that stand between a finished render and a published one.
 *
 * They live here, pure and separately testable, because a guard that only ever runs on the
 * happy path is indistinguishable from no guard at all: a mutation campaign against the
 * Workflow proved that deleting ANY of these checks left the integration suite green.
 * Buried inside a 200-line step there was no way to forge a violation; as functions there is.
 */

import { readWavProperties, type WavProperties } from './audio/wav';

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

/*
 * The raw candidate must be a playable RIFF/WAVE, read by WALKING the chunk list.
 *
 * This replaces the old `assertWavHeader`, which assumed the canonical 44-byte layout and read
 * `data` at a fixed offset 36. That was not a live defect while it only ever saw this build's
 * own fake renderer -- but Task 11 feeds it real provider audio, and real encoders are entitled
 * to emit `LIST` or `fact` chunks before `data`. A fixed offset would reject a perfectly legal
 * file from Lyria.
 *
 * EVERY RULE OF THE OLD CHECK IS KEPT except that one, because a replacement that quietly
 * drops an invariant is how this project lost a `preGateReturns.length === 1` rule once
 * already. Extracted from the old body, one by one:
 *   - at least 44 bytes                             -> kept, below
 *   - 'RIFF' at 0 and 'WAVE' at 8                   -> kept, inside readWavProperties
 *   - 'data' present                                -> kept, inside readWavProperties, by SEARCH
 *   - declared RIFF size equals payload length - 8  -> kept, below (readWavProperties does NOT
 *                                                      look at that field at all)
 *   - declared data size equals payload length - 44 -> REPLACED by the chunk walk's own bound
 *                                                      check, which is the general form of it
 */
export const assertRawWavIntegrity = (bytes: Uint8Array): WavProperties => {
  if (bytes.byteLength < 44) throw new Error('candidate WAV is too short');
  const properties = readWavProperties(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) throw new Error('candidate WAV length is invalid');
  if (properties.dataBytes <= 0 || properties.durationSeconds <= 0) {
    throw new Error('candidate WAV carries no audio');
  }
  return properties;
};

export interface StoredObjectClaim {
  /** What the finishing manifest said about this object. */
  key: string;
  contentType: string;
  sizeBytes: number;
  /** What R2 actually holds, or nulls when the object is not there at all. */
  storedContentType: string | null | undefined;
  storedSizeBytes: number | null;
}

/*
 * A finishing manifest is a REPORT about objects a different machine wrote. Modal uploads
 * `archive.flac` and `review.mp3` to R2 directly, so between the probe it reports and the
 * object we are about to publish there is a whole network. This is the cross-check: the object
 * has to exist, be stored under the content type the manifest claims, and be exactly the
 * number of bytes the manifest measured.
 *
 * It fails closed on ABSENCE specifically, because "no object" is the failure a `head` check
 * exists to catch and the one an optimistic implementation turns into a published render with
 * nothing behind it.
 */
export const assertStoredObject = (claim: StoredObjectClaim): void => {
  if (claim.storedSizeBytes === null || claim.storedContentType === null || claim.storedContentType === undefined) {
    throw new Error(`finished object is missing from storage: ${claim.key}`);
  }
  if (claim.storedContentType !== claim.contentType) {
    throw new Error(`finished object has the wrong content type: ${claim.key}`);
  }
  if (claim.storedSizeBytes !== claim.sizeBytes) {
    throw new Error(`finished object size disagrees with the manifest: ${claim.key}`);
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
