/**
 * twi-contract-jobs.mjs — section 13 of the TWI contract check: the CREATION JOB API,
 * which is the only part of this surface that spends the owner's money.
 *
 * Why these facts are here rather than only in `src/twi/server/jobs.test.ts`. Three
 * classes of thing live in this file and a unit test can prove none of them cheaply:
 *
 *   1. ORDERS. A replay lookup that runs AFTER the insert still answers correctly on a
 *      single request and has already charged twice under concurrency. A dispatch that
 *      runs BEFORE the estimate cost row is written starts a render nobody can account
 *      for. Both are positions in one function, read here off a comment-free canonical
 *      AST rendering — the same instrument section 12 uses for the upload's byte bounds
 *      and for the same reason: a check a comment can flip is not a check, and this
 *      file's own prose names these calls in the opposite order to the code.
 *   2. ABSENCES. `spec_sha256` must not be hashed in the use case; no timestamp may come
 *      from SQL; the specification's text must not cross the service binding; and
 *      `deriveImageAssetId` must not gain a second caller. An absence has no runtime
 *      behaviour to assert, so a passing suite says nothing about it.
 *   3. THE DEPLOY GRAPH, TRANSITIVELY. Section 6 asserts that an ENUMERATED list of
 *      eight files imports no npm package. Task 7 is the first task whose graph reaches
 *      one — `src/twi/domain/schemas.ts` imports `zod`, and the brief mandates
 *      `submitJobSchema.parse` — so the honest move is to walk the graph from the route
 *      file and bound what is in it, rather than leave a fact the enumerated list cannot
 *      see. Section 6 is unchanged and still holds; this is a stronger claim beside it.
 *
 * Order of registration is part of the contract: the guard prints checks in the order
 * they are pushed and the mutant manifest cites them by name. This module is called
 * last, after section 12.
 */

import ts from 'typescript';

import { canonicalStatement, parseTypeScript } from './ts-ast.mjs';

/** The one module the Pages Function is entered through. The graph walk starts here. */
const ROUTE_ENTRY = 'functions/api/twi/[[route]].ts';

/**
 * The only npm package the TWI function graph may reach, and why.
 *
 * `src/twi/domain/schemas.ts` is the single validator for a creation specification —
 * caps, `.strict()`, the `instrumental` rejection, the lyrics fence and the branded
 * `NormalizedGenerationSpec` the prompt compiler will not accept a substitute for. Task
 * 7's brief mandates parsing through it, so `zod` enters the graph. Re-implementing
 * those rules server-side would mean a SECOND validator that can silently disagree with
 * the one the wizard runs, which is a worse defect than this dependency.
 *
 * It is bounded rather than blessed: nothing else may appear, and `zod` must be a
 * RUNTIME dependency so a deploy has something to resolve. Whether Cloudflare Pages
 * resolves it at all is a deploy-time fact this repo cannot settle — the same class as
 * the four in docs/superpowers/HANDOVER.md §8, and settled by the same preview deploy.
 */
const ADMITTED_PACKAGES = ['zod'];

/**
 * Every module the route file reaches at RUNTIME, and every npm specifier among them.
 *
 * Type-only edges are skipped because they are erased before anything is bundled: an
 * `import type` cannot fail at deploy. A named-import clause whose every element is
 * `type` is treated the same way, since that is the same erasure spelled differently.
 * Re-exports (`export { X } from './y'`) ARE followed — they carry values.
 */
const runtimeSpecifiers = (sf) => {
  const out = [];
  for (const statement of sf.statements) {
    const isImport = ts.isImportDeclaration(statement);
    const isReexport = ts.isExportDeclaration(statement) && Boolean(statement.moduleSpecifier);
    if (!isImport && !isReexport) continue;
    if (statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    if (isImport) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      if (
        clause &&
        !clause.name &&
        named &&
        ts.isNamedImports(named) &&
        named.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
    }
    out.push(specifier.text);
  }
  return out;
};

const walkFunctionGraph = (read) => {
  const visited = new Set();
  const packages = new Map();
  const missing = [];

  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = read(file);
    if (source.length === 0) {
      missing.push(file);
      return;
    }
    const sf = parseTypeScript(source, file);
    for (const specifier of runtimeSpecifiers(sf)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        packages.set(specifier, [...(packages.get(specifier) ?? []), file]);
        continue;
      }
      const segments = file.split('/').slice(0, -1).concat(specifier.split('/'));
      const resolved = [];
      for (const segment of segments) {
        if (segment === '.' || segment === '') continue;
        if (segment === '..') resolved.pop();
        else resolved.push(segment);
      }
      const joined = resolved.join('/');
      visit(joined.endsWith('.ts') ? joined : `${joined}.ts`);
    }
  };

  visit(ROUTE_ENTRY);
  return { files: [...visited], packages, missing };
};

