# Vault Bridge Relay — Architecture Document

## Purpose
This document is the authoritative technical brief for building Vault Bridge v2: a multi-tenant relay that gives Claude permanent remote access to any user's Obsidian vault. It is written for Claude Code to implement from.

---

## Decisions Log

| Decision | Choice | Reasoning |
|---|---|---|
| v2 Domain | `vault-bridge.the-empyrean.com` | New subdomain. v1 stays live on `vault.the-empyrean.com` during build. Cutover when v2 is stable. |
| Migration strategy | Parallel run, then cutover | v1 (Pip direct MCP) untouched during build. v2 relay on separate subdomain. |
| Hosting | Cloudflare Workers + Durable Objects | No VPS to manage. Worker IS the endpoint — no tunnel needed on server side. Deploy via `wrangler deploy`. Workers Paid ~$5 USD/month. Already deep in Cloudflare ecosystem (DNS, tunnels, domain). |
| Relay language | TypeScript (Worker + Durable Object) | Native Cloudflare platform. Hono runs on Workers. Shared types with Phase 3 Obsidian plugin. MCPAgent class available in Agents SDK. |
| Client language | Python | vault_ops.py is near copy-paste from v1. Client replaced by Obsidian plugin in Phase 3. |
| Client distribution | `pip install` + setup wizard | Target users can handle a terminal command. PyInstaller deferred. |
| Token storage | Durable Object SQLite or Workers KV | No filesystem — Workers are stateless. KV for token registry, DO storage for per-session state. |
| Auth | Token in connector URL | Simple, proven, matches v1 pattern. |
| Extended MCP tools | Deferred to post-launch | Launch with 4 tools matching v1. Expand later. Tool interface is extensible — no protocol changes needed. |

---

## Migration Strategy

v1 and v2 run in parallel. No disruption to Leigh's live setup.

| | v1 (current) | v2 (relay) |
|---|---|---|
| **Domain** | `vault.the-empyrean.com` | `vault-bridge.the-empyrean.com` |
| **Architecture** | FastMCP server on Pip → Cloudflare Tunnel | Worker + DO on Cloudflare edge ← WSS ← Client on user's machine |
| **Status during build** | Live, untouched | Under development |
| **Connector URL** | `vault.the-empyrean.com/mcp?token=...` | `vault-bridge.the-empyrean.com/mcp?token=...` |

**Testing:** Leigh adds a second Claude connector URL pointing at v2. Can switch between v1 and v2 in any conversation.

**Cutover (when v2 is stable):**
1. Leigh's Pip runs the Python client (connecting to relay) instead of the FastMCP server
2. Connector URL updated to v2
3. v1 tunnel and FastMCP server decommissioned

**Other users (friend, Stacey):** Onboarded directly to v2. They never see v1.

---

## System Overview

```
┌─────────────┐         ┌──────────────────────────────────────┐         ┌──────────────────┐
│  Claude.ai  │         │        Cloudflare Edge               │         │  User's Machine  │
│  (any       │         │                                      │         │                  │
│  device)    │         │  Worker                              │         │  Client App      │
│             │──HTTPS──│  ├─ MCP endpoint  (/mcp)             │──WSS────│  (Python,        │
│  MCP        │  /mcp   │  ├─ Routes by token to DO            │         │   pip install)   │
│  connector  │         │  └─ Token validation (KV)            │         │       ↓          │
│             │         │       ↓                              │         │  Local Vault     │
│             │         │  Durable Object (per user)           │         │  (filesystem)    │
│             │         │  ├─ Holds client WebSocket           │         │                  │
│             │         │  ├─ Brokers MCP ↔ WS                 │         │                  │
│             │         │  └─ Hibernates when idle              │         │                  │
└─────────────┘         └──────────────────────────────────────┘         └──────────────────┘
```

