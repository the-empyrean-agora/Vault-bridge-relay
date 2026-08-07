/** Cloudflare environment bindings. */

import type { VaultIndexDO } from "./index-do.js";

export interface Env {
  VAULT_SESSION: DurableObjectNamespace;
  VAULT_INDEX: DurableObjectNamespace<VaultIndexDO>;
  TOKENS: KVNamespace;
  VAULT_BUCKET: R2Bucket;
  /**
   * IANA timezone for date-only frontmatter stamps (`updated:`), e.g.
   * "Australia/Melbourne". Set as a var in wrangler.toml. Defaults to UTC.
   */
  VAULT_TZ?: string;
}
