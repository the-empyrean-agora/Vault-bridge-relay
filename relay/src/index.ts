/**
 * Vault Bridge — Cloudflare Worker entry point.
 *
 * Supports two modes per token:
 *   relay: MCP requests forwarded via DO + WebSocket to user's client
 *   r2:    MCP requests served directly from R2 bucket
 *
 * Routes:
 *   GET  /ws?token=...         → WebSocket upgrade (relay mode only)
 *   POST /mcp?token=...        → MCP request (dispatches by token mode)
 *   GET  /sync/manifest        → Get sync manifest (r2 mode, plugin)
 *   PUT  /sync/manifest        → Update sync manifest (r2 mode, plugin)
 *   GET  /sync/files/*         → Download file from R2 (r2 mode, plugin)
 *   PUT  /sync/files/*         → Upload file to R2 (r2 mode, plugin)
 *   DELETE /sync/files/*       → Delete file from R2 (r2 mode, plugin)
 *   GET  /health               → 200 OK (no auth)
 *   GET  /.well-known/*        → OAuth stubs (no auth)
 *   POST /register             → OAuth stub (no auth)
 */

import { Hono } from "hono";
import type { Env } from "./config.js";
import { authMiddleware, type AppVariables } from "./auth.js";
import { handleMcpRequest } from "./mcp.js";
import { handleR2ToolCall } from "./r2-ops.js";

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

// Get manifest
app.get("/sync/manifest", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const key = `${c.get("userPrefix")}/_vault-bridge-manifest.json`;
  const object = await c.env.VAULT_BUCKET.get(key);
  if (!object) {
    return c.json({ files: {}, lastSync: null });
  }
  return new Response(object.body, {
    headers: { "Content-Type": "application/json" },
  });
});

// Update manifest
app.put("/sync/manifest", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const key = `${c.get("userPrefix")}/_vault-bridge-manifest.json`;
  const body = await c.req.text();
  await c.env.VAULT_BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/json" },
  });
  return c.json({ ok: true });
});

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

// Upload file
app.put("/sync/files/*", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const filePath = c.req.path.replace("/sync/files/", "");
  if (!filePath) {
    return c.json({ error: "Missing file path" }, 400);
  }
  const key = `${c.get("userPrefix")}/${decodeURIComponent(filePath)}`;
  const body = await c.req.arrayBuffer();
  await c.env.VAULT_BUCKET.put(key, body, {
    httpMetadata: { contentType: c.req.header("Content-Type") ?? "text/markdown" },
  });
  return c.json({ ok: true, key });
});

// Delete file
app.delete("/sync/files/*", authMiddleware, async (c) => {
  if (c.get("tokenMode") !== "r2") {
    return c.json({ error: "Sync API requires R2 mode token" }, 400);
  }
  const filePath = c.req.path.replace("/sync/files/", "");
  if (!filePath) {
    return c.json({ error: "Missing file path" }, 400);
  }
  const key = `${c.get("userPrefix")}/${decodeURIComponent(filePath)}`;
  await c.env.VAULT_BUCKET.delete(key);
  return c.json({ ok: true });
});

export default app;
