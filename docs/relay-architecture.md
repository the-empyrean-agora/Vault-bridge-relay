# Vault Bridge Relay — Architecture Document

## Purpose
This document is the authoritative technical brief for building Vault Bridge v2: a multi-tenant, hosted relay that gives Claude permanent remote access to any user's Obsidian vault. It is written for Claude Code to implement from.

---

## Decisions Log

| Decision | Choice | Reasoning |
|---|---|---|
| v2 Domain | `vault-bridge.the-empyrean.com` | New subdomain. v1 stays live on `vault.the-empyrean.com` during build. Cutover when v2 is stable. |
| Migration strategy | Parallel run, then cutover | v1 (Pip direct MCP) untouched during build. v2 relay on separate subdomain. |
| Relay language | TypeScript (Hono + MCP SDK) | Future-proof for Workers migration, shared types with Phase 3 Obsidian plugin. |
| Client language | Python | vault_ops.py is near copy-paste from v1. Client replaced by Obsidian plugin in Phase 3. |
| Client distribution | `pip install` + setup wizard | Target users can handle a terminal command. PyInstaller deferred. |
| Hosting | Hetzner CAX11 (~$6 AUD/month) | Always-on, cheap, will host other Empyrean services. |
| Auth | Token in connector URL | Simple, proven, matches v1 pattern. |
| Extended MCP tools | Deferred to post-launch | Launch with 4 tools matching v1. Expand later. |

---

## Migration Strategy

v1 and v2 run in parallel. No disruption to Leigh's live setup.

| | v1 (current) | v2 (relay) |
|---|---|---|
| **Domain** | `vault.the-empyrean.com` | `vault-bridge.the-empyrean.com` |
| **Architecture** | FastMCP server on Pip → Cloudflare Tunnel | Relay on VPS ← WSS ← Client on Pip |
| **Status during build** | Live, untouched | Under development |

**Cutover (when v2 is stable):**
1. Leigh's Pip runs the Python client instead of FastMCP server
2. Connector URL updated to v2
3. v1 tunnel and FastMCP server decommissioned

---

## System Overview

```
┌─────────────┐         ┌──────────────────────────────────────┐         ┌──────────────────┐
│  Claude.ai  │         │           VPS (Hetzner)              │         │  User's Machine  │
│  (any       │         │  Cloudflare Tunnel                   │         │                  │
│  device)    │         │       ↓                              │         │  Client App      │
│             │──HTTPS──│  Relay Server (TypeScript/Hono)      │──WSS────│  (Python,        │
│  MCP        │  /mcp   │  ├─ MCP endpoint  (/mcp)            │         │   pip install)   │
│  connector  │         │  ├─ Client WS    (/ws)              │         │       ↓          │
│             │         │  ├─ Token registry                  │         │  Local Vault     │
│             │         │  └─ Request broker                  │         │  (filesystem)    │
└─────────────┘         └──────────────────────────────────────┘         └──────────────────┘
```

**Data flow:**
1. Claude sends MCP request to `https://vault-bridge.the-empyrean.com/mcp?token=<user_token>`
2. Relay authenticates token, looks up live WebSocket for that token
3. Relay sends tool call as JSON over WebSocket to client
4. Client executes against local vault, sends result back
5. Relay returns result to Claude via MCP response

**If client is offline:** `"Client not connected. Ensure Vault Bridge is running on your machine."`

---

## MCP Interface

### Launch Tools (v1 parity)

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

---

## WebSocket Protocol

**Tool call (Relay → Client):**
```json
{ "type": "tool_call", "request_id": "<uuid>", "tool": "read_file", "params": { "path": "..." } }
```

**Result (Client → Relay):**
```json
{ "type": "tool_result", "request_id": "<uuid>", "result": "...", "error": null }
```

**Client connect handshake:**
```json
{ "type": "connect", "token": "...", "vault_path_hint": "~/Documents/MyVault", "client_version": "0.1.0", "platform": "windows" }
```

