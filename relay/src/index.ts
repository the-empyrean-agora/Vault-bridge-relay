/**
 * Vault Bridge — Cloudflare Worker entry point.
 *
 * Supports two modes per token:
 *   relay: MCP requests forwarded via DO + WebSocket to user's client
 *   r2:    MCP requests served directly from R2 bucket
 *
 * Routes:
 *   GET    /ws?token=...        → WebSocket upgrade (relay mode only)
 *   POST   /mcp?token=...       → MCP request (dispatches by token mode)
 *   GET    /sync/index          → Read-only index fetch (r2 mode, plugin)
 *   GET    /sync/files/*        → Download file from R2 (r2 mode, plugin)
 *   PUT    /sync/files/*        → Upload file + update index (r2 mode, plugin)
 *   DELETE /sync/files/*        → Delete file + remove index entry (r2 mode)
 *   POST   /sync/move           → Batch move/rename files, guarded (r2 mode)
 *   GET    /secrets/:name       → Read per-user secret (JSON)
 *   PUT    /secrets/:name       → Write per-user secret (JSON body)
 *   DELETE /secrets/:name       → Delete per-user secret
 *   GET    /health              → 200 OK (no auth)
 *   GET    /.well-known/*       → OAuth discovery metadata (no auth)
 *   POST   /register            → OAuth dynamic client registration (no auth)
 *   GET    /authorize           → OAuth consent page (user pastes vault token)
 *   POST   /authorize           → Consent submit → authorization code
 *   POST   /token               → OAuth code exchange → vault token
 *
 * The index is the source of truth for search/backlinks/tags. It is owned
 * exclusively by the Worker — every file write goes through the Worker,
 * which updates the index atomically as a side effect. The plugin never
 * writes the index directly; it only reads it for sync diffing.
 */

import { Hono } from "hono";
import type { Env } from "./config.js";
import { authMiddleware, validateVaultToken, type AppVariables } from "./auth.js";
import {
  buildAuthServerMetadata,
  buildProtectedResourceMetadata,
  handleConsent,
  handleRegistration,
  handleTokenExchange,
  renderConsentPage,
  validateAuthorizeParams,
  type AuthorizeParams,
} from "./oauth.js";
import { handleMcpRequest } from "./mcp.js";
import {
  handleR2ToolCall,
  moveFile,
  putSyncFileGuarded,
  deleteSyncFileGuarded,
  type MoveResult,
  type VaultCtx,
} from "./r2-ops.js";
import { buildEntryFromContent, getIndexStore } from "./index-store.js";
import { isValidVaultPath } from "./vault-path.js";
import {
  handleDeleteSecret,
  handleGetSecret,
  handlePutSecret,
} from "./secrets.js";

export { VaultSession } from "./vault-session.js";
export { VaultIndexDO } from "./index-do.js";

/** Assemble the per-request vault context for R2-mode routes. */
function vaultCtx(env: Env, userPrefix: string): VaultCtx {
  return {
    bucket: env.VAULT_BUCKET,
    prefix: userPrefix,
    index: getIndexStore(env, userPrefix),
    timezone: env.VAULT_TZ || "UTC",
  };
}

type AppEnv = { Bindings: Env; Variables: AppVariables };
const app = new Hono<AppEnv>();

// --- Public routes (no auth) ---

app.get("/health", (c) => c.text("OK"));

// OAuth 2.1 for Claude connectors (see oauth.ts for the full design). The
// discovery documents, DCR, consent page, and token exchange are all served
// from this origin; the access token Claude ends up with is the same vault
// token every other client uses.

const requestOrigin = (url: string) => new URL(url).origin;

app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(buildProtectedResourceMetadata(requestOrigin(c.req.url)))
);

app.get("/.well-known/oauth-protected-resource/*", (c) =>
  c.json(buildProtectedResourceMetadata(requestOrigin(c.req.url)))
);

app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(buildAuthServerMetadata(requestOrigin(c.req.url)))
);

app.get("/.well-known/oauth-authorization-server/*", (c) =>
  c.json(buildAuthServerMetadata(requestOrigin(c.req.url)))
);

app.post("/register", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const result = handleRegistration(body);
  return c.json(result.body, result.status);
});

function authorizeParamsFrom(
  source: (key: string) => string | undefined
): AuthorizeParams {
  return {
    response_type: source("response_type"),
    client_id: source("client_id"),
    redirect_uri: source("redirect_uri"),
    state: source("state"),
    code_challenge: source("code_challenge"),
    code_challenge_method: source("code_challenge_method"),
  };
}

