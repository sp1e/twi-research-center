import { HttpError, json } from './http';
import { creationCoreCapabilities } from './capabilities';
import { TwiRepositoryCollisionError } from './errors';
import { systemIdentityClock, type ProjectIdentityClock } from './projects';
import type { R2BucketLike } from './r2-types';
import type { TwiRepository } from './repository';
import type { AssetRecord, RegisterAssetOutcome } from './repository-types';

/**
 * Image-reference ingestion for `/api/twi/*`.
 *
 * Phase 1 accepts up to ten image references per specification because Lyria 3 Pro
 * supports them. This module is the whole ingestion path: decide the upload's
 * identity, validate the BYTES, write the object, record the row, and undo the
 * object if the row cannot be written.
 *
 * Four properties are load-bearing, and three of them are ORDERS rather than values
 * — which is why `assets.test.ts` and `asset-ingestion.test.ts` witness the order
 * with a recording double and a real request stream instead of asserting a comment:
 *
 *   1. NOTHING EXPENSIVE HAPPENS BEFORE ITS BOUND. A cap applied after the upload
 *      has been materialised is not a guard, it is an amplifier: the isolate has
 *      already paid for the memory it is about to refuse. THREE bounds, and each one
 *      states honestly what it does and does not cost:
 *        · the declared `Content-Length` is refused before `request.formData()`
 *          parses anything and before a byte leaves the socket — free;
 *        · the body stream is then read under a HARD bound of
 *          {@link MAX_MULTIPART_BODY_BYTES} and the parser is handed those bytes
 *          rather than the socket, so a body that declares no length, declares a
 *          non-numeric one or understates it costs that bound PLUS AT MOST THE LARGEST
 *          CHUNK the producer hands over — the bound is checked once per chunk, and a
 *          chunk is already in the isolate by the time its length can be added up.
 *          Measured over an HTTP request that is 114,688 bytes (the chunk that crossed
 *          the bound plus one chunk of read-ahead); measured over a hand-built stream
 *          that hands over one 48 MiB chunk it is 50,331,648, because that is what
 *          `read()` resolved with. Not reachable over HTTP, where the socket bounds the
 *          chunk and Cloudflare's request limit is the outer ceiling, and not fixable
 *          here — the allocation precedes `read()` returning. This bound exists at all
 *          because measurement showed the earlier claim was false: `formData()` buffers
 *          an undeclared body IN FULL first, and the only ceiling on it was
 *          Cloudflare's own request limit;
 *        · `validateImageReference` measures `file.size` before reading a byte of
 *          content and then reads only the 16-byte probe window.
 *      The third is the verdict on the image; the first two bound what the isolate
 *      pays to reach it.
 *   2. NEITHER THE FILENAME NOR THE DECLARED CONTENT TYPE IS EVIDENCE. Both are
 *      caller-supplied strings. The extension and the stored content type are
 *      derived from the magic bytes, so `evil.php` renamed `mood.jpg` is refused and
 *      PNG bytes announced as `image/jpeg` are stored — correctly — as PNG. The
 *      request's own `Content-Type` is consulted for one thing only: to select the
 *      multipart parser, compared in lower case while the RAW header is what is
 *      handed back to the parser, because a multipart boundary is case-SENSITIVE.
 *   3. R2 IS WRITTEN BEFORE D1, AND ROLLED BACK IF D1 REFUSES. There is no
 *      transaction spanning the two. The order is chosen so the failure mode is a
 *      brief orphan object rather than a row pointing at nothing: a row whose object
 *      is absent is a broken reference the wizard cannot render, while an object
 *      whose row is absent is invisible and is deleted here anyway.
 *      TWO THINGS MAKE THAT TRUE UNDER CONCURRENCY, and both exist because property 4
 *      made the object key SHARED: the put is conditional on nothing being stored
 *      there yet, and the rollback deletes only an object NO COMMITTED ROW NAMES. The
 *      lesson is worth keeping: while the key carried a fresh UUID, "clean up my own
 *      orphan" and "delete whatever is at this key" were the same sentence, and the
 *      compensating delete was correct. Deriving the key changed what the sentence
 *      described while leaving the argument for it word for word intact.
 *   4. THE UPLOAD'S IDENTITY COMES FROM THE CLIENT, NOT FROM A FRESH UUID. A 10 MiB
 *      upload is the request most likely to be retried after a timeout, and an
 *      identity minted per call makes every retry a second object and a second row
 *      for bytes that are already stored — which is what this endpoint used to do.
 *      `Idempotency-Key` is required, exactly as it is on every other mutation this
 *      site serves, and the asset id is DERIVED from it (see
 *      {@link deriveImageAssetId}). Deriving the identity from the CONTENT instead
 *      would mean buffering the whole upload before the deduplication decision could
 *      be taken — the cost property 1 exists to refuse. THE CLIENT OWNS ONE HALF OF
 *      THIS CONTRACT: reusing a key for DIFFERENT bytes is answered as a replay of the
 *      first upload — 200, the first asset's record, the second payload never stored —
 *      because comparing payloads would cost exactly that buffering. The answer carries
 *      `sha256`, `bytes` and `contentType`, so detecting such a mismatch is one
 *      comparison, and it is the CLIENT's to make: a client that does not compare is
 *      told 200 and will believe bytes were stored that were not.
 *
 * The public shape is `AssetRecord`. The binding never leaves this module — it
 * arrives as a parameter, is used, and is not put in any response.
 */

