/**
 * Per-user secrets endpoint.
 *
 * Stores small, user-owned secrets (e.g. LLM API keys for the email-agent)
 * keyed by the vault-bridge token. Lives in the TOKENS KV namespace under a
 * `secret:<token>:<name>` prefix so no new binding is needed. Token records
 * are UUID-keyed and won't collide with the `secret:` prefix.
 *
 * Callers authenticate with their existing vault-bridge token — the same
 * credential that already grants full read/write access to the user's vault,
 * so storing an API key is strictly less sensitive than what the token
 * already permits.
 *
 * Secret names are validated to a conservative character set; they are not
 * user-visible identifiers and are currently only written by the plugin
 * settings UI and read by the email-agent Worker.
 */

import type { Context } from "hono";
import type { Env } from "./config.js";
import type { AppVariables } from "./auth.js";

type SecretContext = Context<{ Bindings: Env; Variables: AppVariables }>;

const SECRET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SECRET_BYTES = 4096;

function secretKey(token: string, name: string): string {
  return `secret:${token}:${name}`;
}

function validateName(name: string): string | null {
  if (!name) return "missing secret name";
  if (!SECRET_NAME_RE.test(name)) {
    return "invalid secret name (use lowercase alphanumeric, hyphen, underscore; max 64 chars)";
  }
  return null;
}

export async function handleGetSecret(c: SecretContext): Promise<Response> {
  const name = c.req.param("name") ?? "";
  const err = validateName(name);
  if (err) return c.json({ error: err }, 400);

  const raw = await c.env.TOKENS.get(secretKey(c.get("token"), name));
  if (!raw) return c.json({ error: "not found" }, 404);

  try {
    return c.json(JSON.parse(raw));
  } catch {
    return c.json({ error: "stored secret is not valid JSON" }, 500);
  }
}

export async function handlePutSecret(c: SecretContext): Promise<Response> {
  const name = c.req.param("name") ?? "";
  const err = validateName(name);
  if (err) return c.json({ error: err }, 400);

  const body = await c.req.text();
  if (body.length > MAX_SECRET_BYTES) {
    return c.json({ error: `secret too large (max ${MAX_SECRET_BYTES} bytes)` }, 413);
  }

  // Require the body to parse as JSON so we never store arbitrary blobs.
  try {
    JSON.parse(body);
  } catch {
    return c.json({ error: "body must be valid JSON" }, 400);
  }

  await c.env.TOKENS.put(secretKey(c.get("token"), name), body);
  return c.json({ ok: true });
}

export async function handleDeleteSecret(c: SecretContext): Promise<Response> {
  const name = c.req.param("name") ?? "";
  const err = validateName(name);
  if (err) return c.json({ error: err }, 400);

  await c.env.TOKENS.delete(secretKey(c.get("token"), name));
  return c.json({ ok: true });
}