app.get("/authorize", (c) => {
  const params = authorizeParamsFrom((k) => c.req.query(k));
  const error = validateAuthorizeParams(params);
  if (error) {
    // Never render the consent form for a malformed request — especially a
    // redirect_uri outside the allowlist.
    return c.text(`Invalid authorization request: ${error}`, 400);
  }
  return c.html(renderConsentPage(params));
});

app.post("/authorize", async (c) => {
  const form = await c.req.parseBody();
  const field = (k: string) =>
    typeof form[k] === "string" ? (form[k] as string) : undefined;
  const params = authorizeParamsFrom(field);
  const vaultToken = (field("vault_token") ?? "").trim();

  const result = await handleConsent(c.env.TOKENS, params, vaultToken, (t) =>
    validateVaultToken(c.env.TOKENS, t)
  );
  if (result.redirectTo) {
    return c.redirect(result.redirectTo, 302);
  }
  const paramError = validateAuthorizeParams(params);
  if (paramError) {
    return c.text(`Invalid authorization request: ${paramError}`, 400);
  }
  return c.html(renderConsentPage(params, result.errorMessage), 401);
});

app.post("/token", async (c) => {
  const form = await c.req.parseBody();
  const fields: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") fields[k] = v;
  }
  const result = await handleTokenExchange(c.env.TOKENS, fields);
  return c.json(result.body, result.status, { "Cache-Control": "no-store" });
});

// --- Authenticated routes ---

// WebSocket upgrade — relay mode clients connect here
app.get("/ws", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "relay") {
    return c.json({ error: "WebSocket not available for R2 mode tokens" }, 400);
  }
  const token = c.get("token");
  const id = c.env.VAULT_SESSION.idFromName(token);
  const stub = c.env.VAULT_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

// MCP endpoint — dispatches to DO (relay) or R2 based on token mode
app.post("/mcp", authMiddleware, async (c) => {
  const mode = c.get("tokenMode");

  if (mode === "r2") {
    const vault = vaultCtx(c.env, c.get("userPrefix"));
    return handleMcpRequest(c.req.raw, (tool, params) =>
      handleR2ToolCall(vault, tool, params)
    );
  }

  // Relay mode — forward to Durable Object
  const token = c.get("token");
  const id = c.env.VAULT_SESSION.idFromName(token);
  const stub = c.env.VAULT_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

// --- Sync API (r2 mode only — Obsidian plugin talks here) ---

// Get vault index. Served from the per-user index DO (which lazily imports
// the legacy R2 blob on first access, so this returns an empty index for a
// brand-new user). The X-Remote-Write-Active header is the write-lease (O4):
// "1" while an MCP write burst is in flight, so the plugin can defer a
// background sync instead of interleaving with Claude's edits.
app.get("/sync/index", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const store = getIndexStore(c.env, c.get("userPrefix"));
  const { index, remoteWriteActive } = await store.fullIndex();
  return c.json(index, 200, {
    "X-Remote-Write-Active": remoteWriteActive ? "1" : "0",
  });
});

// NOTE: There is intentionally no PUT /sync/index endpoint. The index is
// owned exclusively by the Worker to prevent lost-update races between the
// plugin and Claude's MCP writes. Every mutation to the index happens as a
// side effect of the route that mutated the underlying file.

// Download file
app.get("/sync/files/*", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const filePath = c.req.path.replace("/sync/files/", "");
  if (!filePath) {
    return c.json({ error: "Missing file path" }, 400);
  }
  const decoded = decodeURIComponent(filePath);
  if (!isValidVaultPath(decoded)) {
    return c.json({ error: "Invalid file path" }, 400);
  }
  const key = `${c.get("userPrefix")}/${decoded}`;
  const object = await c.env.VAULT_BUCKET.get(key);
  if (!object) {
    return c.json({ error: "File not found" }, 404);
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "ETag": object.etag,
    },
  });
});

