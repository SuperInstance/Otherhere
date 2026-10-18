import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Tests never touch the network: Overpass points at a closed port.
      miniflare: {
        bindings: {
          OVERPASS_ENDPOINTS: 'http://127.0.0.1:9/api/interpreter',
          NOMINATIM_URL: 'http://127.0.0.1:9/search',
          ELEVATION_TILES_URL: 'http://127.0.0.1:9/{z}/{x}/{y}',
          SATELLITE_TILES_URL: 'http://127.0.0.1:9/{z}/{x}/{y}',
          MODEL_FAKE: 'true',
          OPS_TOKEN: 'test-ops',
          AGENT_TOKEN: 'test-agent',
        },
      },
    }),
  ],
});
