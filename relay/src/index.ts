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
 *   GET    /health              → 200 OK (no auth)
 *   GET    /.well-known/*       → OAuth stubs (no auth)
 *   POST   /register            → OAuth stub (no auth)
 *
 * The index is the source of truth for search/backlinks/tags. It is owned
 * exclusively by the Worker — every file write goes through the Worker,
 * which updates the index atomically as a side effect. The plugin never
 * writes the index directly; it only reads it for sync diffing.
 */

import { Hono } from "hono";
import type { Env } from "./config.js";
import { authMiddleware, type AppVariables } from "./auth.js";
import { handleMcpRequest } from "./mcp.js";
import { handleR2ToolCall } from "./r2-ops.js";
import {
  buildEntryFromContent,
  removeIndexEntry,
  setIndexEntry,
} from "./index-manager.js";

export { VaultSession } from "./vault-session.js";

type AppEnv = { Bindings: Env; Variables: AppVariables };
const app = new Hono<AppEnv>();

// --- Public routes (no auth) ---

app.get("/health", (c) => c.text("OK"));

app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: c.req.url,
    bearer_methods_supported: ["header", "query"],
  })
);

app.get("/.well-known/oauth-protected-resource/*", (c) =>
  c.json({
    resource: c.req.url,
    bearer_methods_supported: ["header", "query"],
  })
);

app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: c.req.url,
    token_endpoint: new URL("/", c.req.url).href,
  })
);

app.post("/register", (c) =>
  c.json({ client_id: "static", client_id_issued_at: 0 })
);

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
    const userPrefix = c.get("userPrefix");
    return handleMcpRequest(c.req.raw, (tool, params) =>
      handleR2ToolCall(c.env.VAULT_BUCKET, userPrefix, tool, params)
    );
  }

  // Relay mode — forward to Durable Object
  const token = c.get("token");
  const id = c.env.VAULT_SESSION.idFromName(token);
  const stub = c.env.VAULT_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

// --- Sync API (r2 mode only — Obsidian plugin talks here) ---

// Get vault index. Returns an empty index if missing so the plugin can
// start with a clean state on first sync.
app.get("/sync/index", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const key = `${c.get("userPrefix")}/_vault-bridge-index.json`;
  const object = await c.env.VAULT_BUCKET.get(key);
  if (!object) {
    return c.json({
      version: 1,
      files: {},
      lastUpdated: new Date(0).toISOString(),
    });
  }
  return new Response(object.body, {
    headers: { "Content-Type": "application/json" },
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
  const key = `${c.get("userPrefix")}/${decodeURIComponent(filePath)}`;
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
  const userPrefix = c.get("userPrefix");
  const key = `${userPrefix}/${decodedPath}`;

  const body = await c.req.arrayBuffer();
  await c.env.VAULT_BUCKET.put(key, body, {
    httpMetadata: { contentType: c.req.header("Content-Type") ?? "text/markdown" },
  });

  // Update the index entry for this file. Decode body as text for parsing;
  // if decoding fails (e.g. binary attachment), skip the index update
  // rather than failing the write.
  try {
    const content = new TextDecoder().decode(body);
    const entry = await buildEntryFromContent(content, decodedPath);
    await setIndexEntry(c.env.VAULT_BUCKET, userPrefix, decodedPath, entry);
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
  const userPrefix = c.get("userPrefix");
  const key = `${userPrefix}/${decodedPath}`;

  await c.env.VAULT_BUCKET.delete(key);
  try {
    await removeIndexEntry(c.env.VAULT_BUCKET, userPrefix, decodedPath);
  } catch (err) {
    console.warn(`[sync] Failed to remove index entry for ${decodedPath}:`, err);
  }

  return c.json({ ok: true });
});

export default app;