**Key difference from VPS approach:** No tunnel needed on the server side. The Worker IS the public endpoint at `vault-bridge.the-empyrean.com`. Cloudflare handles TLS, routing, and global availability automatically.

**Data flow for a tool call:**
1. Claude sends MCP request to `https://vault-bridge.the-empyrean.com/mcp?token=<user_token>`
2. Worker validates token (KV lookup), routes request to user's Durable Object
3. DO serialises tool call as JSON, sends over WebSocket to connected client
4. Client executes against local vault, sends result JSON back
5. DO returns result to Worker, Worker returns MCP response to Claude

**If client is offline:** DO returns a clean MCP error — `"Client not connected. Ensure Vault Bridge is running on your machine."`

**Hibernation:** When no MCP requests are in-flight and no WebSocket messages are active, the DO hibernates. The client WebSocket stays connected (Cloudflare runtime handles ping/pong at the protocol level). When a new MCP request arrives, the DO wakes instantly. This means near-zero cost when idle.

---

## Component Inventory

| Component | Language | Where | Phase |
|---|---|---|---|
| **Worker** | TypeScript | Cloudflare edge | Phase 2 |
| **Durable Object** | TypeScript | Cloudflare edge (per user) | Phase 2 |
| **Client app** | Python (pip package) | User's machine | Phase 2 |
| **Token manager** | Wrangler CLI + KV | Cloudflare dashboard or CLI | Phase 2 |
| **Obsidian plugin** | TypeScript (Obsidian plugin API) | User's Obsidian | Phase 3 — replaces client app |

---

## MCP Interface

### Launch Tools (v1 parity)

Four tools. Identical signatures to existing vault-bridge.

```
list_directory(path: string = "")  → string[]
read_file(path: string)            → string
write_file(path: string, content: string) → string
search_files(query: string)        → string[]  (up to 50 results)
```

All paths relative to vault root. Relay never sees absolute paths.

### Future Tools (post-launch, no protocol changes needed)
- `get_tags()`, `get_frontmatter(path)`, `update_frontmatter(path, key, value)`
- `get_backlinks(path)`, `create_canvas(path, nodes, edges)`
- `rename_file(old_path, new_path)`, `get_vault_stats()`

**Public paths (no auth):** `/health`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register`

---

## Relay ↔ Client WebSocket Protocol

Unchanged from original design. Simple JSON over WebSocket.

**Tool call (DO → Client):**
```json
{ "type": "tool_call", "request_id": "<uuid>", "tool": "read_file", "params": { "path": "..." } }
```

**Result (Client → DO):**
```json
{ "type": "tool_result", "request_id": "<uuid>", "result": "...", "error": null }
```

**Client connect handshake (Client → DO, on WS open):**
```json
{ "type": "connect", "token": "...", "vault_path_hint": "~/Documents/MyVault", "client_version": "0.1.0", "platform": "windows" }
```

**Heartbeat:** The Cloudflare runtime automatically handles WebSocket protocol-level ping/pong, keeping connections alive without waking the DO. Application-level heartbeat (every 30s) is optional — use only if needed for client-side connection health monitoring. Client reconnects with exponential backoff: 2s → 4s → 8s → 16s → 30s → 60s (cap).

**Deploy note:** Code deploys (`wrangler deploy`) disconnect all active WebSockets. Clients reconnect automatically via backoff logic. Claude is unaffected — it makes fresh HTTP requests per tool call, not persistent connections. In practice, deploys cause a 2-4 second blip for connected clients.

---

## Token Model

UUID v4 per user. Included in MCP connector URL: `https://vault-bridge.the-empyrean.com/mcp?token=<token>`

**Storage:** Workers KV namespace `VAULT_BRIDGE_TOKENS`.

```json
// KV key: token UUID, value:
{
  "label": "stacey",
  "created": "2026-04-06",
  "active": true
}
```

**DO naming:** Each token maps to a Durable Object via `env.VAULT_SESSION.idFromName(token)`. One DO per user.

