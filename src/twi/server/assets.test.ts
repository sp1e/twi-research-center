// @vitest-environment node
/// <reference types="node" />
//
// Image-reference ingestion, driven against a REAL in-memory database loading the
// actual Task 3 migration — the same choice projects.test.ts made and for the same
// reason: a stubbed repository would happily accept an asset row that
// `twi_assets_created_at_iso` or `twi_assets_bytes_integer` rejects, so every
// acceptance here is also proof the row stores, and every rejection is checked to
// have written nothing to D1 AND nothing to R2.
//
// The R2 side is a recording fake rather than miniflare: what has to be proven is
// the ORDER of operations (bytes read only after the size cap, object deleted when
// the insert fails) and a fake is the only thing that can witness an order. The
// binding's own semantics are Cloudflare's, not this layer's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generationSpecObject } from '../domain/schemas';

import {
  assertImageReferenceSelection,
  createImageAsset,
  deriveImageAssetId,
  imageReferenceR2Key,
  MAGIC_BYTE_PROBE_BYTES,
  MAX_IMAGE_REFERENCE_BYTES,
  MAX_IMAGE_REFERENCES_PER_SPEC,
  MAX_MULTIPART_BODY_BYTES,
  R2_TWI_PREFIX,
  uploadImageReference,
  validateImageReference,
  type UploadedFileLike,
} from './assets';
import { creationCoreCapabilities } from './capabilities';
import { HttpError } from './http';
import { D1TwiRepository } from './repository';
import { SqliteD1 } from './repository.harness';
import type { R2BucketLike, R2ObjectLike, R2PutValue, R2PutOptionsLike } from './r2-types';
import { draft } from '../domain/spec.fixture';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The first bytes of each format this API accepts, and nothing more than needed. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// 'RIFF' + a little-endian size + 'WEBP'. The size field is deliberately junk: the
// container length is not what identifies the format, and trusting it would be one
// more caller-supplied number.
const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

const file = (bytes: number[], name: string, type: string): File =>
  new File([new Uint8Array(bytes)], name, { type });

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-08-17T09:15:00.000Z';

const clock = (id: string, now: string) => ({ newId: () => id, now: () => now });

/**
 * A recording R2 double. Every call is logged in order, so a test can assert what
 * happened AND what did not.
 */
class RecordingBucket implements R2BucketLike {
  readonly calls: string[] = [];
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  putRejection: Error | null = null;
  deleteRejection: Error | null = null;

  async put(key: string, value: R2PutValue, options?: R2PutOptionsLike): Promise<R2ObjectLike | null> {
    this.calls.push(`put:${key}`);
    if (this.putRejection) throw this.putRejection;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(0);
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    return { key, size: bytes.byteLength, etag: 'etag' };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.calls.push(`delete:${key}`);
      this.objects.delete(key);
    }
    if (this.deleteRejection) throw this.deleteRejection;
  }
}

/**
 * A file that refuses to hand over a byte.
 *
 * This is the instrument for the whole "size before buffering" claim: if any code
 * path reads content before the cap has been applied, the test fails with
 * `materialised the upload` instead of the 413 it expects. A comment saying the cap
 * comes first is not evidence; this is.
 */
const unreadableFile = (size: number, name = 'huge.jpg', type = 'image/jpeg'): UploadedFileLike => ({
  name,
  type,
  size,
  slice: () => {
    throw new Error('materialised the upload');
  },
  arrayBuffer: () => {
    throw new Error('materialised the upload');
  },
});

/**
 * A default idempotency key, so the ordinary upload request in these tests is a
 * complete one. Two calls that pass the same key are the SAME upload by contract —
 * which is what the replay test below relies on, and no longer needs a fixed clock for.
 */
const IDEMPOTENCY_KEY = 'upload-key-1';

const multipart = (form: FormData, headers: Record<string, string> = {}) =>
  new Request(`https://sp1e.se/api/twi/projects/${PROJECT_ID}/assets`, {
    method: 'POST',
    headers: { Origin: 'https://sp1e.se', 'Idempotency-Key': IDEMPOTENCY_KEY, ...headers },
    body: form,
  });

