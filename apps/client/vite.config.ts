import { defineConfig } from 'vitest/config';

// Two lanes can develop side by side: EDGE_PORT points the client's /api proxy
// at a different local Worker (default 8787, as `pnpm dev` starts it).
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${process.env.EDGE_PORT ?? 8787}`, ws: true } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