**Token management:** Via Wrangler CLI or a small admin script:
```bash
# Add token
wrangler kv key put --namespace-id=<id> "<uuid>" '{"label":"stacey","created":"2026-04-06","active":true}'

# List tokens
wrangler kv key list --namespace-id=<id>

# Revoke token
wrangler kv key put --namespace-id=<id> "<uuid>" '{"label":"stacey","created":"2026-04-06","active":false}'
```

A dedicated `tokens-cli` script wrapping these commands makes it more ergonomic. Not a priority for launch.

---

## Worker + Durable Object Design (TypeScript)

### Stack
- **Runtime:** Cloudflare Workers
- **HTTP routing:** Hono (runs natively on Workers)
- **MCP layer:** `@modelcontextprotocol/sdk` or Cloudflare Agents SDK `MCPAgent`
- **State:** Durable Objects with Hibernatable WebSocket API
- **Token storage:** Workers KV
- **Schema validation:** zod

### File structure
```
relay/
├── src/
│   ├── index.ts           # Worker entry point, Hono app, route registration
│   ├── vault-session.ts   # Durable Object class — WS management, request brokering
│   ├── mcp.ts             # MCP tool definitions, wired to DO
│   ├── auth.ts            # Token validation middleware (KV lookup)
│   ├── models.ts          # TypeScript interfaces for WS messages
│   └── config.ts          # Environment bindings type definitions
├── wrangler.toml          # Cloudflare config: DO bindings, KV namespace, routes
├── package.json
└── tsconfig.json
```

### Worker (index.ts)
Routes incoming requests:
- `GET /ws?token=<token>` → WebSocket upgrade, forwarded to DO
- `POST /mcp?token=<token>` → MCP request, forwarded to DO
- `GET /health` → 200 OK (no auth)
- `GET /.well-known/*` → OAuth stubs (no auth)

```typescript
// Simplified routing
app.get('/ws', authMiddleware, async (c) => {
  const token = c.get('token');
  const id = c.env.VAULT_SESSION.idFromName(token);
  const stub = c.env.VAULT_SESSION.get(id);
  return stub.fetch(c.req.raw);  // Forward WS upgrade to DO
});

app.post('/mcp', authMiddleware, async (c) => {
  const token = c.get('token');
  const id = c.env.VAULT_SESSION.idFromName(token);
  const stub = c.env.VAULT_SESSION.get(id);
  return stub.fetch(c.req.raw);  // Forward MCP request to DO
});
```

### Durable Object (vault-session.ts)
Each user gets one DO instance. It holds the client WebSocket and brokers MCP requests.

```typescript
export class VaultSession extends DurableObject {
  private clientWs: WebSocket | null = null;
  private pending: Map<string, { resolve: Function; reject: Function; timeout: ReturnType<typeof setTimeout> }> = new Map();

  // Client connects via WebSocket
  async webSocketMessage(ws: WebSocket, message: string) {
    const msg = JSON.parse(message);
    if (msg.type === 'connect') {
      this.clientWs = ws;
      // Store metadata via serializeAttachment
      ws.serializeAttachment({ ...msg, connectedAt: new Date().toISOString() });
      return;
    }
    if (msg.type === 'tool_result') {
      const pending = this.pending.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(msg.request_id);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      }
      return;
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.clientWs = null;
  }

  // MCP request comes in as HTTP, broker to client WS
  async handleToolCall(tool: string, params: Record<string, unknown>): Promise<string> {
    if (!this.clientWs) {
      throw new Error("Client not connected. Ensure Vault Bridge is running on your machine.");
    }
    const requestId = crypto.randomUUID();
    const promise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Client timed out after 30s"));
      }, 30_000);
      this.pending.set(requestId, { resolve, reject, timeout });
    });
    this.clientWs.send(JSON.stringify({ type: "tool_call", request_id: requestId, tool, params }));
    return promise;
  }
}
```