**Heartbeat:** `{ "type": "ping" }` / `{ "type": "pong" }` every 30s. Drop client if no pong within 60s. Client reconnects with exponential backoff (2s → 60s cap).

---

## Token Model

UUID v4 per user. Included in MCP connector URL: `https://vault-bridge.the-empyrean.com/mcp?token=<token>`

**Registry:** `tokens.json` on disk, `Map<token, ClientSession>` in memory.

```typescript
interface ClientSession {
  token: string;
  label: string;
  ws: WebSocket | null;
  connectedAt: Date | null;
  vaultPathHint: string;
  platform: string;
}
```

Tokens provisioned via CLI on VPS — not self-serve in Phase 2.

---

## Relay Server (TypeScript)

**Stack:** Node.js LTS, Hono, @modelcontextprotocol/sdk, ws, dotenv, zod

```
relay/src/
├── index.ts        # Hono app, startup
├── broker.ts       # Token registry, WS management, request routing
├── mcp.ts          # MCP tool definitions → broker
├── ws-handler.ts   # /ws client connection lifecycle
├── tokens.ts       # Load/save/validate tokens.json
├── models.ts       # TypeScript interfaces
└── config.ts       # Settings from .env
```

---

## Client App (Python)

**Distribution:** `pip install vault-bridge-client`

```bash
vault-bridge setup    # Interactive wizard: vault path + token
vault-bridge start    # Connect to relay (foreground)
vault-bridge install-service  # Background auto-start
vault-bridge status   # Check connection
```

```
client/src/vault_bridge_client/
├── __init__.py
├── __main__.py     # CLI entry point
├── cli.py          # Commands
├── client.py       # WS connection, reconnect, dispatch
├── vault_ops.py    # File operations (port from v1)
└── config.py       # ~/.vault-bridge/.env loader
```

**Dependencies:** websockets, python-dotenv, click/typer

---

## Token Manager CLI

```bash
npx tsx tokens.ts add --label "stacey"    # → Token + connector URL
npx tsx tokens.ts list                     # → Status table
npx tsx tokens.ts revoke --label "stacey"  # → Revoke + disconnect
```

---

## Hosting

- **VPS:** Hetzner CAX11, Ubuntu 24.04, `vault-bridge.the-empyrean.com`
- **Layout:** `/opt/vaultbridge/relay/`, `tokens.json`, `.env`, `logs/`
- **Tunnel:** Named tunnel `vault-bridge-vps`, ingress to `localhost:8080`
- **systemd:** `vaultbridge-relay.service` + `vaultbridge-tunnel.service`

---

## Security

- Token = identity + auth (UUID v4, HTTPS/WSS only)
- Relay never stores vault content (in-flight only)
- Client connects outbound (no inbound ports)
- Per-token scoping (compromised token = one vault)
- Path sanitisation (client validates vault root boundary)
- Rate limiting (per-token, added before public exposure)

---

## Build Sequence

1. `vault_ops.py` — four file ops, unit tested, no networking
2. `broker.ts` — token registry, session map, handleToolCall
3. `ws-handler.ts` + `tokens.ts` — WS endpoint, heartbeat, token persistence
4. `client.py` — WS loop, reconnect, dispatch to vault_ops
5. `mcp.ts` — wire MCP SDK to broker, auth middleware
6. End-to-end local test — relay + client + Claude Desktop
7. Token manager CLI — add/list/revoke
8. Client pip packaging — pyproject.toml, CLI entry points
9. VPS deployment — Hetzner, systemd, Cloudflare Tunnel
10. Onboarding — setup docs, first users

---

## v1 Reference

Located at `C:\Vault_bridge\` on Pip:
- `server.py` — FastMCP server, four tools, bearer token auth
- Tunnel ID: `a399c711-730a-4fc7-a33d-18577206f913` → `vault.the-empyrean.com`
- **v1 stays live and untouched during v2 build.**
