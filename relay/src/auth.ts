/**
 * Auth middleware — validates token from query param or Bearer header against KV.
 *
 * On success, sets c.set("token", token) for downstream handlers.
 */

import type { Context, Next } from "hono";
import type { Env } from "./config.js";

interface TokenRecord {
  label: string;
  created: string;
  active: boolean;
}

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: { token: string } }>,
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

  c.set("token", token);
  await next();
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}