// Upload file — also updates the vault index entry for this path.
// The plugin no longer pushes the index as a separate operation; each file
// upload carries its own index update, so plugin syncs and MCP writes
// cannot race to clobber each other's index state.
app.put("/sync/files/*", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const filePath = c.req.path.replace("/sync/files/", "");
  if (!filePath) {
    return c.json({ error: "Missing file path" }, 400);
  }
  const decodedPath = decodeURIComponent(filePath);
  if (!isValidVaultPath(decodedPath)) {
    return c.json({ error: "Invalid file path" }, 400);
  }
  const userPrefix = c.get("userPrefix");
  const key = `${userPrefix}/${decodedPath}`;

  const body = await c.req.arrayBuffer();
  const content = new TextDecoder().decode(body);

  // Version-guard, opt-in: a plugin that sends If-Match / If-None-Match gets
  // optimistic-concurrency protection (412 on a stale base → it reconciles).
  // A plugin that sends neither falls through to the legacy unconditional path,
  // so existing installs keep working until they ship the guarded push.
  const vault = vaultCtx(c.env, userPrefix);
  const ifMatch = c.req.header("If-Match");
  const ifNoneMatch = c.req.header("If-None-Match");
  if (ifMatch != null || ifNoneMatch != null) {
    const result = await putSyncFileGuarded(vault, decodedPath, content, {
      ifMatch: ifMatch ?? null,
      ifNoneMatch: ifNoneMatch ?? null,
    });
    if (result.status === 412) {
      return c.json(
        { error: "Precondition Failed", path: decodedPath, currentHash: result.currentHash },
        412
      );
    }
    return c.json({ ok: true, key, hash: result.hash });
  }

  // Legacy unconditional path.
  await c.env.VAULT_BUCKET.put(key, body, {
    httpMetadata: { contentType: c.req.header("Content-Type") ?? "text/markdown" },
  });
  // Update the index entry for this file. If decoding fails (e.g. binary
  // attachment), skip the index update rather than failing the write.
  try {
    const entry = await buildEntryFromContent(content, decodedPath);
    await vault.index.setEntry(decodedPath, entry);
  } catch (err) {
    console.warn(`[sync] Failed to update index for ${decodedPath}:`, err);
  }

  return c.json({ ok: true, key });
});

// Delete file — also removes the vault index entry for this path.
app.delete("/sync/files/*", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const filePath = c.req.path.replace("/sync/files/", "");
  if (!filePath) {
    return c.json({ error: "Missing file path" }, 400);
  }
  const decodedPath = decodeURIComponent(filePath);
  if (!isValidVaultPath(decodedPath)) {
    return c.json({ error: "Invalid file path" }, 400);
  }
  const userPrefix = c.get("userPrefix");
  const key = `${userPrefix}/${decodedPath}`;

  // Version-guard, opt-in (see PUT handler): a plugin sending If-Match won't
  // delete a file that changed in R2 since it last saw it.
  const vault = vaultCtx(c.env, userPrefix);
  const ifMatch = c.req.header("If-Match");
  if (ifMatch != null) {
    const result = await deleteSyncFileGuarded(vault, decodedPath, { ifMatch });
    if (result.status === 412) {
      return c.json(
        { error: "Precondition Failed", path: decodedPath, currentHash: result.currentHash },
        412
      );
    }
    return c.json({ ok: true });
  }

  // Legacy unconditional path.
  await c.env.VAULT_BUCKET.delete(key);
  try {
    await vault.index.removeEntry(decodedPath);
  } catch (err) {
    console.warn(`[sync] Failed to remove index entry for ${decodedPath}:`, err);
  }

  return c.json({ ok: true });
});

// Move files — renames become first-class ops instead of delete+create pairs
// (O3 of docs/sync-hardening-brief.md). Body: { moves: [{ from, to, ifMatch? }] },
// max 100 items per request (each move costs several subrequests against the
// per-invocation cap; the plugin chunks). `ifMatch` is the index content-hash
// of the source the caller last saw — the same version token as the PUT guard.
// Responds 200 with per-item results ({ from, to, status: 200|400|404|409|412 });
// partial failure is data for the caller to reconcile, not an HTTP error.
const MAX_MOVES_PER_REQUEST = 100;

app.post("/sync/move", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }

  let body: { moves?: Array<{ from?: unknown; to?: unknown; ifMatch?: unknown }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.moves) || body.moves.length === 0) {
    return c.json({ error: "Body must be { moves: [{ from, to, ifMatch? }] }" }, 400);
  }
  if (body.moves.length > MAX_MOVES_PER_REQUEST) {
    return c.json(
      { error: `Too many moves in one request (max ${MAX_MOVES_PER_REQUEST}); chunk the batch` },
      400
    );
  }

  const vault = vaultCtx(c.env, c.get("userPrefix"));
  const results: MoveResult[] = [];
  // Sequential on purpose: moves in one batch can touch adjacent keys (folder
  // renames), and ordering keeps per-item results deterministic.
  for (const m of body.moves) {
    const from = typeof m.from === "string" ? m.from : "";
    const to = typeof m.to === "string" ? m.to : "";
    results.push(
      await moveFile(vault, from, to, {
        ifMatch: typeof m.ifMatch === "string" ? m.ifMatch : null,
      })
    );
  }
  return c.json({ results });
});

// --- Secrets API (per-user KV-backed secrets, e.g. LLM API keys) ---

app.get("/secrets/:name", authMiddleware, handleGetSecret);
app.put("/secrets/:name", authMiddleware, handlePutSecret);
app.delete("/secrets/:name", authMiddleware, handleDeleteSecret);

export default app;