/** Section 13. */
export const checkJobApi = (context, check) => {
  const { read, route, gateIndex, packageJson } = context;

  /**
   * THE JOB USE CASE IS TWO FILES, AND THIS SECTION READS BOTH AS ONE CORPUS.
   *
   * `cancelJob` and `retryJob` moved to `src/twi/server/jobs-cancel-retry.ts` (gate 2's M7)
   * once `jobs.ts` reached 595 lines. Everything below is written against the job use case
   * as a whole rather than against a filename, because two different shapes of assertion
   * live here and they fail in opposite directions when the corpus shrinks:
   *
   *   - An ORDER assertion (`precedes(jobFunction('cancelJob'), …)`) fails CLOSED. If the
   *     function is in neither file `jobFunction` answers `''`, `precedes` is false on it,
   *     and the check fails naming the function. That property is why the split was judged
   *     safe, and widening the search to both files preserves it exactly.
   *   - An ABSENCE assertion (`!/createHash/`, `!/'now'/`, `!/transitionJob\(…'complete'/`)
   *     passes VACUOUSLY on an empty corpus. Reading only `jobs.ts` after the move would
   *     quietly stop covering the relocated code; reading a file that has been renamed or
   *     deleted would stop covering anything at all while still printing OK. So both files
   *     are concatenated, and `missingJobModules` below refuses an absent one BY NAME.
   *
   * That is the enumerated-versus-walked lesson from section 6 applied here: a check whose
   * corpus can silently shrink is not a check.
   */
  const JOB_USE_CASE_FILES = [
    'src/twi/server/jobs.ts',
    'src/twi/server/jobs-cancel-retry.ts',
    // The reconciliation route. A third module for the reason the second one exists: it acts
    // on a job whose money is already spent and may never create a job, a specification or a
    // cost row. Listed here so every absence scan below reads it too — a corpus that does not
    // grow with the code is the enumerated-versus-walked defect this file was written about.
    'src/twi/server/jobs-provider-calls.ts',
  ];

  const jobSources = JOB_USE_CASE_FILES.map((file) => [file, read(file)]);
  const missingJobModules = jobSources.filter(([, source]) => source.trim().length === 0).map(([file]) => file);

  /** `jobs.ts` alone, for the few claims that are ABOUT that file (its imports, its exported constants). */
  const jobs = read('src/twi/server/jobs.ts');
  /** Both files, raw. Every ABSENCE scan over unparsed text reads this, never `jobs` alone. */
  const jobsRaw = jobSources.map(([, source]) => source).join('\n');
  const estimates = read('src/twi/server/estimates.ts');
  const references = read('src/twi/server/job-references.ts');

  const canonicalStatements = (source, fileName) => {
    if (source.length === 0) return [];
    const sf = parseTypeScript(source, fileName);
    return sf.statements.map((statement) => canonicalStatement(sf, statement));
  };

  const jobStatements = jobSources.flatMap(([file, source]) => canonicalStatements(source, file));
  const jobsCanonical = jobStatements.join('\n');
  const estimatesCanonical = canonicalStatements(estimates, 'estimates.ts').join('\n');
  const referencesCanonical = canonicalStatements(references, 'job-references.ts').join('\n');

  check(
    `the job use case is exactly ${JOB_USE_CASE_FILES.length} modules and section 13 reads every one, so no absence assertion here can pass over a corpus that shrank${
      missingJobModules.length ? ` — MISSING: ${missingJobModules.join(', ')}` : ` (${JOB_USE_CASE_FILES.join(', ')})`
    }`,
    missingJobModules.length === 0,
  );

  /**
   * One named top-level declaration, rendered comment-free, from EITHER module of the job
   * use case. Matches both spellings the code uses — `export async function submitJob` and
   * `const dispatch = …` — so moving a helper between the two forms, or between the two
   * FILES, does not silently empty an order assertion. Returns `''` on a miss, which is
   * what makes every consumer below fail closed.
   */
  const jobFunction = (name) =>
    jobStatements.find(
      (text) =>
        new RegExp(`^export (?:async )?function ${name}\\b`).test(text) ||
        new RegExp(`^(?:export )?const ${name}\\b`).test(text),
    ) ?? '';

  /** Is `first` present and does it come before `second`? Fails closed if either is absent. */
  const precedes = (text, first, second) => {
    const at = text.indexOf(first);
    const then = text.indexOf(second, at === -1 ? 0 : at);
    return at !== -1 && then !== -1 && at < then;
  };

  // ── 13a. The six routes, all below the gate and all dispatched out of the table ──

  const JOB_ROUTES = [
    ["resource === 'jobs' && id === 'estimate' && !sub && method === 'POST'", 'estimateJob(request, jobs)'],
    ["resource === 'jobs' && !id && method === 'POST'", 'submitJob(request, jobs)'],
    ["resource === 'jobs' && !id && method === 'GET'", 'listJobs(request, repo)'],
    ["resource === 'jobs' && id && !sub && method === 'GET'", 'getJob(id, repo)'],
    ["resource === 'jobs' && id && sub === 'cancel' && segments.length === 3 && method === 'POST'", 'cancelJob(id, jobs)'],
    ["resource === 'jobs' && id && sub === 'retry' && segments.length === 3 && method === 'POST'", 'retryJob(id, jobs)'],
    [
      "resource === 'jobs' && id && sub === 'provider-calls' && segments.length === 3 && method === 'GET'",
      'listProviderCallsRoute(id, jobs)',
    ],
    [
      "resource === 'jobs' && id && sub === 'resolve-provider-call' && segments.length === 3 && method === 'POST'",
      'resolveProviderCallRoute(id, request, jobs)',
    ],
  ];

  const routeOffenders = JOB_ROUTES.flatMap(([condition, call]) => {
    const at = route.indexOf(condition);
    if (at === -1) return [`missing branch: ${condition}`];
    if (at < gateIndex) return [`PUBLIC — above the owner gate: ${condition}`];
    if (!route.includes(`return await ${call}`)) return [`not \`return await\`ed to src/twi/server/jobs: ${call}`];
    return [];
  });

  check(
    `all ${JOB_ROUTES.length} job routes sit BELOW the owner gate and are awaited handlers in src/twi/server/jobs${
      routeOffenders.length ? ` — ${routeOffenders.join(' | ')}` : ''
    }`,
    routeOffenders.length === 0,
  );

  /**
   * The import list, pinned EXACTLY, across both job modules.
   *
   * Two regexes rather than one because the six handlers now arrive from two files, and
   * each list is closed: a seventh name appearing on either line, or a handler moving to a
   * third module, fails here. The alternative — matching the names loosely wherever they
   * appear — would admit a handler imported from anywhere, which is the thing this check
   * exists to refuse. The route file is a route table; the use cases live in `src/twi/server`.
   */
  check(
    `the ${JOB_ROUTES.length} job handlers are imported from the ${JOB_USE_CASE_FILES.length} job use-case modules and nowhere else, so the route file stays a route table`,
    /import \{ estimateJob, getJob, listJobs, submitJob \} from '\.\.\/\.\.\/\.\.\/src\/twi\/server\/jobs'/.test(route) &&
      /import \{ cancelJob, retryJob \} from '\.\.\/\.\.\/\.\.\/src\/twi\/server\/jobs-cancel-retry'/.test(route) &&
      /import \{ listProviderCallsRoute, resolveProviderCallRoute \} from '\.\.\/\.\.\/\.\.\/src\/twi\/server\/jobs-provider-calls'/.test(route) &&
      (route.match(/from '\.\.\/\.\.\/\.\.\/src\/twi\/server\/jobs(?:-[a-z-]+)?'/g) ?? []).length ===
        JOB_USE_CASE_FILES.length,
  );

  /**
   * The service binding is an ARGUMENT and never a payload, exactly as `env.FILES` is.
   * `env.TWI_ORCHESTRATOR` appears once, in the object handed to the handlers, and the
   * use-case module never names the binding at all — so there is nothing there to
   * serialise into a response.
   */
  check(
    'the orchestrator binding is passed as an argument and never returned, named once in the route file',
    (route.match(/env\.TWI_ORCHESTRATOR/g) ?? []).length === 1 &&
      !/TWI_ORCHESTRATOR/.test(jobsCanonical) &&
      !/accessKeyId|secretAccessKey|Authorization/.test(jobsRaw),
  );

  // ── 13b. The fingerprint, which is the defect this project already paid for once ──

  /**
   * `spec_sha256` is DERIVED INSIDE THE REPOSITORY. The submit path takes it from the
   * exported `specSha256()` and hands that same value to `findJobByIdempotencyKey`.
   * Hashing it here would produce a digest that disagrees with the stored one, and the
   * lookup reads a mismatch as "a different request under a used key" — refusing a
   * caller's own replay and charging a SECOND paid submission. That was reproduced end
   * to end before it was fixed; this is the assertion that keeps it fixed.
   */
  check(
    'the spec fingerprint comes from specSha256() and is never hashed inside the job use case',
    /const fingerprint = await specSha256\(specJson\);/.test(jobsCanonical) &&
      /specSha256: fingerprint/.test(jobsCanonical) &&
      !/crypto\.subtle\.digest/.test(jobsRaw) &&
      !/createHash/.test(jobsRaw),
  );

  check(
    'the stored digest is compared against the fingerprint the replay lookup used',
    /saved\.specSha256 !== fingerprint/.test(jobsCanonical) && /spec_digest_mismatch/.test(jobs),
  );

  // ── 13c. Orders inside the submit path ──────────────────────────────────────────

  check(
    'the replay lookup runs BEFORE the spec and the job are written, so a retry cannot be a second charge',
    (() => {
      const submit = jobFunction('submitJob');
      return (
        precedes(submit, 'findReplayableJob(', 'saveSpec(') &&
        precedes(submit, 'saveSpec(', 'createEstimatedJob(')
      );
    })(),
  );

  check(
    'the estimate is written with the job, BEFORE the orchestrator is asked to start anything',
    (() => {
      const submit = jobFunction('submitJob');
      return (
        precedes(submit, 'createEstimatedJob(', 'dispatch(') &&
        /estimateJson: JSON\.stringify\(estimate\)/.test(submit) &&
        /estimateAmountUsd: estimate\.total/.test(submit) &&
        /costIdempotencyKey: costKey\(/.test(submit)
      );
    })(),
  );

  check(
    "estimated -> queued happens only AFTER the dispatch, never before it",
    (() => {
      const submit = jobFunction('submitJob');
      return precedes(submit, 'dispatch(', "transitionJob(job.id, 'queued'");
    })(),
  );

  /**
   * The outcome DECIDES, it is not decoration. `createEstimatedJob` reports whether this
   * call wrote the job, and a mutation that answered 201 unconditionally once left an
   * entire suite green because nothing drove a replay through the route.
   */
  check(
    "createEstimatedJob's outcome gates both the status code and the dispatch",
    /if \(outcome === 'replayed'\) return json\(\{ job, outcome, transition: null \}, 200\);/.test(jobsCanonical) &&
      (jobsCanonical.match(/, 201\)/g) ?? []).length === 1 &&
      precedes(jobFunction('submitJob'), "outcome === 'replayed'", 'dispatch('),
  );

  check(
    "retryJob refuses to dispatch unless its own retrying transition was applied",
    /if \(retrying\.outcome !== 'applied'\)/.test(jobsCanonical) &&
      precedes(jobFunction('retryJob'), "retrying.outcome !== 'applied'", 'dispatch('),
  );

  // ── 13d. Keys, ordinals and clocks ─────────────────────────────────────────────

  /**
   * `twi_job_events.event_key` is NOT NULL, UNIQUE and has no DEFAULT, and the key must
   * carry the ATTEMPT ORDINAL. `${jobId}:${to}` collides on the first retry loop and the
   * second write becomes a silent no-op REPLAY: the job reports retried and nothing
   * moved. Every `eventKey:` in this module therefore goes through the one helper.
   */
  check(
    'every job event key is minted by the one helper and carries the attempt ordinal',
    /const eventKey = \(jobId: string, attempt: number, to: JobStatus\): string => `\$\{jobId\}:\$\{attempt\}:\$\{to\}`/.test(
      jobsCanonical,
    ) &&
      (jobsCanonical.match(/eventKey: /g) ?? []).length ===
        (jobsCanonical.match(/eventKey: eventKey\(/g) ?? []).length &&
      /const attempt = \(await deps\.repo\.countJobEvents\(\{ jobId: job\.id, toStatus: 'retrying' \}\)\) \+ 1;/.test(
        jobsCanonical,
      ),
  );

  check(
    'the estimate cost row supplies its own idempotency key, which the schema requires',
    /const costKey = \(jobId: string, attempt: number\): string => `\$\{jobId\}:\$\{attempt\}:estimate`/.test(
      jobsCanonical,
    ),
  );

  /**
   * Both halves read the comment-free rendering, and the negative half has to: this
   * module explains in prose WHY SQLite's clock is refused, and a substring scan of the
   * raw file counts the explanation as the offence. Section 12 hit exactly that.
   */
  check(
    'every job timestamp is JS-generated through the injectable clock, never SQL’s',
    /clock\.now\(\)/.test(jobsCanonical) && !/datetime\('now'\)/.test(jobsCanonical) && !/'now'/.test(jobsCanonical),
  );

  check(
    'the job use case never asks transitionJob to write complete — only publishCandidates may',
    !/transitionJob\([^;]*'complete'/.test(jobsCanonical),
  );

  // ── 13e. Estimate before submission, actual cost after ─────────────────────────

  /**
   * The locked product rule: no hard budget cap, but every job shows an ESTIMATED cost
   * before submission and records the ACTUAL cost after. The estimate route is the
   * "before" half and it must write nothing at all — a quote that creates a job is a
   * confirmation gate that has already been passed.
   */
  check(
    'the estimate route quotes without writing: no spec, no job, no transition, no dispatch',
    (() => {
      const estimate = jobFunction('estimateJob');
      return (
        estimate.length > 0 &&
        !/saveSpec\(/.test(estimate) &&
        !/createEstimatedJob\(/.test(estimate) &&
        !/transitionJob\(/.test(estimate) &&
        !/dispatch\(/.test(estimate) &&
        /estimateView\(await policy\.estimate\(spec\), policy\.providerConfigured\)/.test(estimate)
      );
    })(),
  );

  check(
    'the estimate total is COMPUTED from its components rather than written as a literal',
    /total: provider \+ FINISHING_ESTIMATE_USD \+ STORAGE_ESTIMATE_USD/.test(estimatesCanonical) &&
      /export const FINISHING_ESTIMATE_USD = 0\.04/.test(estimates) &&
      /export const STORAGE_ESTIMATE_USD = 0\.01/.test(estimates),
  );

  /**
   * A zero provider component that says `estimated` means "free"; the same zero that
   * says `unavailable` means "not priced". The wizard has to be able to tell those apart
   * before the owner authorises a paid render, and the confirmation text has to say that
   * the actual provider cost is recorded regardless.
   *
   * The label is asserted to come from whether the rate was CONFIGURED, never from the
   * amount. That is strictly stronger than the previous form of this check, which pinned
   * `estimate.provider === 0 ? 'unavailable' : 'estimated'` — and pinned with it the defect
   * that a deployment setting `TWI_LYRIA_ESTIMATE_USD=0` was told the variable "is unset" in
   * owner-facing text on a money path. Both halves are named here so the amount cannot creep
   * back in as the source of the label.
   */
  check(
    'a zero provider component is labelled unavailable, and the confirmation promises the actual cost is recorded',
    /providerConfigured \? 'estimated' : 'unavailable'/.test(estimatesCanonical) &&
      !/estimate\.provider === 0 \?/.test(estimatesCanonical) &&
      /export const providerRateConfigured = \(raw: string \| null \| undefined\): boolean => typeof raw === 'string' && raw\.trim\(\)\.length > 0/.test(
        estimatesCanonical,
      ) &&
      /actual provider cost is measured after the render and recorded against this job/i.test(estimates) &&
      /export const PROVIDER_ESTIMATE_VARIABLE = 'TWI_LYRIA_ESTIMATE_USD'/.test(estimates),
  );

  check(
    'a misconfigured provider rate refuses the quote instead of quoting zero',
    /!Number\.isFinite\(parsed\) \|\| parsed < 0/.test(estimatesCanonical) &&
      /estimate_misconfigured/.test(estimates),
  );

  // ── 13f. Image references: the cap has a caller, and it runs first ─────────────

  /**
   * `assertImageReferenceSelection` shipped in Task 6 with NO production caller, so the
   * ten-per-specification cap silently did not exist. It is called on the RAW request
   * ahead of the schema parse — the only position in which it is reachable at all, since
   * `boundedArray(uuid, 10)` would otherwise refuse the eleventh entry first — and ahead
   * of every repository read, so an over-count costs no query.
   */
  check(
    'the ten-reference cap is called on the RAW request, before the parse and before any repository read',
    (() => {
      const submit = jobFunction('submitJob');
      const estimate = jobFunction('estimateJob');
      return (
        /import \{ MAX_IMAGE_REFERENCES_PER_SPEC, assertImageReferenceSelection \} from '\.\/assets'/.test(jobs) &&
        precedes(submit, 'assertImageReferenceSelection(rawImageReferences(body))', 'parseRequest(submitJobSchema') &&
        precedes(submit, 'assertImageReferenceSelection(rawImageReferences(body))', 'requireProject(') &&
        precedes(estimate, 'assertImageReferenceSelection(rawImageReferences(body))', 'parseRequest(estimateRequestSchema')
      );
    })(),
  );

  check(
    'the raw reference list is bounded before it is walked, so an over-count costs O(cap)',
    /imageAssetIds\.slice\(0, MAX_IMAGE_REFERENCES_PER_SPEC \+ 1\)/.test(jobsCanonical),
  );

  /**
   * The per-project reference count. Two counts rather than one because the two answers
   * are different verdicts the owner must be able to tell apart: an id that is not in
   * this project is a mistake, while an id that IS in this project but names audio is a
   * capability `creationCoreCapabilities` says the provider does not have.
   */
  check(
    'references are verified against the project by COUNT, and a non-image asset is a capability refusal',
    /countProjectAssets\(\{ projectId, assetIds: imageAssetIds, kind: null \}\)/.test(referencesCanonical) &&
      /countProjectAssets\(\{ projectId, assetIds: imageAssetIds, kind: 'image-reference' \}\)/.test(
        referencesCanonical,
      ) &&
      /unknown_image_reference/.test(references) &&
      /unsupported_capability/.test(references) &&
      /creationCoreCapabilities\.audioReference/.test(referencesCanonical),
  );

  check(
    'only ACTIVE assets of the project count as usable references',
    /lifecycle_state = 'active'/.test(read('src/twi/server/queries.ts')) &&
      /AND id IN \(\$\{placeholders\}\)/.test(read('src/twi/server/queries.ts')),
  );

  /**
   * THE HARD PROHIBITION, as an executed assertion rather than a comment in a report.
   *
   * `deriveImageAssetId` has a proven preimage ambiguity — `sha256(domain \n projectId \n
   * key)`, where two different field splits collide — which is latent only because it has
   * exactly ONE caller. A second caller would make a cross-project asset collision live.
   * Task 7 does not call or re-export it, and this is what keeps that true.
   */
  check(
    'no Task 7 module calls or re-exports deriveImageAssetId, whose preimage ambiguity is latent on ONE caller',
    !/deriveImageAssetId/.test(jobsRaw + estimates + references + route),
  );

  // ── 13g. What crosses the service binding ─────────────────────────────────────

  /**
   * An IDENTITY, not a payload. The Workflow loads the frozen spec from its own row, so
   * the lyrics the owner typed are not copied into a second place on every submission —
   * and the internal origin is a service binding, never a public URL.
   */
  check(
    'the Workflow start payload carries ids, the digest and the estimate — never the specification text',
    (() => {
      const payload = jobFunction('startPayload');
      return (
        /export const ORCHESTRATOR_ORIGIN = 'https:\/\/twi\.internal'/.test(jobs) &&
        payload.length > 0 &&
        !/specJson/.test(payload) &&
        !/lyrics/.test(payload) &&
        !/\bspec:/.test(payload) &&
        /specSha256: job\.specSha256/.test(payload)
      );
    })(),
  );

  check(
    'a dispatch failure lands the job in error with orchestrator_unavailable, and cancel does NOT claim a stop it never made',
    /errorCode: ORCHESTRATOR_UNAVAILABLE/.test(jobsCanonical) &&
      /export const ORCHESTRATOR_UNAVAILABLE = 'orchestrator_unavailable'/.test(jobs) &&
      precedes(jobFunction('cancelJob'), 'if (!stopped)', "transitionJob(job.id, 'cancelling'"),
  );

  // ── 13h. The deploy graph, walked rather than enumerated ──────────────────────

  const graph = walkFunctionGraph(read);
  const strayPackages = [...graph.packages.entries()]
    .filter(([specifier]) => !ADMITTED_PACKAGES.includes(specifier))
    .map(([specifier, importers]) => `${specifier} (from ${importers.join(', ')})`);
  const declared = (() => {
    try {
      return JSON.parse(packageJson).dependencies ?? {};
    } catch {
      return {};
    }
  })();
  const undeclared = [...graph.packages.keys()].filter((specifier) => !(specifier in declared));

  check(
    `the TWI Pages Function graph is walked, not enumerated: ${graph.files.length} modules, npm packages ${
      [...graph.packages.keys()].join(', ') || 'none'
    }${strayPackages.length ? ` — STRAY: ${strayPackages.join(' | ')}` : ''}${
      undeclared.length ? ` — NOT a runtime dependency: ${undeclared.join(', ')}` : ''
    }${graph.missing.length ? ` — UNRESOLVED: ${graph.missing.join(', ')}` : ''}`,
    graph.files.length > 8 &&
      graph.missing.length === 0 &&
      strayPackages.length === 0 &&
      undeclared.length === 0,
  );

  /**
   * Every package in the FUNCTION graph is pinned EXACTLY — no `^`, no `~`, no range.
   *
   * Narrower than "pin everything", and deliberately so: this asserts only over what the
   * walk above actually found reachable from the Pages Function, which is the one place
   * in this repo where the resolved version is a **deploy-time** fact no suite here can
   * check. `package-lock.json` already makes `npm ci` deterministic, so the range was not
   * a live defect — but a caret on a graph edge means the next `npm install` can move the
   * version inside the Function without anything in the repository noticing, and the four
   * dispatch facts in HANDOVER §8 are the standing reminder of how little this tree can
   * verify about a deploy. Frontend-only packages are untouched by this.
   *
   * The lockfile's root range is compared too, because a package.json pin whose lockfile
   * disagrees makes `npm ci` fail outright rather than resolving to either value.
   */
  const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const lockRoot = (() => {
    try {
      return JSON.parse(read('package-lock.json')).packages?.['']?.dependencies ?? {};
    } catch {
      return {};
    }
  })();
  const looselyPinned = [...graph.packages.keys()].flatMap((specifier) => {
    const declaredRange = declared[specifier];
    const lockedRange = lockRoot[specifier];
    if (!EXACT_VERSION.test(String(declaredRange))) return [`${specifier}@${declaredRange} in package.json`];
    if (declaredRange !== lockedRange) {
      return [`${specifier}: package.json says ${declaredRange}, package-lock.json says ${lockedRange}`];
    }
    return [];
  });

  check(
    `every npm package reachable from the Pages Function is pinned exactly${
      looselyPinned.length ? ` — ${looselyPinned.join(' | ')}` : ` (${[...graph.packages.keys()].map((s) => `${s}@${declared[s]}`).join(', ') || 'none reachable'})`
    }`,
    looselyPinned.length === 0,
  );
};
