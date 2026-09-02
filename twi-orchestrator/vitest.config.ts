import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/*
 * The finishing seam's test configuration. These three are duplicated in
 * test/workflow.test.ts as `MODAL`, `ORIGIN` and `SECRET`: the test needs them to construct a
 * callback, and importing this config into the Worker isolate is not possible. A mismatch
 * fails loudly rather than silently -- the stub answers 401 or 404 and the submit step dies.
 */
const MODAL_FINISH_URL = 'https://modal-finishing.invalid/finish/jobs';
const CALLBACK_ORIGIN = 'https://twi-orchestrator.invalid';
const STEMS_SECRET = 'test-stems-proxy-secret-0123456789';

/*
 * EVERY TWI migration, in the order the runner applies them, each found EXACTLY ONCE. This list is
 * one of three places that hard-code the migration set (with src/twi/server/repository.harness.ts
 * and scripts/twi-schema-behavior.test.mjs). Leave a migration out and this whole suite runs
 * against a D1 without its table -- green and blind -- which is why the integration tests SELECT
 * from twi_provider_calls and why section 16 of the contract check pins the file name here.
 */
const TWI_MIGRATIONS = ['twi-migration-001-creation-core.sql', 'twi-migration-002-provider-call-state.sql'];

export default defineConfig(async () => {
  const allMigrations = await readD1Migrations(repositoryRoot);
  const migrations = TWI_MIGRATIONS.map((expected) => {
    const found = allMigrations.filter(({ name }) => name === expected);
    if (found.length !== 1) throw new Error(`the real TWI migration ${expected} was not found exactly once`);
    return found[0]!;
  });

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TWI_PROVIDER_MODE: 'fake',
            TWI_MODAL_FINISH_URL: MODAL_FINISH_URL,
            TWI_CALLBACK_ORIGIN: CALLBACK_ORIGIN,
            STEMS_PROXY_SECRET: STEMS_SECRET,
          },
          /*
           * EVERY outbound fetch from the Worker under test lands here. There is exactly one in
           * this package -- the Modal finishing submission -- and it is stubbed rather than
           * mocked at the module seam so the Workflow really does make an HTTP request with
           * real headers, and so a missing or wrong `X-Stems-Secret` really does fail.
           *
           * The stub does NOT do Modal's work. It accepts the submission and hands back a call
           * id derived from the submission itself, which is what makes the two candidates'
           * calls distinguishable. Writing `archive.flac` / `review.mp3` into R2 and posting
           * the callback is left to the test, so a test can choose to write a bad object, a
           * bad manifest, or nothing at all.
           */
          outboundService: 'modal-finishing-stub',
          workers: [
            {
              name: 'modal-finishing-stub',
              modules: true,
              script: [
                'export default {',
                '  async fetch(request) {',
                `    if (request.headers.get('x-stems-secret') !== ${JSON.stringify(STEMS_SECRET)}) {`,
                "      return new Response('bad secret', { status: 401 });",
                '    }',
                `    if (new URL(request.url).href !== ${JSON.stringify(MODAL_FINISH_URL)}) {`,
                "      return new Response('unexpected url', { status: 404 });",
                '    }',
                '    const body = await request.json();',
                '    const context = body.callback_context;',
                '    if (!context || !context.callback_id || !context.nonce) {',
                "      return new Response('no callback context', { status: 400 });",
                '    }',
                `    if (body.callback_url !== ${JSON.stringify(`${CALLBACK_ORIGIN}/callback/modal`)}) {`,
                "      return new Response('bad callback url', { status: 400 });",
                '    }',
                "    if (!String(body.input_url).startsWith(`${" + JSON.stringify(CALLBACK_ORIGIN) + "}/internal/raw/`)) {",
                "      return new Response('bad input url', { status: 400 });",
                '    }',
                '    return Response.json({ call_id: `fc-${body.job_id}-${body.attempt}-${body.label}` });',
                '  },',
                '};',
              ].join('\n'),
            },
          ],
        },
      }),
    ],
    test: {
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      testTimeout: 20_000,
    },
  };
});
