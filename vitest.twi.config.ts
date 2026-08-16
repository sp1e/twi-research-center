/**
 * TWI test config.
 *
 * It EXTENDS the build config (vite.twi.config.ts) instead of restating it, so the tests
 * run against the same root, base and plugin list that ships, and so the build config is
 * exercised on every test run rather than by nobody.
 *
 * The JSX transform needs one extra line to actually match, and the reason is worth
 * writing down. Two Vite majors are in play: `npm run build:twi` uses the root vite (8.x)
 * while vitest 2.x resolves its own nested vite (5.x). @vitejs/plugin-react@6 requests the
 * automatic runtime by returning `{ oxc: { jsx: { runtime: 'automatic' } } }` from its
 * `config` hook — an option only vite 8 reads. Under vite 5 that object is ignored and the
 * transform silently falls back to esbuild's CLASSIC `React.createElement`, which is what
 * previously forced `import React` into App.tsx and App.test.tsx purely to satisfy the test
 * run. `esbuild.jsx` below asks vite 5 for the same automatic runtime the build emits.
 *
 * If vitest is ever moved to a major that resolves vite >= 8, the `esbuild` block becomes
 * redundant and the plugin alone will govern both paths — delete it then, not before.
 * src/twi/main.test.tsx renders through main.tsx, which uses JSX with no React import, so
 * a regression here fails a test instead of shipping.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import viteTwiConfig from './vite.twi.config';

export default mergeConfig(
  viteTwiConfig,
  defineConfig({
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
    test: {
      environment: 'jsdom',
      globals: true,
      unstubGlobals: true,
      setupFiles: ['./test/setup.ts'],
      include: ['**/*.test.{ts,tsx}'],
    },
  }),
);