const withFile = (value: File | Blob | string, field = 'file') => {
  const form = new FormData();
  form.set(field, value);
  return form;
};

// ── Suites ───────────────────────────────────────────────────────────────────

describe('validateImageReference', () => {
  it('accepts JPEG magic bytes and reports the extension and type from the BYTES', async () => {
    await expect(validateImageReference(file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'))).resolves.toMatchObject({
      extension: 'jpg',
      contentType: 'image/jpeg',
    });
  });

  it('accepts PNG magic bytes', async () => {
    await expect(validateImageReference(file(PNG_MAGIC, 'mood.png', 'image/png'))).resolves.toMatchObject({
      extension: 'png',
      contentType: 'image/png',
    });
  });

  it('accepts WebP magic bytes (RIFF….WEBP)', async () => {
    await expect(validateImageReference(file(WEBP_MAGIC, 'mood.webp', 'image/webp'))).resolves.toMatchObject({
      extension: 'webp',
      contentType: 'image/webp',
    });
  });

  it('reports the byte length it measured', async () => {
    await expect(validateImageReference(file(PNG_MAGIC, 'mood.png', 'image/png'))).resolves.toMatchObject({
      bytes: PNG_MAGIC.length,
    });
  });

  // ── The four rejections the brief names ────────────────────────────────────

  it('rejects extension-only spoofing: a .jpg named text/PHP file is not an image', async () => {
    const spoofed = file([...Buffer.from('<?php system($_GET["c"]); ?>')], 'mood.jpg', 'image/jpeg');
    await expect(validateImageReference(spoofed)).rejects.toMatchObject({ status: 415 });
  });

  it('rejects a declared image/png whose bytes are not any accepted image', async () => {
    const gif = file([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'mood.png', 'image/png');
    await expect(validateImageReference(gif)).rejects.toMatchObject({ status: 415 });
  });

  it('trusts NEITHER the extension nor the declared content type — PNG bytes named .jpg are png', async () => {
    await expect(validateImageReference(file(PNG_MAGIC, 'liar.jpg', 'image/jpeg'))).resolves.toMatchObject({
      extension: 'png',
      contentType: 'image/png',
    });
  });

  it('rejects a truncated WebP header: RIFF alone is not WEBP', async () => {
    await expect(validateImageReference(file([0x52, 0x49, 0x46, 0x46], 'x.webp', 'image/webp'))).rejects.toMatchObject({
      status: 415,
    });
  });

  it('rejects an empty upload', async () => {
    await expect(validateImageReference(file([], 'empty.png', 'image/png'))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a file one byte over 10 MiB', async () => {
    await expect(validateImageReference(unreadableFile(MAX_IMAGE_REFERENCE_BYTES + 1))).rejects.toMatchObject({
      status: 413,
    });
  });

  it('the cap is exactly 10 * 1024 * 1024', () => {
    expect(MAX_IMAGE_REFERENCE_BYTES).toBe(10 * 1024 * 1024);
  });

  // ── Size BEFORE buffering ──────────────────────────────────────────────────

  it('refuses a 100 MB upload WITHOUT reading a byte of it', async () => {
    const huge = unreadableFile(100 * 1024 * 1024);
    // If the implementation reads first and measures second, this rejects with
    // `materialised the upload` and the assertion on `status` fails.
    await expect(validateImageReference(huge)).rejects.toMatchObject({ status: 413 });
  });

  it('reads at most the probe window, never the whole accepted file', async () => {
    const requested: Array<[number | undefined, number | undefined]> = [];
    const payload = new Uint8Array(4096);
    payload.set(PNG_MAGIC);
    const probed: UploadedFileLike = {
      name: 'big.png',
      type: 'image/png',
      size: payload.byteLength,
      slice: (start, end) => {
        requested.push([start, end]);
        return { arrayBuffer: async () => payload.slice(start ?? 0, end).buffer as ArrayBuffer };
      },
      arrayBuffer: () => {
        throw new Error('materialised the upload');
      },
    };

    await expect(validateImageReference(probed)).resolves.toMatchObject({ extension: 'png' });
    expect(requested).toEqual([[0, MAGIC_BYTE_PROBE_BYTES]]);
  });

  it('the probe window is 16 bytes, as the brief specifies', () => {
    expect(MAGIC_BYTE_PROBE_BYTES).toBe(16);
  });
});

describe('assertImageReferenceSelection — ten references per specification', () => {
  const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `id-${index}`);

  it('accepts exactly ten', () => {
    expect(() => assertImageReferenceSelection(ids(MAX_IMAGE_REFERENCES_PER_SPEC))).not.toThrow();
  });

  it('rejects eleven', () => {
    expect(() => assertImageReferenceSelection(ids(11))).toThrow(HttpError);
  });

  it('rejects eleven with 400 and a specific code', () => {
    try {
      assertImageReferenceSelection(ids(11));
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'too_many_image_references' });
    }
  });

  it('accepts none', () => {
    expect(() => assertImageReferenceSelection([])).not.toThrow();
  });

  it('the limit is the capability catalog’s, not a second copy of the number', () => {
    expect(MAX_IMAGE_REFERENCES_PER_SPEC).toBe(creationCoreCapabilities.maxImageReferences);
    expect(MAX_IMAGE_REFERENCES_PER_SPEC).toBe(10);
  });

  it('agrees with the specification schema, which rejects an eleventh reference', () => {
    const withReferences = (count: number) => ({
      ...draft,
      sound: { ...draft.sound, imageAssetIds: ids(count).map(() => PROJECT_ID) },
    });

    expect(generationSpecObject.safeParse(withReferences(MAX_IMAGE_REFERENCES_PER_SPEC)).success).toBe(true);
    expect(generationSpecObject.safeParse(withReferences(MAX_IMAGE_REFERENCES_PER_SPEC + 1)).success).toBe(false);
  });
});