/** Largest image reference accepted, before any of it is read. */
export const MAX_IMAGE_REFERENCE_BYTES = 10 * 1024 * 1024;

/**
 * Multipart envelope slack over the payload cap: boundary lines, the part's own
 * headers and the trailing delimiter. Same shape of allowance as `RAW_LENGTH_SLACK`
 * in src/twi/domain/schemas.ts — it exists so a legitimate 10 MiB image is not
 * refused for the bytes its envelope adds, and it is deliberately far too small to
 * let a second image through.
 */
export const MULTIPART_ENVELOPE_SLACK_BYTES = 16 * 1024;

/** The declared-body bound checked before the multipart form is parsed at all. */
export const MAX_MULTIPART_BODY_BYTES = MAX_IMAGE_REFERENCE_BYTES + MULTIPART_ENVELOPE_SLACK_BYTES;

/**
 * How much of the upload the format check may read.
 *
 * Sixteen bytes covers every signature below with room to spare — the longest is
 * WebP's, which needs twelve — and the number is what makes property 1 above a
 * bounded read rather than a promise.
 */
export const MAGIC_BYTE_PROBE_BYTES = 16;

/**
 * Ten references per specification, taken from the capability catalog rather than
 * written again here.
 *
 * The number appears in three places — this guard, `creationCoreCapabilities`, and
 * the `boundedArray(uuid, 10)` bound on `sound.imageAssetIds` in
 * src/twi/domain/schemas.ts. Two of the three are now the same value by
 * construction; the third is asserted equal by test, because a wizard that collects
 * eleven references the schema then rejects wastes the owner's work at the last
 * step before a paid render.
 */
export const MAX_IMAGE_REFERENCES_PER_SPEC = creationCoreCapabilities.maxImageReferences;

/** Every TWI object lives under this prefix, so the bucket stays shared safely. */
export const R2_TWI_PREFIX = 'twi/';

/** The one multipart field this endpoint accepts. */
export const UPLOAD_FILE_FIELD = 'file';

const MULTIPART_CONTENT_TYPE = 'multipart/form-data';

/**
 * The header that decides an upload's identity.
 *
 * Not a new convention: every mutating endpoint on this site already reads it
 * (`functions/api/[[route]].ts` refuses a purchase or a casino action without one),
 * `mosquito.html`'s `api()` wrapper mints one for every non-GET request, and
 * `twi_jobs.idempotency_key` carries the same idea into this schema.
 */
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * Longest `Idempotency-Key` accepted, the same bound the casino routes apply.
 *
 * A bound at all, rather than none, because the value is hashed below: an unbounded
 * header would be an unbounded read before any other guard has run.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Domain separator for the identity digest.
 *
 * Prefixed so the same key can never derive the same value in a different context —
 * a bare `sha256(projectId + key)` would collide with any other feature that hashes
 * the same two strings.
 *
 * `v2` because the PREIMAGE changed shape, not just its content: v1 delimited the two
 * variable-length fields with a newline, which is ambiguous (see
 * {@link deriveImageAssetId}), and a domain constant that survived the change would
 * have described two different constructions.
 */
const ASSET_IDENTITY_DOMAIN = 'twi/image-reference/identity/v2';

export type ImageExtension = 'jpg' | 'png' | 'webp';

