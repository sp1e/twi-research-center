// @vitest-environment node
/// <reference types="node" />
//
// The ingestion contract, driven by REAL requests.
//
// A separate file from assets.test.ts, and the split is the point rather than a size
// convenience. That suite proves the ORDERS with doubles: a `File` that throws when
// read, a `Request` whose `formData()` counts its calls. Doubles are the only
// instrument that can witness an order — and they are also the reason a whole class of
// defect stayed invisible for a round. Both "no Content-Length" tests there stub
// `formData()`, so the suite structurally could not see that the parser had already
// buffered the entire body before the refusal, nor that a malformed body answered 500.
//
// So everything here is a real `Request` over a real body: a real chunked
// `ReadableStream` that COUNTS the bytes it hands out, a real malformed multipart body,
// a real hand-built envelope with a mixed-case boundary. Where a double appears (the
// raced insert) it is because the behaviour cannot be produced any other way, and the
// test says so.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createImageAsset,
  deriveImageAssetId,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_IMAGE_REFERENCE_BYTES,
  MAX_MULTIPART_BODY_BYTES,
  uploadImageReference,
  validateImageReference,
  type UploadedFileLike,
} from './assets';
import { TwiRepositoryCollisionError } from './errors';
import { D1TwiRepository } from './repository';
import { SqliteD1 } from './repository.harness';
import type { R2BucketLike, R2ObjectLike, R2PutValue, R2PutOptionsLike } from './r2-types';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-17T09:15:00.000Z';
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const URL_ = `https://sp1e.se/api/twi/projects/${PROJECT_ID}/assets`;

class RecordingBucket implements R2BucketLike {
  readonly calls: string[] = [];
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: R2PutValue, _options?: R2PutOptionsLike): Promise<R2ObjectLike | null> {
    this.calls.push(`put:${key}`);
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(0);
    this.objects.set(key, bytes);
    return { key, size: bytes.byteLength, etag: 'etag' };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.calls.push(`delete:${key}`);
      this.objects.delete(key);
    }
  }
}

/**
 * The same recorder, plus R2's conditional-put semantics — and nothing else.
 *
 * `put` with `onlyIf: { etagDoesNotMatch: '*' }` stores the object only while the key is
 * free and answers `null` when it is not. That is the shape `@cloudflare/workers-types`
 * 4.20260702.1 declares by giving the conditional overload — and only it — a nullable
 * return.
 *
 * It is an instrument rather than a courtesy: the precondition is honoured ONLY when the
 * caller asks for it, so a `put` that stops passing `onlyIf` overwrites here exactly as
 * an unconditional put overwrites in R2, and the divergence assertion below goes red.
 * {@link RecordingBucket} deliberately keeps ignoring the option, which is what lets the
 * delete-compensation test model a bucket that does not honour preconditions at all.
 */
class ConditionalBucket extends RecordingBucket {
  async put(key: string, value: R2PutValue, options?: R2PutOptionsLike): Promise<R2ObjectLike | null> {
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) {
      this.calls.push(`put-refused:${key}`);
      return null;
    }
    return super.put(key, value, options);
  }
}

const sha256Of = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * A multipart envelope built by hand, so the test owns the boundary.
 *
 * `FormData` picks its own, which is fine for parsing but says nothing about whether
 * the boundary survived the round trip through this module — and the boundary is
 * case-SENSITIVE, so "survived" is exactly the question.
 */
const envelope = (boundary: string, bytes: number[], filename = 'mood.jpg', type = 'image/jpeg'): ArrayBuffer => {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(bytes), head.length);
  body.set(tail, head.length + bytes.length);
  return body.buffer as ArrayBuffer;
};

