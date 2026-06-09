import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://localhost:3030',
      // Product images are served by the Express backend from /uploads. Without this,
      // Vite's SPA fallback returns index.html for image requests and they fail to load.
      '/uploads': 'http://localhost:3030',
    },
  },
});
