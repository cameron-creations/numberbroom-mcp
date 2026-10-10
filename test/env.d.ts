// The bindings the Workers vitest plugin provides (from wrangler.jsonc and
// vitest.config.ts) are the Worker's own Env. The plugin types `env` from
// "cloudflare:test" as Cloudflare.Env, so that is the interface extended.
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