/**
 * The slice of `File` this module uses.
 *
 * Declared structurally for the same reason `D1DatabaseLike` is: a real `File` is
 * assignable to it, and a test can supply one that refuses to hand over a byte —
 * which is the only way to prove the size cap runs before the read rather than
 * beside it.
 */
export interface UploadedFileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImageReferenceDescriptor {
  extension: ImageExtension;
  /** Derived from the bytes. Never `file.type`. */
  contentType: string;
  bytes: number;
}

export interface ImageAssetDeps {
  bucket: R2BucketLike;
  repo: TwiRepository;
  clock?: ProjectIdentityClock;
}

export interface CreateImageAssetInput {
  projectId: string;
  file: UploadedFileLike;
  /**
   * The asset's identity, decided by the caller.
   *
   * Passed in rather than minted here, and required rather than optional: a fresh id
   * per call is precisely what made a retry write a second object and a second row,
   * and an optional parameter would have left that behaviour one forgotten argument
   * away. `uploadImageReference` derives it from the client's idempotency key.
   */
  assetId: string;
}

export interface CreateImageAssetResult {
  asset: AssetRecord;
  outcome: RegisterAssetOutcome;
}

interface SignaturePart {
  readonly at: number;
  readonly bytes: readonly number[];
}

interface ImageSignature {
  readonly extension: ImageExtension;
  readonly contentType: string;
  readonly parts: readonly SignaturePart[];
}

/**
 * The accepted formats, as byte patterns.
 *
 * WebP needs two parts: a RIFF container header and the `WEBP` form type eight
 * bytes in. Checking only `RIFF` would accept WAV and AVI, which is why the
 * truncated-header case has a test of its own. The RIFF length field between them is
 * deliberately NOT read — a caller-supplied length is not evidence of anything.
 */