describe('imageReferenceR2Key', () => {
  it('writes under the twi/ prefix at the mandated path', () => {
    expect(imageReferenceR2Key(PROJECT_ID, ASSET_ID, 'jpg')).toBe(
      `twi/${PROJECT_ID}/assets/${ASSET_ID}/source.jpg`,
    );
  });

  it('the prefix constant is twi/', () => {
    expect(R2_TWI_PREFIX).toBe('twi/');
    expect(imageReferenceR2Key(PROJECT_ID, ASSET_ID, 'png').startsWith(R2_TWI_PREFIX)).toBe(true);
  });

  it('refuses an identifier that could escape the project prefix', () => {
    expect(() => imageReferenceR2Key('../other', ASSET_ID, 'png')).toThrow(HttpError);
    expect(() => imageReferenceR2Key(PROJECT_ID, 'a/b', 'png')).toThrow(HttpError);
  });
});

describe('createImageAsset', () => {
  let db: SqliteD1;
  let repo: D1TwiRepository;
  let bucket: RecordingBucket;

  const seedProject = () =>
    repo.createProject({ id: PROJECT_ID, name: 'Nocturne Instrument', now: NOW });

  beforeEach(async () => {
    db = new SqliteD1();
    repo = new D1TwiRepository({ DB: db });
    bucket = new RecordingBucket();
    await seedProject();
  });

  afterEach(() => db.close());

  const create = (input: File | UploadedFileLike = file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg')) =>
    createImageAsset(
      { projectId: PROJECT_ID, file: input, assetId: ASSET_ID },
      { bucket, repo, clock: clock(ASSET_ID, NOW) },
    );

  it('writes the R2 object BEFORE inserting the row, and inserts once', async () => {
    const { asset, outcome } = await create();

    expect(bucket.calls).toEqual([`put:twi/${PROJECT_ID}/assets/${ASSET_ID}/source.jpg`]);
    expect(outcome).toBe('inserted');
    expect(asset.r2Key).toBe(`twi/${PROJECT_ID}/assets/${ASSET_ID}/source.jpg`);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(1);
  });

  it('stores the row the schema accepts: kind, content type, bytes and an ISO timestamp', async () => {
    const { asset } = await create();

    expect(asset).toMatchObject({
      id: ASSET_ID,
      projectId: PROJECT_ID,
      jobId: null,
      kind: 'image-reference',
      label: null,
      contentType: 'image/jpeg',
      bytes: JPEG_MAGIC.length,
      durationSeconds: null,
      lifecycleState: 'active',
      createdAt: NOW,
      deletedAt: null,
    });
    expect(db.value<string>('SELECT created_at FROM twi_assets')).toBe(NOW);
    expect(db.value<string>('SELECT kind FROM twi_assets')).toBe('image-reference');
  });

  it('records the SHA-256 of the stored bytes, computed with Web Crypto', async () => {
    const { asset } = await create();
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(JPEG_MAGIC));
    const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

    expect(asset.sha256).toBe(expected);
    expect(db.value<string>('SELECT sha256 FROM twi_assets')).toBe(expected);
  });

  it('puts the validated content type on the object, not the caller’s claim', async () => {
    await createImageAsset(
      { projectId: PROJECT_ID, file: file(PNG_MAGIC, 'liar.jpg', 'image/jpeg'), assetId: ASSET_ID },
      { bucket, repo, clock: clock(ASSET_ID, NOW) },
    );
    expect(bucket.objects.get(`twi/${PROJECT_ID}/assets/${ASSET_ID}/source.png`)?.contentType).toBe('image/png');
  });

  it('DELETES the just-written object when the metadata insert fails, then rethrows', async () => {
    const boom = new Error('D1_ERROR: no such table (secret-connection-string)');
    const failing = {
      ...repo,
      registerAsset: async () => {
        throw boom;
      },
    } as unknown as D1TwiRepository;

    await expect(
      createImageAsset({ projectId: PROJECT_ID, file: file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'), assetId: ASSET_ID }, {
        bucket,
        repo: failing,
        clock: clock(ASSET_ID, NOW),
      }),
    ).rejects.toBe(boom);

    const key = `twi/${PROJECT_ID}/assets/${ASSET_ID}/source.jpg`;
    expect(bucket.calls).toEqual([`put:${key}`, `delete:${key}`]);
    expect(bucket.objects.has(key)).toBe(false);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(0);
  });

  it('rethrows the ORIGINAL failure even when the compensating delete also fails', async () => {
    const boom = new Error('D1 down');
    bucket.deleteRejection = new Error('R2 down');
    const failing = {
      ...repo,
      registerAsset: async () => {
        throw boom;
      },
    } as unknown as D1TwiRepository;

    await expect(
      createImageAsset({ projectId: PROJECT_ID, file: file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'), assetId: ASSET_ID }, {
        bucket,
        repo: failing,
        clock: clock(ASSET_ID, NOW),
      }),
    ).rejects.toBe(boom);
  });

  it('does not insert a row when the R2 put fails', async () => {
    bucket.putRejection = new Error('R2 unavailable');

    await expect(create()).rejects.toThrow('R2 unavailable');
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(0);
  });

  it('validates before touching R2 — a spoofed file writes nothing at all', async () => {
    const spoofed = file([...Buffer.from('not an image')], 'mood.jpg', 'image/jpeg');

    await expect(create(spoofed)).rejects.toMatchObject({ status: 415 });
    expect(bucket.calls).toEqual([]);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(0);
  });

  it('refuses an oversize upload without reading it or touching R2', async () => {
    await expect(create(unreadableFile(MAX_IMAGE_REFERENCE_BYTES + 1))).rejects.toMatchObject({ status: 413 });
    expect(bucket.calls).toEqual([]);
  });

  it('stores two distinct identities as two rows, with a JS ISO timestamp, on the default clock', async () => {
    // No injected clock: `createdAt` comes from `systemIdentityClock`, so this is also
    // the test that the real timestamp satisfies `twi_assets_created_at_iso`.
    const a = await deriveImageAssetId(PROJECT_ID, 'key-a');
    const b = await deriveImageAssetId(PROJECT_ID, 'key-b');
    expect(a).not.toBe(b);
    await createImageAsset(
      { projectId: PROJECT_ID, file: file(JPEG_MAGIC, 'a.jpg', 'image/jpeg'), assetId: a },
      { bucket, repo },
    );
    await createImageAsset(
      { projectId: PROJECT_ID, file: file(PNG_MAGIC, 'b.png', 'image/png'), assetId: b },
      { bucket, repo },
    );

    const ids = db.database.prepare('SELECT id FROM twi_assets').all() as Array<{ id: string }>;
    expect(new Set(ids.map((row) => row.id)).size).toBe(2);
    expect(db.value<string>('SELECT created_at FROM twi_assets LIMIT 1')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('refuses a file whose reported size disagrees with the bytes it hands over', async () => {
    // Understating `size` is the one way past a cap that trusts it, so the two are
    // compared after the read. Nothing may reach R2.
    const lying: UploadedFileLike = {
      name: 'liar.png',
      type: 'image/png',
      size: PNG_MAGIC.length,
      slice: (start, end) => ({
        arrayBuffer: async () => new Uint8Array(PNG_MAGIC).slice(start ?? 0, end).buffer as ArrayBuffer,
      }),
      arrayBuffer: async () => new Uint8Array([...PNG_MAGIC, 0, 0, 0, 0]).buffer as ArrayBuffer,
    };

    await expect(create(lying)).rejects.toMatchObject({ status: 400, code: 'invalid_upload' });
    expect(bucket.calls).toEqual([]);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(0);
  });

  it('reports a replayed registration rather than presenting it as a fresh insert', async () => {
    await create();
    // The same identity twice — which is now what a client retry looks like, because
    // the id is derived from its idempotency key rather than minted per call.
    // registerAsset deduplicates on the id and the r2Key; `outcome` is the only thing
    // that says the second call wrote nothing.
    const second = await create();
    expect(second.outcome).toBe('replayed');
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(1);
  });
});

describe('uploadImageReference — the POST route handler', () => {
  let db: SqliteD1;
  let repo: D1TwiRepository;
  let bucket: RecordingBucket;

  beforeEach(async () => {
    db = new SqliteD1();
    repo = new D1TwiRepository({ DB: db });
    bucket = new RecordingBucket();
    await repo.createProject({ id: PROJECT_ID, name: 'Nocturne Instrument', now: NOW });
  });

  afterEach(() => db.close());

  const upload = (request: Request, projectId = PROJECT_ID) =>
    uploadImageReference(request, projectId, { bucket, repo, clock: clock(ASSET_ID, NOW) });

  it('answers 201 with the asset record and the outcome', async () => {
    const response = await upload(multipart(withFile(file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'))));

    expect(response.status).toBe(201);
    const body = (await response.json()) as { asset: Record<string, unknown>; outcome: string };
    expect(body.outcome).toBe('inserted');
    expect(body.asset).toMatchObject({
      // The id is the one the request's `Idempotency-Key` names, not one this call
      // invented: that is what makes a retry land on this row instead of a second one.
      id: await deriveImageAssetId(PROJECT_ID, IDEMPOTENCY_KEY),
      projectId: PROJECT_ID,
      kind: 'image-reference',
      contentType: 'image/jpeg',
    });
  });

  // The outcome has to change the ANSWER, or reading it is decoration. Both requests
  // carry the same `Idempotency-Key`, so the second one is the same upload by contract
  // and is answered out of the row the first one wrote. Nothing here depends on the
  // injected clock any more: this is what a real retry does.
  it('answers 200, not 201, when the registration was a replay rather than a write', async () => {
    const first = await upload(multipart(withFile(file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'))));
    expect(first.status).toBe(201);

    const second = await upload(multipart(withFile(file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'))));
    expect(second.status).toBe(200);
    expect((await second.json()).outcome).toBe('replayed');
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(1);
  });

  it('answers through json(), so the CORS headers are attached', async () => {
    const response = await upload(multipart(withFile(file(PNG_MAGIC, 'mood.png', 'image/png'))));
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://sp1e.se');
  });

  it('discloses no binding, credential or R2 endpoint in the response', async () => {
    const response = await upload(multipart(withFile(file(PNG_MAGIC, 'mood.png', 'image/png'))));
    const text = await response.text();

    for (const forbidden of ['FILES', 'sp1e-files', 'accessKey', 'secret', 'accountId', 'r2.cloudflarestorage']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('404s for a project that does not exist, without writing to R2', async () => {
    await expect(
      upload(multipart(withFile(file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'))), '33333333-3333-4333-8333-333333333333'),
    ).rejects.toMatchObject({ status: 404 });
    expect(bucket.calls).toEqual([]);
  });

  it('400s when the multipart form carries no file field', async () => {
    const form = new FormData();
    form.set('notfile', 'x');
    await expect(upload(multipart(form))).rejects.toMatchObject({ status: 400 });
  });

  it('400s when the form carries a field other than file', async () => {
    const form = withFile(file(JPEG_MAGIC, 'mood.jpg', 'image/jpeg'));
    form.set('label', 'extra');
    await expect(upload(multipart(form))).rejects.toMatchObject({ status: 400, code: 'unknown_field' });
  });

  it('400s when the file field is sent twice, rather than silently using the first', async () => {
    const form = new FormData();
    form.append('file', file(JPEG_MAGIC, 'one.jpg', 'image/jpeg'));
    form.append('file', file(PNG_MAGIC, 'two.png', 'image/png'));

    await expect(upload(multipart(form))).rejects.toMatchObject({ status: 400, code: 'duplicate_file' });
    expect(bucket.calls).toEqual([]);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(0);
  });

  it('400s when the file field is a plain string rather than a file', async () => {
    await expect(upload(multipart(withFile('just text')))).rejects.toMatchObject({ status: 400 });
  });

  it('415s a body that is not multipart/form-data', async () => {
    const request = new Request(`https://sp1e.se/api/twi/projects/${PROJECT_ID}/assets`, {
      method: 'POST',
      headers: { Origin: 'https://sp1e.se', 'Content-Type': 'application/json' },
      body: '{}',
    });
    await expect(upload(request)).rejects.toMatchObject({ status: 415 });
  });

  it('415s a spoofed upload and leaves R2 and D1 untouched', async () => {
    // The bytes of a PE/DOS header, written as numbers rather than as a string with a
    // literal NUL in it: the NUL made ripgrep and GNU grep report this whole file as
    // binary and suppress every match, which is the same shape as route-dispatch.test.ts.
    const spoofed = file([0x4d, 0x5a, 0x90, 0x00], 'mood.png', 'image/png');
    await expect(upload(multipart(withFile(spoofed)))).rejects.toMatchObject({ status: 415 });
    expect(bucket.calls).toEqual([]);
    expect(db.value<number>('SELECT COUNT(*) FROM twi_assets')).toBe(0);
  });

  // ── The declared-length gate: refuse before parsing the body ───────────────

  it('refuses an oversize declared body WITHOUT parsing the multipart form', async () => {
    let formDataCalls = 0;
    const request = {
      method: 'POST',
      headers: new Headers({
        'Content-Type': 'multipart/form-data; boundary=x',
        'Content-Length': String(100 * 1024 * 1024),
        'Idempotency-Key': IDEMPOTENCY_KEY,
      }),
      formData: async () => {
        formDataCalls += 1;
        throw new Error('parsed the multipart body');
      },
    } as unknown as Request;

    await expect(upload(request)).rejects.toMatchObject({ status: 413 });
    expect(formDataCalls).toBe(0);
    expect(bucket.calls).toEqual([]);
  });

  it('the declared-length gate leaves multipart envelope slack above the 10 MiB payload cap', () => {
    expect(MAX_MULTIPART_BODY_BYTES).toBeGreaterThan(MAX_IMAGE_REFERENCE_BYTES);
    expect(MAX_MULTIPART_BODY_BYTES).toBeLessThan(MAX_IMAGE_REFERENCE_BYTES * 2);
  });

  // A streamed multipart body carries no Content-Length, so the gate above cannot
  // see it — exactly the hole `parseJson` documents for JSON bodies. The payload cap
  // inside validateImageReference is the second, independent bound, and it still
  // fires without reading the content.
  it('still applies the payload cap when no Content-Length is declared', async () => {
    const oversize = new File([new Uint8Array(MAX_IMAGE_REFERENCE_BYTES + 1)], 'huge.jpg', { type: 'image/jpeg' });
    const form = new FormData();
    form.set('file', oversize);
    const request = {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'multipart/form-data; boundary=x', 'Idempotency-Key': IDEMPOTENCY_KEY }),
      formData: async () => form,
    } as unknown as Request;

    await expect(upload(request)).rejects.toMatchObject({ status: 413 });
    expect(bucket.calls).toEqual([]);
  });
});
