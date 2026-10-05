// The bindings vitest-pool-workers provides (from wrangler.jsonc and
// vitest.config.ts) are the Worker's own Env.
import type { Env } from "../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