const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  { extension: 'png', contentType: 'image/png', parts: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  { extension: 'jpg', contentType: 'image/jpeg', parts: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }] },
  {
    extension: 'webp',
    contentType: 'image/webp',
    parts: [
      { at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
];

const matchesSignature = (head: Uint8Array, signature: ImageSignature): boolean =>
  signature.parts.every(
    (part) =>
      head.length >= part.at + part.bytes.length &&
      part.bytes.every((byte, index) => head[part.at + index] === byte),
  );

/**
 * Object-key segments are restricted rather than escaped.
 *
 * `projectId` and the minted `assetId` are both UUIDs in practice, so nothing
 * legitimate is refused — and a value containing `/` or `..` would silently move the
 * object out of its project's prefix, where the next task's per-project listing would
 * not find it and another project's would.
 */
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Reads the request's idempotency key, or refuses the request.
 *
 * Required, not optional. An optional key leaves the duplicate write exactly where it
 * was for the client that forgets to send one — which is the client that needs it —
 * and every other mutation on this site already refuses without it.
 */
const readIdempotencyKey = (request: Request): string => {
  const key = (request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? '').trim();
  if (key.length === 0) {
    throw new HttpError(400, `${IDEMPOTENCY_KEY_HEADER} header is required`, 'idempotency_key_required');
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new HttpError(
      400,
      `${IDEMPOTENCY_KEY_HEADER} must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      'idempotency_key_too_long',
    );
  }
  return key;
};

/** Version and variant nibbles, so the value cannot pass itself off as random. */
const uuidNibble = (byte: number, index: number): number => {
  // Version 8 is RFC 9562's "custom" version: derived by this application, not drawn
  // from an entropy source. Claiming version 4 would be a lie about where it came from.
  if (index === 6) return (byte & 0x0f) | 0x80;
  if (index === 8) return (byte & 0x3f) | 0x80;
  return byte;
};

/**
 * The asset id an `Idempotency-Key` names — derived, never accepted.
 *
 * Derived rather than used directly for three reasons. The client cannot choose a
 * row's primary key or a path inside the shared bucket; the key may be any string the
 * bound above allows, without a UUID format rule bolted onto the header; and the value
 * is scoped to the project, so the same key in two projects is two different assets
 * instead of a cross-project collision.
 *
 * It is a digest of a short string, so it costs nothing and — unlike a digest of the
 * upload itself — it is available BEFORE the body is read. That is the whole point:
 * the deduplication decision is taken while the request is still cheap.
 *
 * THE PREIMAGE IS LENGTH-PREFIXED, NOT MERELY DELIMITED, and that is a correctness
 * property rather than a style. Concatenating two variable-length fields around a
 * separator is ambiguous the moment either field can contain the separator: measured,
 * the earlier `DOMAIN\n{projectId}\n{key}` gave
 * `derive(id + '\nEXTRA', 'key') === derive(id, 'EXTRA\nkey')` —
 * both `d06e617a-b115-86df-a075-fd8b340ab9b8`. Nothing in this function required an
 * LF-free `projectId`. The three things that in fact supplied one all live OUTSIDE it:
 * the HTTP runtime refuses LF in a header value, `getProject` matches byte-exactly
 * against server-minted UUIDs, and {@link imageReferenceR2Key}'s segment rule — which
 * the replay path returns BEFORE reaching. A second caller inherits none of the three,
 * so the invariant belongs to the primitive that needs it. `{length}:{value}` makes the
 * decomposition unique for every pair of well-formed inputs, so distinct
 * `(projectId, key)` pairs cannot share a digest. ("Well-formed" is the one honest
 * qualifier: `TextEncoder` maps an unpaired surrogate to U+FFFD, so two strings that
 * differ only in unpaired surrogates encode identically — unreachable through a header
 * or a UUID, and stated rather than glossed.)
 */
export async function deriveImageAssetId(projectId: string, idempotencyKey: string): Promise<string> {
  const field = (value: string): string => `${value.length}:${value}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ASSET_IDENTITY_DOMAIN}\n${field(projectId)}\n${field(idempotencyKey)}`),
  );
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map(uuidNibble)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Reads the request body under a hard byte bound, or reports that there is no stream.
 *
 * `null` means the request exposes no body to read — a test double, or a runtime that
 * hands the parser the socket directly; the caller then falls back to
 * `request.formData()`, which is what happened for every body before this existed.
 *
 * The bound is enforced as the bytes arrive and the stream is CANCELLED at the first
 * chunk that crosses it, so an oversize body costs `limit` plus at most ONE CHUNK
 * rather than its own size. Per chunk is the honest unit: `value` is already in the
 * isolate when its length is added to `seen`, so the guaranteed ceiling is
 * `limit + max(chunk)` and the chunk size is the producer's choice. Measured over HTTP
 * that is 10,616,832 pulled against a 10,502,144 bound — 114,688 over, being the
 * crossing chunk plus one chunk of undici read-ahead; measured against a stream built
 * to hand over a single 48 MiB chunk it is 50,331,648. The second shape is not
 * reachable over HTTP and not fixable in code, which is why it is stated rather than
 * claimed away. Either way this is the honest version of a claim this module used to
 * make: `formData()` on a body with no `Content-Length` buffers all of it before anyone
 * can measure it, which was measured at 10,485,885 bytes pulled for a body the endpoint
 * then refused.
 */
const readBoundedBody = async (request: Request, limit: number): Promise<ArrayBuffer | null> => {
  const stream = request.body;
  if (!stream) return null;

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > limit) {
        await reader.cancel();
        throw new HttpError(413, `request body exceeded ${limit} bytes while it was being read`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(seen);
  chunks.reduce((at, chunk) => {
    body.set(chunk, at);
    return at + chunk.byteLength;
  }, 0);
  return body.buffer;
};

/**
 * The one response shape for an accepted upload, and the one place the status is
 * decided.
 *
 * Both answers come through here — the replay the idempotency lookup found and the
 * asset this call created — so the outcome cannot be reported correctly in the body
 * while the status says something else. That divergence is what mutation API-62
 * exposed when the status was hard-coded, and it stays observable only while every
 * answer is minted here.
 */
const assetResponse = ({ asset, outcome }: CreateImageAssetResult): Response =>
  json({ asset, outcome }, outcome === 'inserted' ? 201 : 200);

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  // Web Crypto is present in Workers, browsers and Node 18+, and it is the same
  // primitive src/twi/server/spec-digest.ts uses for the spec fingerprint.
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Decides what an upload IS, from its first bytes, and refuses everything else.
 *
 * The statement order in here is the guarantee described at the top of the file: the
 * three cheap rejections come first and the read comes last, bounded to
 * {@link MAGIC_BYTE_PROBE_BYTES}. A 100 MB `File` is refused without a byte of its
 * CONTENT being read by this function.
 *
 * What that does NOT claim, because it would not be true: that nothing has been paid
 * for the upload by the time this runs. A `File` handed over by a multipart parser is
 * already in the isolate. Bounding what the parser was given is `uploadImageReference`'s
 * job, not this one's, and it is the second bound described at the top of the file.
 */
export async function validateImageReference(file: UploadedFileLike): Promise<ImageReferenceDescriptor> {
  const { size } = file;
  if (!Number.isInteger(size) || size < 0) {
    throw new HttpError(400, 'upload has no measurable size', 'invalid_upload');
  }
  if (size === 0) throw new HttpError(400, 'upload is empty', 'empty_upload');
  // BEFORE the read below, and that ordering is the whole point. Measuring after
  // buffering turns the cap into a memory amplifier: the isolate has already paid
  // for what it is about to refuse.
  if (size > MAX_IMAGE_REFERENCE_BYTES) {
    throw new HttpError(413, `image reference must be at most ${MAX_IMAGE_REFERENCE_BYTES} bytes`);
  }

  const head = new Uint8Array(await file.slice(0, MAGIC_BYTE_PROBE_BYTES).arrayBuffer());
  const signature = IMAGE_SIGNATURES.find((candidate) => matchesSignature(head, candidate));
  // Neither `file.name` nor `file.type` is consulted, here or anywhere below: both
  // are strings the caller chose.
  if (!signature) {
    throw new HttpError(415, 'image reference must be a JPEG, PNG or WebP image', 'unsupported_image');
  }

  return { extension: signature.extension, contentType: signature.contentType, bytes: size };
}

/**
 * Ten image references per specification.
 *
 * Exported as its own guard rather than folded into the upload path because the
 * limit is a property of a SPECIFICATION, not of a project's storage: the submit
 * path (Task 7) is where a set of references is chosen, and this is the function it
 * calls. See the known limitation recorded in the task report — the upload endpoint
 * does not cap how many references a project may accumulate, because counting them
 * needs a repository read and `src/twi/server/repository.ts` is Task 7's file.
 */
export function assertImageReferenceSelection(imageAssetIds: readonly string[]): void {
  if (imageAssetIds.length > MAX_IMAGE_REFERENCES_PER_SPEC) {
    throw new HttpError(
      400,
      `a specification may reference at most ${MAX_IMAGE_REFERENCES_PER_SPEC} images`,
      'too_many_image_references',
    );
  }
}

/** `twi/{projectId}/assets/{assetId}/source.{ext}`, with both segments checked. */
export function imageReferenceR2Key(projectId: string, assetId: string, extension: ImageExtension): string {
  for (const [field, value] of [
    ['projectId', projectId],
    ['assetId', assetId],
  ] as const) {
    if (!SAFE_KEY_SEGMENT.test(value)) {
      throw new HttpError(400, `${field} is not a usable object-key segment`, 'invalid_identifier');
    }
  }
  return `${R2_TWI_PREFIX}${projectId}/assets/${assetId}/source.${extension}`;
}

/**
 * Validates, stores the object, then records the row — and removes the object again
 * if the row is refused.
 *
 * `registerAsset` returns `{ asset, outcome }`, and the outcome is read rather than
 * discarded: a resolved promise does not mean anything was written. It is surfaced to
 * the caller so `uploadImageReference` can answer 201 for a real insert and 200 for a
 * replay, instead of reporting a creation that did not happen.
 *
 * `input.assetId` is the identity the caller decided, which makes `registerAsset`'s
 * deduplication reachable for the first time — and makes a SHARED OBJECT KEY reachable
 * with it. Three places below exist for that one consequence, and each one is answered
 * where it surfaces rather than by assuming the race away: the put is conditional so a
 * second writer cannot overwrite the first's bytes, a `registerAsset` collision is
 * answered 409 without deleting anything, and the compensating delete first asks whether
 * a committed row names this key.
 */
export async function createImageAsset(
  input: CreateImageAssetInput,
  deps: ImageAssetDeps,
): Promise<CreateImageAssetResult> {
  const { bucket, repo, clock = systemIdentityClock } = deps;
  const descriptor = await validateImageReference(input.file);

  const assetId = input.assetId;
  const r2Key = imageReferenceR2Key(input.projectId, assetId, descriptor.extension);

  // Bounded above by the cap `validateImageReference` has already applied, so this
  // is the first and only point at which the whole upload exists in the isolate.
  const body = await input.file.arrayBuffer();
  if (body.byteLength !== descriptor.bytes) {
    // A file whose reported size disagrees with its content is either a broken
    // client or an attempt to walk past the cap by understating it.
    throw new HttpError(400, 'upload size changed while it was being read', 'invalid_upload');
  }

  const sha256 = await sha256Hex(body);
  // CONDITIONAL, because the key is shared by every concurrent writer of one idempotency
  // key. An unconditional put let the second writer overwrite the first writer's object
  // while the first writer's row kept its own `sha256` and `bytes` — measured: row 8
  // bytes / 9720c604…, object 10 bytes / df5aa251…. A row whose digest does not describe
  // the object it names is a false provenance record in a subsystem whose whole purpose
  // is provenance, and nothing downstream would ever notice. `null` means the key was
  // already taken, which is the same situation the collision branch below answers.
  const stored = await bucket.put(r2Key, body, {
    httpMetadata: { contentType: descriptor.contentType },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (stored === null) {
    throw new HttpError(
      409,
      `${IDEMPOTENCY_KEY_HEADER} is already held by another upload of this project`,
      'idempotency_key_in_flight',
    );
  }

  try {
    // Timestamps are minted in JS, never by SQLite: `datetime('now')` emits no
    // milliseconds and a space separator, both of which `twi_assets_created_at_iso`
    // rejects outright.
    const { asset, outcome } = await repo.registerAsset({
      id: assetId,
      projectId: input.projectId,
      jobId: null,
      kind: 'image-reference',
      label: null,
      r2Key,
      contentType: descriptor.contentType,
      bytes: descriptor.bytes,
      durationSeconds: null,
      sha256,
      provenanceKey: null,
      lifecycleState: 'active',
      createdAt: clock.now(),
      deletedAt: null,
    });
    return { asset, outcome };
  } catch (error) {
    // A collision means a row ALREADY holds this identity. With the id derived from
    // the project and the client's key, that can only be another writer of the same
    // key — so the object under this key is THAT row's, and the compensating delete
    // below would destroy a live asset's bytes while leaving its row behind. That is
    // the exact failure the put-before-insert order exists to avoid, so the delete is
    // skipped and the caller is told the key is taken. A retry then finds the winner's
    // row in the lookup above and is answered 200 without writing anything.
    if (error instanceof TwiRepositoryCollisionError) {
      throw new HttpError(
        409,
        `${IDEMPOTENCY_KEY_HEADER} is already held by another upload of this project`,
        'idempotency_key_in_flight',
      );
    }
    // Compensate ONLY for an object no committed row names, then rethrow the ORIGINAL
    // failure. The re-read is what makes the delete safe: `r2Key` is derived, so it is
    // SHARED with every concurrent writer of this idempotency key, and "clean up the
    // orphan I just made" and "delete whatever is at this key" stopped being the same
    // sentence the moment the key stopped carrying a fresh UUID. Measured before this
    // guard existed: a losing writer whose insert failed for a NON-collision reason
    // deleted the winner's committed object, leaving one row pointing at absent bytes
    // and a retry answering 200 for an asset that was no longer stored. The collision
    // branch above closed one arm of exactly this reasoning; this is the rest of it.
    let committedKey: string | null;
    try {
      committedKey = (await repo.findAssetById(assetId))?.r2Key ?? null;
    } catch (lookupError) {
      // Cannot tell whose object this is. Keeping it costs storage; deleting a committed
      // row's bytes costs correctness — the same trade property 3 above is chosen for —
      // so the unknown case keeps the object and says so.
      committedKey = r2Key;
      console.error('[twi] kept a possibly orphaned R2 object: the owner lookup failed', {
        r2Key,
        error: lookupError instanceof Error ? lookupError.name : typeof lookupError,
      });
    }
    if (committedKey !== r2Key) {
      // A delete that also fails must not replace the diagnosis with its own: the caller
      // needs to know why the row was refused, and the orphan is a storage cost, not a
      // correctness one.
      try {
        await bucket.delete(r2Key);
      } catch (cleanupError) {
        console.error('[twi] orphaned R2 object after a failed asset insert', {
          r2Key,
          error: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
        });
      }
    }
    throw error;
  }
}

/**
 * `POST /api/twi/projects/:projectId/assets` — one multipart `file` field.
 *
 * The dispatcher never consumes the request body, so this is the only place it is
 * read. Everything above that read is a header-only or single-row decision — the
 * multipart requirement, the declared-length bound, the idempotency key, the project's
 * existence and the replay lookup — so a retry, a wrong media type, an oversize
 * declared body and an upload against a missing project all cost nothing.
 */
export async function uploadImageReference(
  request: Request,
  projectId: string,
  deps: ImageAssetDeps,
): Promise<Response> {
  // The RAW header is kept: `contentType` decides which parser to use and is compared
  // in lower case, but a multipart BOUNDARY is case-sensitive, so the raw value is
  // what the parser must be given back below.
  const rawContentType = request.headers.get('Content-Type') ?? '';
  const contentType = rawContentType.toLowerCase();
  if (!contentType.startsWith(MULTIPART_CONTENT_TYPE)) {
    throw new HttpError(415, `upload must be sent as ${MULTIPART_CONTENT_TYPE}`);
  }

  // BEFORE request.formData(). Parsing a 100 MB multipart body to discover it is
  // too large is the defect this ordering exists to avoid; the payload cap inside
  // validateImageReference is the second bound, for a streamed body that declares
  // no length at all.
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BODY_BYTES) {
    throw new HttpError(413, 'request body too large');
  }

  const idempotencyKey = readIdempotencyKey(request);

  // Checked before the body is touched and before anything is written: an upload
  // against a project that does not exist would otherwise leave an object in R2 and
  // surface the foreign-key refusal as internal_error.
  const project = projectId.trim().length === 0 ? null : await deps.repo.getProject(projectId);
  if (!project) throw new HttpError(404, 'project not found');

  // The replay decision, taken here rather than after the upload has been parsed and
  // hashed: one indexed row lookup on a value derived from headers alone. A retry of a
  // 10 MiB upload therefore costs one read and writes NOTHING — no second object, no
  // second row. `registerAsset`'s own deduplication remains the backstop for the race
  // this lookup cannot see, and its collision is answered 409 above.
  const assetId = await deriveImageAssetId(projectId, idempotencyKey);
  const prior = await deps.repo.findAssetById(assetId);
  if (prior) return assetResponse({ asset: prior, outcome: 'replayed' });

  // Bound 2. Read under a hard limit and hand the parser BYTES, so a body that
  // declares no length — or lies about it — cannot make `formData()` buffer more than
  // this. `null` means there is no stream to bound and the parser gets the request.
  const boundedBody = await readBoundedBody(request, MAX_MULTIPART_BODY_BYTES);

  let form: FormData;
  try {
    form =
      boundedBody === null
        ? await request.formData()
        : await new Request(request.url, {
            method: 'POST',
            headers: { 'Content-Type': rawContentType },
            body: boundedBody,
          }).formData();
  } catch {
    // A missing or malformed boundary is a CALLER mistake, and without this it left
    // the parser's `TypeError` to the route's catch — which answers 500 with a
    // correlation id for a request the owner could have fixed. The parser's message
    // quotes the body back, so it is withheld, exactly as `parseJson` withholds
    // JSON.parse's.
    throw new HttpError(400, 'request body is not valid multipart/form-data', 'invalid_multipart');
  }
  const unknownFields = [...new Set(form.keys())].filter((field) => field !== UPLOAD_FILE_FIELD);
  if (unknownFields.length > 0) {
    throw new HttpError(400, `unknown field: ${unknownFields.join(', ')}`, 'unknown_field');
  }

  // Rejected rather than resolved by picking one. Two `file` parts is an ambiguous
  // request, and answering it by silently using the first is the same defect as
  // accepting an unknown field: the owner cannot see which upload was discarded.
  const parts = form.getAll(UPLOAD_FILE_FIELD);
  if (parts.length > 1) {
    throw new HttpError(400, `multipart field \`${UPLOAD_FILE_FIELD}\` was sent ${parts.length} times`, 'duplicate_file');
  }

  const uploaded = form.get(UPLOAD_FILE_FIELD);
  if (uploaded === null) {
    throw new HttpError(400, `multipart field \`${UPLOAD_FILE_FIELD}\` is required`, 'missing_file');
  }
  if (typeof uploaded === 'string') {
    throw new HttpError(400, `multipart field \`${UPLOAD_FILE_FIELD}\` must be a file`, 'invalid_upload');
  }

  // 201 only for a write this call performed. A replayed or reconciled registration
  // is an existing asset being reported, not a creation, and saying 201 there would
  // make the outcome field the only honest part of the answer. `assetResponse` is the
  // single place that decision is made, for both this answer and the replay above.
  return assetResponse(await createImageAsset({ projectId, file: uploaded, assetId }, deps));
}
