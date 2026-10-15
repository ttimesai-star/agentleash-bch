import { defineConfig } from 'vite';

// Static build for GitHub Pages: relative base so the site works under /agentleash-bch/.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
  envDir: import.meta.dirname,
});
