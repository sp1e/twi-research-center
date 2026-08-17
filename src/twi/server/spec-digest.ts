import { parseInputObjectJson } from './canonical-json';
import type { JsonValue } from './repository-types';

/**
 * The spec fingerprint.
 *
 * `twi_generation_specs` stores a document and a digest side by side, and the paid
 * submit path replays on that digest: `findJobByIdempotencyKey` treats a mismatch
 * as "a different request under a used key" and refuses to serve the replay. So a
 * digest that describes anything other than the bytes in `spec_json` does not
 * merely mislabel a column — it can tell a correct caller that its own paid
 * submission is somebody else's.
 *
 * Keeping the two in step is therefore not left to a convention. The digest is
 * derived here, from the exact text that is persisted, and the pair travels as one
 * value ({@link CanonicalSpecDocument}) that only this module can mint. There is no
 * caller-supplied digest to disagree with, and no second serialiser that could
 * drift from the one whose output is stored.
 */

declare const fingerprinted: unique symbol;

interface SpecDocumentFields {
  /** The canonical document, parsed. Returned to callers as `GenerationSpecRecord.spec`. */
  readonly object: Record<string, JsonValue>;
  /** The exact text written to `twi_generation_specs.spec_json`. */
  readonly canonical: string;
  /** `sha256(canonical)`, hex. The exact text written to `spec_sha256`. */
  readonly sha256: string;
}

/**
 * A spec document together with the digest of *that* document.
 *
 * Branded, so the compiler accepts nothing but the output of
 * {@link canonicalSpecDocument}: a hand-built object literal pairing one document
 * with another document's digest cannot reach the insert.
 */
export type CanonicalSpecDocument = SpecDocumentFields & { readonly [fingerprinted]: true };

const encoder = new TextEncoder();

/** Web Crypto is present in Workers, browsers and Node 18+. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonicalises caller JSON and hashes the result, in that order. Rejects the same
 * inputs `parseInputObjectJson` rejects (non-object, invalid JSON, non-finite
 * numbers) with a `TwiRepositoryValidationError` naming `field`.
 */
export async function canonicalSpecDocument(field: string, specJson: unknown): Promise<CanonicalSpecDocument> {
  const { object, canonical } = parseInputObjectJson(field, specJson);
  return { object, canonical, sha256: await sha256Hex(canonical) } as CanonicalSpecDocument;
}

/**
 * The fingerprint of a spec document — the one sanctioned way to obtain it.
 *
 * `saveSpec` returns the stored digest, but the submit path needs it *before* the
 * spec is saved, to look for a job to replay. Both sides must mean the same thing,
 * so both come from here. Because the document is canonicalised first, a
 * cosmetically different retry of the same submission (reordered keys, reflowed
 * whitespace) yields the same fingerprint and replays instead of charging twice.
 */
export async function specSha256(specJson: string): Promise<string> {
  return (await canonicalSpecDocument('spec.specJson', specJson)).sha256;
}
