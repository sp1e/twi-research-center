import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/twi',
  base: '/twi/',
  plugins: [react()],
  build: {
    // outDir is fully generated: every build wipes and rewrites /twi/. Never hand-add a
    // file there.
    outDir: '../../twi',
    emptyOutDir: true,
    // Off deliberately, and it must stay off. Cloudflare Pages serves the repo root with
    // no build step, so a committed .map is a public URL: /twi/assets/*.js.map served with
    // sourcesContent, i.e. src/twi/** republished verbatim. That defeats the /src/* -> 301
    // rule in _redirects, whose whole purpose is that unbuilt sources are not fetchable,
    // and it contradicts .gitignore, which drops the sp1epacker maps for the same reason.
    // Rebuild locally with `sourcemap: true` when you actually need to debug; do not commit
    // the result.
    sourcemap: false,
  },
});
