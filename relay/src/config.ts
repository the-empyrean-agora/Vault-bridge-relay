/** Cloudflare environment bindings. */

export interface Env {
  VAULT_SESSION: DurableObjectNamespace;
  TOKENS: KVNamespace;
  VAULT_BUCKET: R2Bucket;
}
