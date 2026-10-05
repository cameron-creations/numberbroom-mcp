import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Runs tests inside an actual workerd isolate rather than a Node shim, so
// fetch/Request/Response behave exactly as they will in production. The
// wrangler config supplies the compatibility flags and the OAUTH_KV binding
// (a local, empty namespace under miniflare); the shared secret, a wrangler
// secret in production, is a fixed test value here.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { MCP_INTERNAL_SECRET: "test-internal-secret" } },
      },
    },
  },
});
