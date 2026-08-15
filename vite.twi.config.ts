import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/twi',
  base: '/twi/',
  plugins: [react()],
  build: {
    outDir: '../../twi',
    emptyOutDir: true,
    sourcemap: true,
  },
});
