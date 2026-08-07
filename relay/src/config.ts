/** Cloudflare environment bindings. */

import type { VaultIndexDO } from "./index-do.js";

export interface Env {
  VAULT_SESSION: DurableObjectNamespace;
  VAULT_INDEX: DurableObjectNamespace<VaultIndexDO>;
  TOKENS: KVNamespace;
  VAULT_BUCKET: R2Bucket;
}
