/**
 * Vault Bridge Relay — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /ws?token=...    → WebSocket upgrade, forwarded to user's DO
 *   POST /mcp?token=...   → MCP request, forwarded to user's DO (wired in Step 5)
 *   GET  /health          → 200 OK (no auth)
 *   GET  /.well-known/*   → OAuth stubs (no auth)
 *   POST /register        → OAuth stub (no auth)
 */

import { Hono } from "hono";
import type { Env } from "./config.js";
import { authMiddleware } from "./auth.js";

export { VaultSession } from "./vault-session.js";

type AppEnv = { Bindings: Env; Variables: { token: string } };
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

// WebSocket upgrade — client connects here
app.get("/ws", authMiddleware, async (c) => {
  const token = c.get("token");
  const id = c.env.VAULT_SESSION.idFromName(token);
  const stub = c.env.VAULT_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

// MCP endpoint — Claude sends tool calls here (wired fully in Step 5)
app.post("/mcp", authMiddleware, async (c) => {
  const token = c.get("token");
  const id = c.env.VAULT_SESSION.idFromName(token);
  const stub = c.env.VAULT_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
