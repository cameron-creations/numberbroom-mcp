import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Runs tests inside an actual workerd isolate rather than a Node shim, so
// fetch/Request/Response behave exactly as they will in production -- this
// worker has no bindings (no KV/D1/R2), so the wrangler config is only read
// for compatibility_date/flags.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
