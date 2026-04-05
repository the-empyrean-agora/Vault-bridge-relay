# CLAUDE.md — Vault Bridge Relay

## What This Is
Vault Bridge v2: a multi-tenant relay that gives Claude.ai persistent remote access to any user's Obsidian vault. Claude sends MCP requests to a Cloudflare Worker, which routes them via Durable Object to a lightweight Python client on the user's machine. The client reads/writes the local vault and returns results. Vault content never persists on the relay.

## Status
**Relay (Steps 1–10): Complete. Deployed to production.**

- Relay live at `vault-bridge.the-empyrean.com`
- All four MCP tools working end-to-end
- 36 tests passing (unit, integration, e2e)

**R2-backed mode: Planned.** See `docs/r2-architecture.md`.

## Architecture
Two modes, same MCP interface, same domain:

### Relay mode (for always-on machines like Pip)
- **Relay** (TypeScript, Worker + Durable Object) — runs on Cloudflare edge, stateless broker
- **Client** (Python, pip package) — runs on user's machine, connects outbound via WSS
```
Claude.ai  ──HTTPS/MCP──>  Worker  ──>  Durable Object  ──WSS──>  Client  ──>  Local Vault
```
Full spec: `docs/relay-architecture.md`

### R2 mode (for friends/family — machine can be off)
- **Worker** (TypeScript) — reads/writes R2 directly as MCP server
- **Obsidian Plugin** (TypeScript) — syncs local vault ↔ R2 while Obsidian is open
```
Claude.ai  ──HTTPS/MCP──>  Worker  ──>  R2 Bucket  ◀──sync──  Obsidian Plugin
```
Full spec: `docs/r2-architecture.md`

## Repo Structure
```
vault-bridge-relay/
├── relay/                    # Cloudflare Worker + Durable Object
│   ├── src/
│   │   ├── index.ts          # Worker entry point, Hono routing
│   │   ├── vault-session.ts  # Durable Object — WS management, request brokering
│   │   ├── mcp.ts            # MCP JSON-RPC handler, tool definitions
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
│   │       ├── vault_ops.py  # File operations (ported from v1)
│   │       └── config.py     # ~/.vault-bridge/.env loader
│   ├── tests/
│   │   ├── test_vault_ops.py # 23 unit tests for file operations
│   │   ├── test_client.py    # 5 integration tests (client ↔ mock relay)
│   │   └── test_e2e.py       # 8 e2e tests (MCP HTTP → relay → WS → client → vault)
│   ├── pyproject.toml
│   └── README.md
├── tokens-cli/               # Token manager (TypeScript, run via tsx)
│   └── tokens.ts
├── docs/
│   ├── relay-architecture.md # Relay mode technical spec
│   ├── r2-architecture.md    # R2 mode technical spec (friends/family)
│   ├── setup-windows.md      # User setup guide (Windows)
│   └── setup-mac.md          # User setup guide (Mac)
├── CLAUDE.md                 # This file
└── README.md
```

## Key Constraints
- **v1 must not be touched.** Leigh's live vault-bridge at `vault.the-empyrean.com` stays running. v2 uses `vault-bridge.the-empyrean.com`.
- **MCP interface is identical across all modes.** Four tools: `list_directory`, `read_file`, `write_file`, `search_files`. Same signatures, same behaviour. Claude doesn't know which backend is serving.
- **Relay is stateless.** Vault content passes through in-flight only. Never written to Cloudflare storage.
- **R2 mode stores vault content.** Files persist in R2 bucket under user-prefixed paths. Synced from local vault via Obsidian plugin.
- **Client connects outbound.** No inbound ports on user's machine. Works behind NAT.
- **Path sanitisation required.** Both relay client and R2 Worker must validate paths stay within vault root / user prefix.

## Production Details
- **Worker URL:** `vault-bridge-relay.leighflorescu.workers.dev`
- **Custom domain:** `vault-bridge.the-empyrean.com`
- **Account:** `leighflorescu@gmail.com` (Cloudflare account ID in wrangler.toml)
- **KV namespace:** `VAULT_BRIDGE_TOKENS` (ID in wrangler.toml)
- **Token management:** Run from `relay/` directory: `VAULT_BRIDGE_KV_NAMESPACE_ID=<id> npx tsx ../tokens-cli/tokens.ts <command>`

## v1 Reference Implementation
Located on this machine at `C:\Vault_bridge\server.py`. The vault_ops functions were ported from there. Auth pattern (token in query param or Bearer header) is preserved.

## Tech Stack
- **Relay mode:** Cloudflare Workers, Durable Objects, Hono, zod
- **R2 mode:** Cloudflare Workers, R2, Obsidian Plugin API
- **Storage:** Workers KV (token registry), R2 (vault content in R2 mode)
- **Relay client:** Python 3.10+, websockets, python-dotenv, click
- **Deploy:** wrangler CLI

## Testing
Run all client tests: `cd client && python -m pytest tests/ -v`
- `test_vault_ops.py` — 23 unit tests for file operations + path sanitisation
- `test_client.py` — 5 integration tests (client ↔ mock WS relay)
- `test_e2e.py` — 8 e2e tests (full MCP HTTP → relay → WS → client → vault flow)

Relay type check: `cd relay && npx tsc --noEmit`
