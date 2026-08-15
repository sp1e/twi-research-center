import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/twi',
  test: {
    environment: 'jsdom',
    globals: true,
    unstubGlobals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
  },
});