### Hibernation
Use `this.ctx.acceptWebSocket(ws)` instead of `ws.accept()` to enable hibernation. The DO can be evicted from memory while the WebSocket stays connected at the Cloudflare runtime level. When a new MCP request or WebSocket message arrives, the DO is recreated and the message delivered.

### wrangler.toml
```toml
name = "vault-bridge-relay"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[observability]
enabled = true

[[durable_objects.bindings]]
name = "VAULT_SESSION"
class_name = "VaultSession"

[[kv_namespaces]]
binding = "TOKENS"
id = "<namespace-id>"

[[migrations]]
tag = "v1"
new_classes = ["VaultSession"]

[routes]
pattern = "vault-bridge.the-empyrean.com/*"
```

---

## Client App — Internal Design (Python)

Unchanged from original design. The client doesn't know or care whether the relay is a VPS or a Worker — it connects outbound via WebSocket and speaks the same JSON protocol.

### Distribution: pip package

```bash
pip install vault-bridge-client
vault-bridge setup     # Interactive wizard: vault path + token
vault-bridge start     # Connect to relay (foreground)
vault-bridge install-service  # Background auto-start (optional)
vault-bridge status    # Check connection
```

### File structure
```
client/src/vault_bridge_client/
├── __init__.py
├── __main__.py        # CLI entry point
├── cli.py             # setup, start, install-service, status
├── client.py          # WS connection, reconnect, dispatch
├── vault_ops.py       # File operations (port from v1)
└── config.py          # ~/.vault-bridge/.env loader
```

### vault_ops.py (port from v1 server.py)
```python
def list_directory(vault_path: Path, path: str) -> list[str]: ...
def read_file(vault_path: Path, path: str) -> str: ...
def write_file(vault_path: Path, path: str, content: str) -> str: ...
def search_files(vault_path: Path, query: str) -> list[str]: ...
```

All operations path-sanitised to prevent traversal outside vault root.

### Dependencies (minimal)
- `websockets` — WebSocket client
- `python-dotenv` — config loading
- `click` or `typer` — CLI framework

### Client WebSocket URL
Client connects to: `wss://vault-bridge.the-empyrean.com/ws?token=<token>`

---

## Deployment

### Prerequisites
- Cloudflare account (already have — the-empyrean.com is registered there)
- Workers Paid plan (~$5 USD/month)
- `wrangler` CLI installed

### Setup
```bash
# Login to Cloudflare
wrangler login

# Create KV namespace for tokens
wrangler kv namespace create VAULT_BRIDGE_TOKENS

# Deploy
wrangler deploy

# Add DNS route
# In Cloudflare dashboard: add route vault-bridge.the-empyrean.com/* → vault-bridge-relay worker
# Or via wrangler.toml routes config
```

### Deploying updates
```bash
wrangler deploy
# That's it. No SSH, no systemd, no git pull.
```

**Deploy impact:** All active client WebSockets disconnect briefly. Clients reconnect automatically in 2-4 seconds. Claude (HTTP requests) is unaffected.

---

## Security Model

- **Token = identity + auth.** UUID v4, transmitted only over HTTPS/WSS
- **Relay never stores vault content.** In-flight only — nothing written to Cloudflare storage
- **Client connects outbound.** No inbound ports on user's machine
- **Per-token scoping.** Compromised token exposes one vault only. Revoke via KV update
- **Path sanitisation.** Client validates all paths within vault root
- **Rate limiting.** Cloudflare native rate limiting available, add before public exposure
- **DO isolation.** Each user's DO is a separate instance — no cross-user data leakage

---

## Build Sequence for Claude Code

Each step is independently testable. No big-bang integration.

### Step 1 — `vault_ops.py` (Python)
Four file operations, tested against a local vault directory. No networking. Port directly from v1 `server.py` at `C:\Vault_bridge\server.py`. Add path sanitisation. Unit test each operation.