const request = (init: { contentType: string; body: BodyInit; key?: string | null }): Request =>
  new Request(URL_, {
    method: 'POST',
    headers: {
      Origin: 'https://sp1e.se',
      'Content-Type': init.contentType,
      ...(init.key === null ? {} : { 'Idempotency-Key': init.key ?? 'upload-key-1' }),
    },
    body: init.body,
    // `duplex` is required by undici for a stream body and is absent from lib.dom's
    // RequestInit; the cast is the only way to send one from a typechecked test.
    ...({ duplex: 'half' } as Record<string, string>),
  });

/**
 * A chunked body that reports what was pulled out of it.
 *
 * `pulled` is the measurement the whole "bound 2" claim rests on: with no
 * `Content-Length` on the request, nothing but this bound stops the parser reading the
 * lot, and this counter is the only witness to which of the two happened.
 */
const CHUNK_BYTES = 64 * 1024;

/**
 * How much more than the bound a bounded read may still have pulled.
 *
 * Named for what it actually is, and sized to the composition rather than to a guess.
 * The bound is checked once per chunk, so the CHUNK THAT CROSSES it is already in the
 * isolate before `seen` can exceed the limit, and `undici` has read one chunk ahead of
 * the consumer on top of that — two chunks, which is therefore the DERIVED ceiling and
 * not a margin someone chose. The bound is not chunk-aligned (10,502,144 = 160.25 × 64
 * KiB), so the crossing chunk is partial and the measurement comes in just under: all
 * three cases below pulled 10,616,832 B, over-bound 114,688 B = 1.75 × 64 KiB. An
 * earlier comment here called 8 × 64 KiB "undici's read-ahead", which was both the
 * wrong figure and the wrong mechanism.
 *
 * "Stopped at the bound" still cannot be asserted to the byte, and does not need to be:
 * the case these assertions exist to catch pulls the body's ENTIRE length, orders of
 * magnitude away. What CANNOT be asserted here at all is a ceiling in bytes: the unit is
 * the chunk and the chunk size is the producer's choice, so a stream that hands over one
 * 48 MiB chunk pulls 50,331,648 B against this same bound (over-bound 39,829,504).
 * Unreachable over HTTP and unfixable in code — see `readBoundedBody`.
 */
const CROSSING_CHUNK_AND_READ_AHEAD_SLACK = 2 * CHUNK_BYTES;

const countingStream = (totalBytes: number, chunkBytes = CHUNK_BYTES) => {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x41);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= totalBytes) return controller.close();
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk.slice());
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
};

