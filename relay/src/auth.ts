/**
 * Auth middleware — validates token from query param or Bearer header against KV.
 *
 * On success, sets context variables for downstream handlers:
 *   - token: the raw token string
 *   - tokenMode: "relay" or "r2"
 *   - userPrefix: R2 key prefix for r2 mode (e.g. "leigh")
 */

import type { Context, Next } from "hono";
import type { Env } from "./config.js";

export interface TokenRecord {
  label: string;
  created: string;
  active: boolean;
  mode?: "relay" | "r2";    // default: "relay" for backwards compatibility
  prefix?: string;           // R2 key prefix, required when mode is "r2"
}

export type AppVariables = {
  token: string;
  tokenMode: "relay" | "r2";
  userPrefix: string;
};

/**
 * Standalone token check — KV lookup, JSON parse, active flag. Shared by the
 * middleware and the OAuth consent flow (which validates a pasted token
 * outside any authenticated route).
 */
export async function validateVaultToken(
  kv: { get(key: string): Promise<string | null> },
  token: string
): Promise<TokenRecord | null> {
  if (!token) return null;
  const raw = await kv.get(token);
  if (!raw) return null;
  let record: TokenRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record.active) return null;
  return record;
}

/**
 * 401s carry the RFC 9728 pointer to our protected-resource metadata —
 * this is how current Claude clients discover the OAuth flow (they do not
 * honor the header on non-401 responses).
 */
function unauthorizedHeaders(c: Context): Record<string, string> {
  const origin = new URL(c.req.url).origin;
  return {
    "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  };
}

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
): Promise<Response | void> {
  // Extract token from query param or Authorization header
  const token =
    c.req.query("token") ?? extractBearer(c.req.header("Authorization"));

  if (!token) {
    return c.json({ error: "unauthorized" }, 401, unauthorizedHeaders(c));
  }

  // KV lookup
  const raw = await c.env.TOKENS.get(token);
  if (!raw) {
    return c.json({ error: "unauthorized" }, 401, unauthorizedHeaders(c));
  }

  let record: TokenRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return c.json({ error: "unauthorized" }, 401, unauthorizedHeaders(c));
  }

  if (!record.active) {
    return c.json({ error: "token revoked" }, 401, unauthorizedHeaders(c));
  }

  const mode = record.mode ?? "relay";
  if (mode === "r2" && !record.prefix) {
    return c.json({ error: "token misconfigured: missing prefix" }, 500);
  }

  c.set("token", token);
  c.set("tokenMode", mode);
  c.set("userPrefix", record.prefix ?? "");
  await next();
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}