### Step 2 — Durable Object `VaultSession` (TypeScript)
WebSocket accept (hibernatable), connect handshake, message dispatch, `handleToolCall()` with timeout and pending map. Unit test with Cloudflare's `vitest-pool-workers`.

### Step 3 — Worker routing + auth (TypeScript)
Hono app with `/ws` (WebSocket upgrade → DO), `/mcp` (MCP request → DO), `/health`. Auth middleware: KV token lookup. Test locally with `wrangler dev`.

### Step 4 — `client.py` WebSocket loop (Python)
Connect to relay, send connect handshake, receive tool_call messages, dispatch to vault_ops, send results. Reconnect logic. Test against `wrangler dev` running locally.

### Step 5 — MCP wiring (TypeScript)
Wire MCP SDK tools to `VaultSession.handleToolCall()`. Test with Claude.ai pointed at `wrangler dev --remote` or deployed preview.

### Step 6 — End-to-end integration test
Worker deployed (preview or production) + client running locally. Verify all four tools work: list, read, write, search. Verify offline error. Verify reconnect after deploy.

### Step 7 — Token management
Script or CLI wrapping `wrangler kv` commands. Add/list/revoke tokens. Document the process.

### Step 8 — Client pip packaging
Package as `vault-bridge-client` with `pyproject.toml`. CLI entry points: `vault-bridge setup`, `vault-bridge start`, `vault-bridge status`, `vault-bridge install-service`. Test install from local build on Pip. Config stored in `~/.vault-bridge/`.

### Step 9 — Production deployment
Deploy Worker to production. DNS route `vault-bridge.the-empyrean.com`. Create production tokens (leigh + friend). End-to-end test on production.

### Step 10 — Onboarding & first users
One-page setup doc per platform (Windows, Mac). Onboard friend and Stacey. Gather feedback.

---

## Phase 3 Preview — Obsidian Plugin

Client app replaced by Obsidian community plugin (TypeScript). Same WebSocket protocol, same connect handshake. From the Worker/DO perspective, nothing changes.

---

## Future: Extended MCP Tools

Post-launch. The relay protocol is tool-agnostic — adding tools requires:
1. Implement operation in `vault_ops.py` (client)
2. Register tool in `mcp.ts` (Worker)
3. No protocol or infrastructure changes

Candidates: tags, frontmatter, backlinks, canvas, rename with link updates, vault stats.

---

## Cloudflare as Empyrean Infrastructure

The vault bridge relay is the first Empyrean service on Cloudflare, but the platform maps well to the broader ecosystem:

| Empyrean need | Cloudflare product |
|---|---|
| **Vault bridge relay** | Workers + Durable Objects |
| **Agora sandboxing** | Dynamic Workers (isolates) or Sandbox Containers |
| **Agent state/memory** | Durable Objects with SQLite |
| **Agent orchestration** | Workflows |
| **Storage** | R2 (objects), KV (config), D1 (SQL) |
| **Inter-agent comms** | Queues + WebSockets via DOs |
| **Code execution** | Dynamic Worker Loader (agent-generated code) |

Consolidating on Cloudflare avoids managing VPS infrastructure and keeps the stack coherent. Provision dedicated compute (VPS) only when a specific workload genuinely requires it.

---

## Reference: Existing v1 Implementation

Located on Pip at `C:\Vault_bridge\`:
- `server.py` — FastMCP server, four tools, bearer token auth
- Tunnel ID: `a399c711-730a-4fc7-a33d-18577206f913` → `vault.the-empyrean.com`
- **v1 stays live and untouched during v2 build.**

---

## What's Out of Scope (Phase 2)

- Obsidian plugin (Phase 3)
- Extended MCP tools beyond the base 4 (post-launch)
- Cloudflare Agents SDK integration (evaluate post-launch)
- Web dashboard / self-serve token generation
- OAuth / SSO
- Usage analytics or billing
- Multi-vault per user
- PyInstaller/tray app packaging
