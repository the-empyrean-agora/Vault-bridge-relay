# CLAUDE.md — Vault Bridge Relay

## What This Is
Vault Bridge v2: a multi-tenant relay that gives Claude.ai persistent remote access to any user's Obsidian vault. Claude sends MCP requests to the relay (hosted VPS), the relay routes them over WebSocket to a lightweight client running on the user's machine, the client reads/writes the local vault and returns results.

## Architecture
Two components, two languages:
- **Relay** (TypeScript, Hono + MCP SDK) — runs on Hetzner VPS, stateless broker
- **Client** (Python, pip package) — runs on user's machine, connects outbound via WSS

Full architecture spec: `docs/relay-architecture.md` in this repo.

## Repo Structure
```
vault-bridge-relay/
├── relay/                    # TypeScript relay server
│   ├── src/
│   │   ├── index.ts          # Hono app, startup, route registration
│   │   ├── broker.ts         # Token registry, WS management, request routing
│   │   ├── mcp.ts            # MCP tool definitions, wired to broker
│   │   ├── ws-handler.ts     # /ws endpoint — client connection lifecycle
│   │   ├── tokens.ts         # Load/save/validate tokens.json
│   │   ├── models.ts         # TypeScript interfaces for WS messages
│   │   └── config.ts         # Settings from .env
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
├── tokens-cli/               # Token manager (TypeScript, run via tsx on VPS)
│   └── tokens.ts
├── deploy/                   # systemd units, Cloudflare tunnel config
│   ├── vaultbridge-relay.service
│   ├── vaultbridge-tunnel.service
│   └── tunnel-config.yml
├── docs/                     # Architecture and reference docs
│   └── relay-architecture.md
├── CLAUDE.md                 # This file
└── README.md
```

## Build Sequence
Follow the 10-step sequence in `docs/relay-architecture.md`. Each step is independently testable. Do NOT skip ahead or merge steps.

1. `vault_ops.py` — four file ops, unit tested, no networking
2. `broker.ts` — token registry, session map, handleToolCall with timeout
3. `ws-handler.ts` + `tokens.ts` — WS endpoint, heartbeat, token persistence
4. `client.py` — WS loop, reconnect, dispatch to vault_ops
5. `mcp.ts` — wire MCP SDK to broker, auth middleware
6. End-to-end local test — relay + client + Claude Desktop
7. Token manager CLI — add/list/revoke
8. Client pip packaging — pyproject.toml, CLI entry points, README
9. VPS deployment — Hetzner, systemd, Cloudflare Tunnel
10. Onboarding — setup docs, first users

## Key Constraints
- **v1 must not be touched.** Leigh's live vault-bridge at `vault.the-empyrean.com` stays running. v2 uses `vault-bridge.the-empyrean.com` (separate tunnel, separate subdomain).
- **MCP interface matches v1 exactly.** Four tools: `list_directory`, `read_file`, `write_file`, `search_files`. Same signatures, same behaviour.
- **Relay is stateless.** Vault content passes through in-flight only. Never written to disk on VPS.
- **Client connects outbound.** No inbound ports on user's machine. Works behind NAT.
- **Path sanitisation required.** Client must validate all paths stay within vault root.

## v1 Reference Implementation
Located on this machine at `C:\Vault_bridge\server.py`. The vault_ops functions should be ported from there. Auth pattern (token in query param or Bearer header) should be preserved.

## Tech Stack
- **Relay:** Node.js LTS, Hono, @modelcontextprotocol/sdk, ws, dotenv, zod
- **Client:** Python 3.10+, websockets, python-dotenv, click/typer
- **Infra:** Hetzner CAX11 (ARM), Ubuntu 24.04, systemd, cloudflared

## Testing
- Unit tests for vault_ops (Python) and broker (TypeScript)
- Integration test: mock client ↔ relay
- End-to-end: real client + relay + Claude Desktop locally before VPS deployment