describe('the upload endpoint, over real requests', () => {
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

  const upload = (req: Request, projectId = PROJECT_ID) =>
    uploadImageReference(req, projectId, { bucket, repo });

  const assetCount = () => db.value<number>('SELECT COUNT(*) FROM twi_assets');

  const jpegForm = (trailing: number[] = []): FormData => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([...JPEG_MAGIC, ...trailing])], 'mood.jpg', { type: 'image/jpeg' }));
    return form;
  };

  const withKey = (key: string | null, form: FormData = jpegForm()): Request => {
    const built = new Request(URL_, { method: 'POST', body: form });
    return new Request(URL_, {
      method: 'POST',
      headers: {
        Origin: 'https://sp1e.se',
        'Content-Type': built.headers.get('Content-Type') ?? '',
        ...(key === null ? {} : { 'Idempotency-Key': key }),
      },
      body: built.body,
      ...({ duplex: 'half' } as Record<string, string>),
    });
  };

  // ── A malformed body is the CALLER's mistake ────────────────────────────────

  it('answers 400 for a real malformed multipart body, not 500', async () => {
    // No stub anywhere: undici parses this and throws `TypeError: Failed to parse body
    // as FormData`. Unguarded, that TypeError reached the route's catch and became
    // `internal error` + a correlationId — a server fault reported for a client mistake.
    const response = upload(request({ contentType: 'multipart/form-data; boundary=zzz', body: 'garbage' }));

    await expect(response).rejects.toMatchObject({ status: 400, code: 'invalid_multipart' });
    expect(bucket.calls).toEqual([]);
    expect(assetCount()).toBe(0);
  });

  it('answers 400 when the multipart content type declares no boundary at all', async () => {
    await expect(
      upload(request({ contentType: 'multipart/form-data', body: 'anything' })),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_multipart' });
    expect(bucket.calls).toEqual([]);
  });

  it('does not quote the parser’s message back, which quotes the body', async () => {
    // Asserted through `rejects` rather than a `.catch()` callback: a callback that is
    // never invoked is a test that passes without asserting anything.
    await expect(
      upload(request({ contentType: 'multipart/form-data; boundary=zzz', body: 'garbage' })),
    ).rejects.toMatchObject({ message: 'request body is not valid multipart/form-data' });
  });

  // ── Bound 2: the stream itself ──────────────────────────────────────────────

  it('stops reading an undeclared oversize body at the bound instead of buffering all of it', async () => {
    const { stream, state } = countingStream(64 * 1024 * 1024);
    const req = request({ contentType: 'multipart/form-data; boundary=x', body: stream });
    expect(req.headers.get('Content-Length')).toBeNull();

    await expect(upload(req)).rejects.toMatchObject({ status: 413 });

    // The measurement, not the status, is the assertion: before bound 2 existed the
    // status was ALSO 413 here — after `formData()` had buffered every byte.
    expect(state.pulled).toBeLessThanOrEqual(MAX_MULTIPART_BODY_BYTES + CROSSING_CHUNK_AND_READ_AHEAD_SLACK);
    expect(state.pulled).toBeLessThan(64 * 1024 * 1024);
    expect(state.cancelled).toBe(true);
    expect(bucket.calls).toEqual([]);
    expect(assetCount()).toBe(0);
  });

  it('bounds a body whose Content-Length is not a number', async () => {
    const { stream, state } = countingStream(32 * 1024 * 1024);
    const req = new Request(URL_, {
      method: 'POST',
      headers: {
        Origin: 'https://sp1e.se',
        'Content-Type': 'multipart/form-data; boundary=x',
        'Idempotency-Key': 'upload-key-1',
        // `Number('not-a-number')` is NaN, so the declared-length gate above cannot
        // fire and bound 2 is the only thing left.
        'Content-Length': 'not-a-number',
      },
      body: stream,
      ...({ duplex: 'half' } as Record<string, string>),
    });

    await expect(upload(req)).rejects.toMatchObject({ status: 413 });
    expect(state.pulled).toBeLessThanOrEqual(MAX_MULTIPART_BODY_BYTES + CROSSING_CHUNK_AND_READ_AHEAD_SLACK);
    expect(state.pulled).toBeLessThan(32 * 1024 * 1024);
  });

  it('bounds a body whose Content-Length UNDERSTATES its size', async () => {
    // The third of the three shapes bound 2 exists for, and the one no committed test
    // drove: a declared length small enough to sail through the header gate
    // (`Number('10')` is finite and far under the bound) on a body that then hands over
    // 32 MiB. Nothing but the streamed bound is left to refuse it.
    const { stream, state } = countingStream(32 * 1024 * 1024);
    const req = new Request(URL_, {
      method: 'POST',
      headers: {
        Origin: 'https://sp1e.se',
        'Content-Type': 'multipart/form-data; boundary=x',
        'Idempotency-Key': 'understated-key',
        'Content-Length': '10',
      },
      body: stream,
      ...({ duplex: 'half' } as Record<string, string>),
    });

    await expect(upload(req)).rejects.toMatchObject({ status: 413 });
    expect(state.pulled).toBeLessThanOrEqual(MAX_MULTIPART_BODY_BYTES + CROSSING_CHUNK_AND_READ_AHEAD_SLACK);
    expect(state.pulled).toBeLessThan(32 * 1024 * 1024);
    expect(state.cancelled).toBe(true);
    expect(bucket.calls).toEqual([]);
    expect(assetCount()).toBe(0);
  });

  it('accepts a real streamed body that stays inside the bound', async () => {
    const response = await upload(withKey('streamed-key'));

    expect(response.status).toBe(201);
    expect(assetCount()).toBe(1);
  });

  // ── The raw content type is what the parser gets back ───────────────────────

  it('preserves a MIXED-CASE multipart boundary through the bounded read', async () => {
    // The gate compares the content type in lower case; handing the LOWERCASED value
    // back to the parser would destroy this boundary and turn a valid upload into a 400.
    const boundary = 'AbCdEf--MiXeD';
    const response = await upload(
      request({
        contentType: `multipart/form-data; boundary=${boundary}`,
        body: envelope(boundary, JPEG_MAGIC),
      }),
    );

    expect(response.status).toBe(201);
    expect(assetCount()).toBe(1);
  });

  it('accepts an UPPERCASE media type, because the comparison is case-insensitive', async () => {
    const boundary = 'plainboundary';
    const response = await upload(
      request({
        contentType: `MULTIPART/FORM-DATA; boundary=${boundary}`,
        body: envelope(boundary, JPEG_MAGIC),
      }),
    );

    expect(response.status).toBe(201);
  });

  it('refuses a media type that merely CONTAINS multipart/form-data', async () => {
    // `startsWith`, not `includes`: a JSON body that names the multipart type in a
    // parameter is not a multipart body, and a widened comparison would try to parse it.
    await expect(
      upload(request({ contentType: 'application/json; note=multipart/form-data', body: '{}' })),
    ).rejects.toMatchObject({ status: 415 });
    expect(bucket.calls).toEqual([]);
  });

  // ── Idempotency: the identity comes from the client ─────────────────────────

  it('requires an Idempotency-Key and names it in the code', async () => {
    await expect(upload(withKey(null))).rejects.toMatchObject({
      status: 400,
      code: 'idempotency_key_required',
    });
    expect(bucket.calls).toEqual([]);
    expect(assetCount()).toBe(0);
  });

  it('refuses a whitespace-only key, which is a missing one padded', async () => {
    await expect(upload(withKey('   '))).rejects.toMatchObject({
      status: 400,
      code: 'idempotency_key_required',
    });
  });

  it(`refuses a key longer than ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, async () => {
    await expect(upload(withKey('k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)))).rejects.toMatchObject({
      status: 400,
      code: 'idempotency_key_too_long',
    });
    // The bound itself, so a rewrite cannot quietly widen it.
    expect(MAX_IDEMPOTENCY_KEY_LENGTH).toBe(128);
    expect((await upload(withKey('k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)))).status).toBe(201);
  });

  it('RETRIES ARE NOT DUPLICATES: the same key twice is one row, one object, 200 second', async () => {
    // The default clock — no injected identity anywhere. This is the case the endpoint
    // used to get wrong: a retried 10 MiB upload wrote a second R2 object and a second
    // D1 row, and answered 201 for a creation that had already happened.
    const first = await upload(withKey('retry-key'));
    expect(first.status).toBe(201);
    const created = (await first.json()) as { asset: { id: string; r2Key: string } };

    const second = await upload(withKey('retry-key'));

    expect(second.status).toBe(200);
    const replayed = (await second.json()) as { asset: { id: string; r2Key: string }; outcome: string };
    expect(replayed.outcome).toBe('replayed');
    expect(replayed.asset).toEqual(created.asset);
    expect(assetCount()).toBe(1);
    // One put, and no second one: the replay is decided before the body is read.
    expect(bucket.calls).toEqual([`put:${created.asset.r2Key}`]);
    expect(bucket.objects.size).toBe(1);
  });

  it('answers a retry without reading the body at all', async () => {
    await upload(withKey('cheap-retry'));
    bucket.calls.length = 0;

    // A body that would blow the bound if it were read. The reply is 200, so the
    // decision was taken from the headers and one row lookup.
    const { stream, state } = countingStream(32 * 1024 * 1024);
    const req = request({ contentType: 'multipart/form-data; boundary=x', body: stream, key: 'cheap-retry' });
    const response = await upload(req);

    expect(response.status).toBe(200);
    // Nothing in this module touched the body. The one chunk `state.pulled` may show is
    // undici's own read-ahead at construction time, which is why `bodyUsed` — not the
    // counter — is the assertion that the parser was never invoked.
    expect(req.bodyUsed).toBe(false);
    expect(state.pulled).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(bucket.calls).toEqual([]);
    expect(assetCount()).toBe(1);
  });

  it('two different keys are two different assets', async () => {
    expect((await upload(withKey('key-one'))).status).toBe(201);
    expect((await upload(withKey('key-two'))).status).toBe(201);

    expect(assetCount()).toBe(2);
    expect(bucket.objects.size).toBe(2);
  });

  it('scopes the identity to the project, so one key in two projects is two assets', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    await repo.createProject({ id: other, name: 'Second Instrument', now: NOW });

    expect(await deriveImageAssetId(PROJECT_ID, 'shared-key')).not.toBe(
      await deriveImageAssetId(other, 'shared-key'),
    );

    expect((await upload(withKey('shared-key'))).status).toBe(201);
    expect((await upload(withKey('shared-key'), other)).status).toBe(201);
    expect(assetCount()).toBe(2);
  });

  it('derives the id rather than accepting it: the key never appears in the key path', async () => {
    const response = await upload(withKey('a-key-that-would-be-a-terrible-object-path/../..'));
    const { asset } = (await response.json()) as { asset: { id: string; r2Key: string } };

    expect(response.status).toBe(201);
    expect(asset.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(asset.r2Key).toBe(`twi/${PROJECT_ID}/assets/${asset.id}/source.jpg`);
    expect(asset.r2Key).not.toContain('..');
  });

  it('the identity preimage is UNAMBIGUOUS: a separator inside one field cannot be shifted into the other', async () => {
    // The two inputs that collided at base. `DOMAIN\n{projectId}\n{key}` hashed the same
    // string for both, and both derived d06e617a-b115-86df-a075-fd8b340ab9b8 — proof that
    // "the value is scoped to the project" rested on `projectId` being LF-free, which
    // nothing inside the derivation required. Length-prefixing the fields is what makes
    // the claim intrinsic instead of borrowed from the three guards at the call site.
    expect(await deriveImageAssetId(`${PROJECT_ID}\nEXTRA`, 'key')).not.toBe(
      await deriveImageAssetId(PROJECT_ID, 'EXTRA\nkey'),
    );

    // And the collided pair is not special. Each of these decomposes to a different
    // (projectId, key), including the two that would collide under a length prefix with no
    // terminator, so every digest must differ.
    const pairs: Array<[string, string]> = [
      [`${PROJECT_ID}\nEXTRA`, 'key'],
      [PROJECT_ID, 'EXTRA\nkey'],
      [`${PROJECT_ID}\n`, 'EXTRA\nkey'],
      [`${PROJECT_ID}\nEXTRA\nkey`, ''],
      ['1', '2:x'],
      ['12', ':x'],
      ['1:1', 'x'],
    ];
    const ids = await Promise.all(pairs.map(([projectId, key]) => deriveImageAssetId(projectId, key)));

    expect(new Set(ids).size).toBe(pairs.length);
  });

  it('the derivation is stable and is a pure function of the two inputs', async () => {
    const once = await deriveImageAssetId(PROJECT_ID, 'stable');
    const twice = await deriveImageAssetId(PROJECT_ID, 'stable');

    expect(once).toBe(twice);
    expect(once).not.toBe(await deriveImageAssetId(PROJECT_ID, 'stable '));
  });

  // ── The race the lookup cannot see ─────────────────────────────────────────

  it('answers 409 — and does NOT delete the winner’s object — when the identity is taken', async () => {
    // A double, and it has to be: a row appearing BETWEEN the lookup and the insert is a
    // concurrent writer, which a single-threaded test cannot produce. What is asserted
    // is the consequence — the object under this key belongs to that row, so deleting
    // it would leave a live asset pointing at nothing.
    const raced = {
      ...repo,
      findAssetById: async () => null,
      getProject: repo.getProject.bind(repo),
      registerAsset: async () => {
        throw new TwiRepositoryCollisionError('asset idempotency collision on id', {});
      },
    } as unknown as D1TwiRepository;

    await expect(
      uploadImageReference(withKey('contended'), PROJECT_ID, { bucket, repo: raced }),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_key_in_flight' });

    expect(bucket.calls.filter((call) => call.startsWith('delete:'))).toEqual([]);
  });

  it('still compensates for a NON-collision insert failure', async () => {
    // The rule is narrow on purpose: only a collision means the object is someone
    // else's. Every other failure still leaves an orphan that this call must clean up.
    const failing = {
      ...repo,
      findAssetById: async () => null,
      getProject: repo.getProject.bind(repo),
      registerAsset: async () => {
        throw new Error('D1_ERROR: no such table');
      },
    } as unknown as D1TwiRepository;

    await expect(
      uploadImageReference(withKey('doomed'), PROJECT_ID, { bucket, repo: failing }),
    ).rejects.toThrow('D1_ERROR: no such table');

    expect(bucket.calls.filter((call) => call.startsWith('delete:'))).toHaveLength(1);
    expect(bucket.objects.size).toBe(0);
  });

  // ── TWO WRITERS AT ONCE, which every test above is structurally blind to ───
  //
  // Everything before this point is single-writer, and that is precisely why the suite
  // could not see either defect below: both are consequences of the object key being
  // SHARED between concurrent requests for one (projectId, Idempotency-Key). These two
  // start both requests before either finishes — `Promise.all` over one real repository
  // and one real SQLite — so both lookups really do miss, rather than being told to.

  const raceRequests = (key: string, first: number[], second: number[]): [Request, Request] => [
    withKey(key, jpegForm(first)),
    withKey(key, jpegForm(second)),
  ];

  /**
   * Holds every arriving caller until `parties` of them have arrived, then lets them all go.
   *
   * Two requests started together do overlap, but WHERE they overlap is decided by how
   * many ticks each spends in `formData()` and the digest — and that varies with load,
   * which is how a first draft of these tests passed alone and failed inside the full run.
   * Pinning the interleaving is not staging the defect: the race needs both requests past
   * the replay lookup before either insert, so the barrier makes the real condition
   * reproducible instead of hoping the scheduler supplies it. It opens permanently, so the
   * compensation's own later lookup passes straight through.
   */
  const barrier = (parties: number) => {
    let arrived = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived >= parties) open();
      await gate;
    };
  };

  /** The real lookup, delayed until every racing request has also missed. */
  const lookupBehindBarrier = (gate: () => Promise<void>) => async (assetId: string) => {
    const row = await repo.findAssetById(assetId);
    await gate();
    return row;
  };

  it('a racing loser does NOT delete the winner’s committed object', async () => {
    // The bucket here is the PERMISSIVE recorder, on purpose: it ignores `onlyIf`, so it
    // models a store that does not honour preconditions and this test measures the delete
    // guard ALONE. The one injected fault is the one no test can produce otherwise — a D1
    // transient on the second insert. Measured at base, without the guard: the winner's
    // object was deleted by the loser and the committed row pointed at absent bytes.
    let inserts = 0;
    const bothPastTheLookup = barrier(2);
    const flaky = {
      ...repo,
      getProject: repo.getProject.bind(repo),
      findAssetById: lookupBehindBarrier(bothPastTheLookup),
      registerAsset: async (input: Parameters<D1TwiRepository['registerAsset']>[0]) => {
        inserts += 1;
        if (inserts === 2) throw new Error('D1_ERROR: network');
        return repo.registerAsset(input);
      },
    } as unknown as D1TwiRepository;

    const [first, second] = raceRequests('raced', [1, 1, 1, 1], [2, 2, 2, 2]);
    const settled = await Promise.allSettled([
      uploadImageReference(first, PROJECT_ID, { bucket, repo: flaky }),
      uploadImageReference(second, PROJECT_ID, { bucket, repo: flaky }),
    ]);

    // Which request wins is the scheduler's business, so nothing here depends on it.
    // Both really reached the insert with the same identity — otherwise this test would
    // be asserting something else entirely.
    expect(inserts).toBe(2);
    const winners = settled.filter((result) => result.status === 'fulfilled');
    const losers = settled.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect((winners[0] as PromiseFulfilledResult<Response>).value.status).toBe(201);
    expect(String((losers[0] as PromiseRejectedResult).reason)).toContain('D1_ERROR: network');

    const committed = await repo.findAssetById(await deriveImageAssetId(PROJECT_ID, 'raced'));
    expect(assetCount()).toBe(1);
    expect(committed).not.toBeNull();
    // The whole finding, in one line: the row's bytes are still there.
    expect(bucket.objects.has(committed?.r2Key ?? '')).toBe(true);
    expect(bucket.calls.filter((call) => call.startsWith('delete:'))).toEqual([]);
  });

  it('keeps the object when the owner lookup itself fails, rather than guessing', async () => {
    // The third state the guard has to answer for: not "mine" and not "someone else's"
    // but UNKNOWN. Deleting on a failed lookup would put the guess back exactly where the
    // finding was — so the object stays, at the price of storage, and the caller still
    // gets the original diagnosis rather than the lookup's.
    let lookups = 0;
    const blind = {
      ...repo,
      getProject: repo.getProject.bind(repo),
      findAssetById: async () => {
        lookups += 1;
        // The first call is the replay lookup and really does miss; the second is the
        // compensation asking who owns the object.
        if (lookups === 1) return null;
        throw new Error('D1_ERROR: lookup failed');
      },
      registerAsset: async () => {
        throw new Error('D1_ERROR: no such table');
      },
    } as unknown as D1TwiRepository;

    await expect(uploadImageReference(withKey('blind'), PROJECT_ID, { bucket, repo: blind })).rejects.toThrow(
      'D1_ERROR: no such table',
    );

    expect(lookups).toBe(2);
    expect(bucket.calls.filter((call) => call.startsWith('delete:'))).toEqual([]);
    expect(bucket.objects.size).toBe(1);
  });

  it('a racing loser cannot overwrite the winner’s bytes, so the row’s sha256 and bytes stay true', async () => {
    // Same race, different consequence and a different instrument: two payloads of the
    // SAME format (so the derived extension, and therefore the key, are identical) with
    // different content and different lengths. Measured at base: the surviving row kept
    // the winner's `bytes` 8 and `sha256` 9720c604… while the object held the loser's 10
    // bytes hashing to df5aa251… — a provenance record describing bytes that were not
    // there, in the subsystem whose entire purpose is provenance.
    const conditional = new ConditionalBucket();
    const bothPastTheLookup = barrier(2);
    const raced = {
      ...repo,
      getProject: repo.getProject.bind(repo),
      findAssetById: lookupBehindBarrier(bothPastTheLookup),
      registerAsset: repo.registerAsset.bind(repo),
    } as unknown as D1TwiRepository;
    const [first, second] = raceRequests('shared', [0x11, 0x22, 0x33, 0x44], [0x55, 0x66, 0x77, 0x88, 0x99, 0xaa]);
    const settled = await Promise.allSettled([
      uploadImageReference(first, PROJECT_ID, { bucket: conditional, repo: raced }),
      uploadImageReference(second, PROJECT_ID, { bucket: conditional, repo: raced }),
    ]);

    const winners = settled.filter((result) => result.status === 'fulfilled');
    const losers = settled.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect((winners[0] as PromiseFulfilledResult<Response>).value.status).toBe(201);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: 'idempotency_key_in_flight',
    });

    const committed = await repo.findAssetById(await deriveImageAssetId(PROJECT_ID, 'shared'));
    expect(assetCount()).toBe(1);
    const stored = conditional.objects.get(committed?.r2Key ?? '');
    expect(stored).toBeDefined();
    // The row describes the object it names — both fields, not just the length.
    expect(stored?.byteLength).toBe(committed?.bytes);
    expect(await sha256Of(stored ?? new Uint8Array(0))).toBe(committed?.sha256);
    // A refused put is not an orphan, so nothing may be deleted either.
    expect(conditional.calls.filter((call) => call.startsWith('delete:'))).toEqual([]);
    expect(conditional.calls).toContain(`put-refused:${committed?.r2Key}`);
  });

  it('never commits a row for bytes it did not store: an object already under the key is refused, not overwritten', async () => {
    // The single-writer face of the same rule, and the one that makes the rule testable
    // without a race: an object under this identity's key with no row naming it — what an
    // earlier attempt leaves behind when its insert failed AND its compensating delete
    // also failed. Ignoring the refused put would commit a row whose `sha256` describes
    // the bytes THIS call sent while the stored object holds the earlier ones, which is
    // the same false provenance the race produces. The honest answer is 409: the key is
    // occupied, and this endpoint will not write a record it cannot back.
    const conditional = new ConditionalBucket();
    const assetId = await deriveImageAssetId(PROJECT_ID, 'orphan-key');
    const key = `twi/${PROJECT_ID}/assets/${assetId}/source.jpg`;
    const earlier = new Uint8Array([...JPEG_MAGIC, 9, 9, 9]);
    conditional.objects.set(key, earlier);

    await expect(
      uploadImageReference(withKey('orphan-key', jpegForm([1, 2, 3])), PROJECT_ID, { bucket: conditional, repo }),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_key_in_flight' });

    expect(assetCount()).toBe(0);
    expect(conditional.calls).toEqual([`put-refused:${key}`]);
    expect([...(conditional.objects.get(key) ?? [])]).toEqual([...earlier]);
  });

  // ── The degenerate sizes no test drove before ──────────────────────────────

  const degenerate: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['fractional', 12.5],
  ];

  it.each(degenerate)('refuses a %s size without reading a byte', async (_label, size) => {
    // The guard that makes trusting `size` safe. Deleting it is partly self-healing —
    // the post-read length comparison catches some of it — which is exactly why it
    // needs its own test: the surviving behaviour would be the wrong code, or a read
    // this file's instrument refuses to serve.
    const lying: UploadedFileLike = {
      name: 'liar.jpg',
      type: 'image/jpeg',
      size,
      slice: () => {
        throw new Error('materialised the upload');
      },
      arrayBuffer: () => {
        throw new Error('materialised the upload');
      },
    };

    await expect(validateImageReference(lying)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_upload',
    });
    await expect(
      createImageAsset({ projectId: PROJECT_ID, file: lying, assetId: 'a-1' }, { bucket, repo }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_upload' });
    expect(bucket.calls).toEqual([]);
  });

  it('the payload cap is still the verdict on the file itself', async () => {
    // Bound 2 admits a body up to the envelope allowance; bound 3 is what refuses a
    // file that is too big to store. Both exist, and this pins that the second still
    // fires for a file whose envelope fit.
    expect(MAX_MULTIPART_BODY_BYTES).toBeGreaterThan(MAX_IMAGE_REFERENCE_BYTES);

    const oversize = new File([new Uint8Array(MAX_IMAGE_REFERENCE_BYTES + 1)], 'huge.jpg', {
      type: 'image/jpeg',
    });
    const form = new FormData();
    form.set('file', oversize);

    await expect(upload(withKey('oversize', form))).rejects.toMatchObject({ status: 413 });
    expect(bucket.calls).toEqual([]);
    expect(assetCount()).toBe(0);
  });
});
