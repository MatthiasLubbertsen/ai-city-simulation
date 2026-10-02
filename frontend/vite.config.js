import { defineConfig } from 'vite';

// Dev-server op 1724 (productie draait volledig op 1723 via de backend).
export default defineConfig({
  server: {
    port: 1724,
    host: true,
    proxy: {
      '/api': 'http://localhost:1723',
      '/ws': { target: 'ws://localhost:1723', ws: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
