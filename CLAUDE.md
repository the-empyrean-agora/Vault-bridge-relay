# CLAUDE.md — Vault Bridge Relay

## What This Is
Vault Bridge v2: a multi-tenant relay that gives Claude.ai persistent remote access to any user's Obsidian vault. Claude sends MCP requests to a Cloudflare Worker, which routes them via Durable Object to a lightweight Python client on the user's machine. The client reads/writes the local vault and returns results. Vault content never persists on the relay.

## Architecture
Two components, two languages, one platform:
- **Relay** (TypeScript, Worker + Durable Object) — runs on Cloudflare edge, stateless broker
- **Client** (Python, pip package) — runs on user's machine, connects outbound via WSS

```
Claude.ai  ──HTTPS/MCP──>  Worker (edge)  ──routes by token──>  Durable Object (per user)  ──WSS──>  Client
```

Full architecture spec: `docs/relay-architecture.md`

## Repo Structure
```
vault-bridge-relay/
├── relay/                    # Cloudflare Worker + Durable Object
│   ├── src/
│   │   ├── index.ts          # Worker entry point, Hono routing
│   │   ├── vault-session.ts  # Durable Object — WS management, request brokering
│   │   ├── mcp.ts            # MCP tool definitions, wired to DO
│   │   ├── auth.ts           # Token validation middleware (KV lookup)
│   │   ├── models.ts         # TypeScript interfaces for WS messages
│   │   └── config.ts         # Environment bindings type definitions
│   ├── wrangler.toml         # Cloudflare config: DO bindings, KV namespace, routes
│   ├── package.json
│   └── tsconfig.json
├── client/                   # Python client (pip package: vault-bridge-client)
│   ├── src/
│   │   └── vault_bridge_client/
│   │       ├── __init__.py
│   │       ├── __main__.py
│   │       ├── cli.py        # setup, start, install-service, status
│   │       ├── client.py     # WS connection, reconnect, dispatch
│   │       ├── vault_ops.py  # File operations (port from v1)
│   │       └── config.py     # ~/.vault-bridge/.env loader
│   ├── pyproject.toml
│   └── README.md
├── docs/
│   └── relay-architecture.md
├── CLAUDE.md                 # This file
└── README.md
```

## Build Sequence
Follow the 10-step sequence in `docs/relay-architecture.md`. Each step is independently testable. Do NOT skip ahead or merge steps.

1. `vault_ops.py` — four file ops, unit tested, no networking
2. `VaultSession` DO — WebSocket accept (hibernatable), handleToolCall, pending map
3. Worker routing + auth — Hono app, `/ws`, `/mcp`, `/health`, KV token lookup
4. `client.py` — WS loop, reconnect, dispatch to vault_ops
5. MCP wiring — wire MCP SDK to DO's handleToolCall
6. End-to-end test — deployed Worker + local client
7. Token management — wrangler kv wrapper script
8. Client pip packaging — pyproject.toml, CLI entry points
9. Production deployment — DNS route, production tokens
10. Onboarding — setup docs, first users

## Key Constraints
- **v1 must not be touched.** Leigh's live vault-bridge at `vault.the-empyrean.com` stays running. v2 uses `vault-bridge.the-empyrean.com`.
- **MCP interface matches v1 exactly.** Four tools: `list_directory`, `read_file`, `write_file`, `search_files`. Same signatures, same behaviour.
- **Relay is stateless.** Vault content passes through in-flight only. Never written to Cloudflare storage.
- **Client connects outbound.** No inbound ports on user's machine. Works behind NAT.
- **Path sanitisation required.** Client must validate all paths stay within vault root.
- **Hibernatable WebSockets.** Use `ctx.acceptWebSocket()` not `ws.accept()` so the DO can hibernate while keeping client connected.

## v1 Reference Implementation
Located on this machine at `C:\Vault_bridge\server.py`. The vault_ops functions should be ported from there. Auth pattern (token in query param or Bearer header) should be preserved.

## Tech Stack
- **Relay:** Cloudflare Workers, Durable Objects, Hono, @modelcontextprotocol/sdk, zod
- **Storage:** Workers KV (token registry)
- **Client:** Python 3.10+, websockets, python-dotenv, click/typer
- **Deploy:** wrangler CLI

## Testing
- Unit tests for vault_ops (Python) and VaultSession DO (TypeScript, vitest-pool-workers)
- Integration test: client ↔ `wrangler dev`
- End-to-end: deployed Worker + local client before production DNS cutover
