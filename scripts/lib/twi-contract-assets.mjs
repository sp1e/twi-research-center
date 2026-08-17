/**
 * twi-contract-assets.mjs — section 12 of the TWI contract check: image-reference ingestion
 * (Task 6), including the two ORDER assertions that a unit test cannot make cheaply.
 *
 * Extracted verbatim from scripts/twi-contract-check.mjs. The `canonicalStatements` /
 * `assetFunction` / `precedes` helpers travel WITH these checks and are not shared: the order
 * assertions are per-FUNCTION, read off a comment-free canonical rendering of one named
 * function of src/twi/server/assets.ts, and `precedes` fails closed when either anchor is
 * absent. Splitting one of those functions across files would empty its rendering and the
 * assertion would go red — which is the point, and why nothing here may be generalised.
 */

import { canonicalStatement, parseTypeScript } from './ts-ast.mjs';

/** Section 12. */
export const checkAssetIngestion = (context, check) => {
  const { route, assets, env, wrangler, gateIndex } = context;

  /**
   * ── 12. IMAGE-REFERENCE INGESTION (Task 6) ───────────────────────────────────
   *
   * Two of the facts below are ORDERS, not values, and that is why they are here
   * rather than only in `src/twi/server/assets.test.ts`. A unit test can prove that a
   * 10 MiB + 1 upload is refused; it cannot prove the refusal is CHEAP unless it also
   * owns an instrument that witnesses the read (that suite does, with a file that
   * throws on access). This section pins the same orders in the source, so a later
   * edit that moves the cap below the read fails by name:
   *
   *   - the size cap precedes the byte read inside `validateImageReference`;
   *   - the declared-length refusal precedes `request.formData()` inside
   *     `uploadImageReference`.
   *
   * A cap that fires after the expensive work is not a guard, it is a CPU and memory
   * amplifier — this project has already fixed that shape twice (`RAW_LENGTH_SLACK`
   * and `RAW_ENTRY_SLACK` in src/twi/domain/schemas.ts, both of which bound raw input
   * before zod walks it).
   *
   * The order checks read a COMMENT-FREE canonical rendering of each function, printed
   * from the AST, for the reason section 9 records for _redirects: a check a comment can
   * flip is not a check. The prose above mentions `formData` and the cap in the opposite
   * order to the code, which under a substring scan of the raw file would be enough to
   * invert both.
   */
  const canonicalStatements = (source, fileName) => {
    if (source.length === 0) return [];
    const sf = parseTypeScript(source, fileName);
    return sf.statements.map((statement) => canonicalStatement(sf, statement));
  };

  const assetStatements = canonicalStatements(assets, 'assets.ts');
  const assetsCanonical = assetStatements.join('\n');
  const assetFunction = (name) =>
    assetStatements.find((text) => new RegExp(`^export (?:async )?function ${name}\\b`).test(text)) ?? '';

  /** Is `first` present and does it come before `second` in `text`? Fails closed if either is absent. */
  const precedes = (text, first, second) => {
    const at = text.indexOf(first);
    const then = text.indexOf(second);
    return at !== -1 && then !== -1 && at < then;
  };

  check(
    'the asset upload route is POST /projects/:id/assets and sits BELOW the owner gate',
    (() => {
      const uploadIndex = route.indexOf("sub === 'assets'");
      return (
        uploadIndex > gateIndex &&
        /if \(resource === 'projects' && id && sub === 'assets' && segments\.length === 3 && method === 'POST'\)/.test(route)
      );
    })(),
  );

  check(
    'the upload is dispatched to src/twi/server/assets, so the route file stays a route table',
    /import \{ uploadImageReference \} from '\.\.\/\.\.\/\.\.\/src\/twi\/server\/assets'/.test(route) &&
      /return await uploadImageReference\(request, id, \{ bucket: env\.FILES, repo \}\)/.test(route) &&
      // The chain's middle link: without it a handler that reached bucket.put itself kept all 52 green.
      /createImageAsset\(/.test(assetFunction('uploadImageReference')),
  );

  check(
    'an image reference is identified by its BYTES: a magic-byte table, not a filename or a declared type',
    /export async function validateImageReference/.test(assets) &&
      /0x89, 0x50, 0x4e, 0x47/.test(assetsCanonical) &&
      /0xff, 0xd8, 0xff/.test(assetsCanonical) &&
      /0x52, 0x49, 0x46, 0x46/.test(assetsCanonical) &&
      /0x57, 0x45, 0x42, 0x50/.test(assetsCanonical) &&
      /contentType: signature\.contentType/.test(assetsCanonical) &&
      /await validateImageReference\(input\.file\)/.test(assetsCanonical),
  );

  check(
    'image reference uploads are capped at 10 * 1024 * 1024 bytes',
    /export const MAX_IMAGE_REFERENCE_BYTES = 10 \* 1024 \* 1024/.test(assets),
  );

  check(
    'the size cap is applied BEFORE any byte of the upload is read',
    precedes(assetFunction('validateImageReference'), 'size > MAX_IMAGE_REFERENCE_BYTES', 'arrayBuffer()'),
  );

  check(
    'the format probe reads at most MAGIC_BYTE_PROBE_BYTES, never the whole file',
    /export const MAGIC_BYTE_PROBE_BYTES = 16/.test(assets) &&
      /file\.slice\(0, MAGIC_BYTE_PROBE_BYTES\)/.test(assetsCanonical) &&
      !/await file\.arrayBuffer\(\)/.test(assetFunction('validateImageReference')),
  );

  check(
    'the upload route refuses an oversize declared body BEFORE parsing the multipart form',
    precedes(assetFunction('uploadImageReference'), 'MAX_MULTIPART_BODY_BYTES', 'request.formData()') &&
      /export const MAX_MULTIPART_BODY_BYTES = MAX_IMAGE_REFERENCE_BYTES \+ MULTIPART_ENVELOPE_SLACK_BYTES/.test(assets),
  );

  check(
    'image reference objects are written under the twi/ R2 prefix, namespaced by project and asset',
    /export const R2_TWI_PREFIX = 'twi\/'/.test(assets) &&
      /\$\{R2_TWI_PREFIX\}\$\{projectId\}\/assets\/\$\{assetId\}\/source\.\$\{extension\}/.test(assets),
  );

  check(
    'the R2 object is written first, the row second, and the object is DELETED if the row is refused',
    (() => {
      const create = assetFunction('createImageAsset');
      return (
        precedes(create, 'bucket.put(', 'repo.registerAsset(') &&
        precedes(create, 'repo.registerAsset(', 'bucket.delete(') &&
        precedes(create, 'bucket.delete(', 'throw error')
      );
    })(),
  );

  check(
    "registerAsset's outcome is read, so a replay is never reported as a fresh creation",
    /const \{ asset, outcome \} = await repo\.registerAsset\(/.test(assetsCanonical) &&
      /outcome === 'inserted' \? 201 : 200/.test(assetsCanonical),
  );

  /**
   * The binding must not travel. `env.FILES` is passed to the handler as an argument
   * and appears nowhere else; the ingestion module never names it at all, so there is
   * nothing there to serialise. Checked against the comment-free rendering, because
   * this file's own prose names the binding several times.
   */
  check(
    'the asset API returns no binding, bucket name or credential — FILES is an argument, never a payload',
    !/\bFILES\b/.test(assetsCanonical) &&
      (route.match(/env\.FILES/g) ?? []).length === 1 &&
      !/sp1e-files/.test(assets + route) &&
      !/accessKeyId|secretAccessKey|cloudflarestorage|R2_ACCESS/.test(assets + route),
  );

  check(
    'TwiEnv declares the EXISTING FILES bucket wrangler.toml defines, rather than inventing one',
    /FILES: R2BucketLike/.test(env) &&
      /^\s*binding\s*=\s*"FILES"\s*$/m.test(wrangler) &&
      /^\s*bucket_name\s*=\s*"sp1e-files"\s*$/m.test(wrangler),
  );

  check(
    'the ten-references-per-specification limit IS the capability catalog number, not a second copy',
    /export const MAX_IMAGE_REFERENCES_PER_SPEC = creationCoreCapabilities\.maxImageReferences/.test(assets) &&
      /export function assertImageReferenceSelection/.test(assets),
  );

  /**
   * Both halves read the comment-free rendering, and the negative half has to.
   * `assets.ts` explains in prose WHY `datetime('now')` is refused — SQLite emits no
   * milliseconds and a space separator, which `twi_assets_created_at_iso` rejects — and
   * a substring scan of the raw file counts that explanation as the offence. This check
   * failed exactly that way on first run.
   */
  check(
    'asset rows carry a JS-generated ISO timestamp, never SQL’s clock',
    /createdAt: clock\.now\(\)/.test(assetsCanonical) && !/datetime\('now'\)/.test(assetsCanonical),
  );
};
