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

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next
): Promise<Response | void> {
  // Extract token from query param or Authorization header
  const token =
    c.req.query("token") ?? extractBearer(c.req.header("Authorization"));

  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // KV lookup
  const raw = await c.env.TOKENS.get(token);
  if (!raw) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let record: TokenRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }

  if (!record.active) {
    return c.json({ error: "token revoked" }, 401);
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
