import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(async () => {
  const allMigrations = await readD1Migrations(repositoryRoot);
  const migrations = allMigrations.filter(({ name }) => name === 'twi-migration-001-creation-core.sql');
  if (migrations.length !== 1) throw new Error('the real TWI migration was not found exactly once');

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TWI_PROVIDER_MODE: 'fake',
          },
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
