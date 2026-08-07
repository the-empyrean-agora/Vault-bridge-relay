# CLAUDE.md — Vault Bridge Relay

## What This Is
Vault Bridge: a self-hostable MCP server on Cloudflare that gives Claude persistent remote access to Obsidian vaults. One deployment is multi-tenant — a single Worker + R2 bucket + KV namespace serves many users; each user holds a token that maps to their own private namespace.

Two modes share the same Worker, hostname, and MCP tool surface. The token's KV record (`mode`) decides which serves a request.

### R2 mode (primary — the mode in active use)
The vault lives in R2. The Obsidian plugin (separate repo) syncs the local vault ↔ R2 while Obsidian is open; the Worker serves MCP reads/writes directly from R2, so the user's machine can be off.
```
Claude  ──HTTPS/MCP──>  Worker  ──>  R2 Bucket  ◀──sync──  Obsidian Plugin
```
Plugin repo: https://github.com/the-empyrean-agora/vault-bridge-plugin (distributed via BRAT)

### Relay mode (legacy — no longer in active use; code and tests kept for parity)
Stateless broker. The Worker routes MCP calls via a per-token Durable Object over WebSocket to a Python client running on an always-on machine. Vault content passes through in-flight only and never persists on Cloudflare.
```
Claude  ──HTTPS/MCP──>  Worker  ──>  Durable Object  ──WSS──>  Python client  ──>  Local vault
```

## Status
- **18 MCP tools**, identical signatures in both modes: `vault_begin_session`, `vault_list_directory`, `vault_read_file`, `vault_read_section`, `vault_read_frontmatter`, `vault_write_file`, `vault_create_file`, `vault_edit_range`, `vault_append_to_section`, `vault_delete_file`, `vault_move_file`, `vault_search_files`, `vault_get_backlinks`, `vault_get_outgoing_links`, `vault_list_tags`, `vault_get_recent_files`, `vault_get_files_by_frontmatter`, `vault_resolve_wikilink`
- OAuth 2.1 layer (dynamic client registration + PKCE) so the MCP endpoint can be added as a Claude connector without a token in the URL
- Relay (R2 mode) tests: `vitest` in `relay/test/` + `tsc --noEmit`
- Client (relay mode) tests: pytest in `client/tests/` (103 tests)

## Repo Structure
```
vault-bridge-relay/
├── relay/                    # Cloudflare Worker + Durable Objects
│   ├── src/
│   │   ├── index.ts          # Worker entry point, Hono routing
│   │   ├── vault-session.ts  # Relay-mode DO — WS management, request brokering
│   │   ├── index-do.ts       # R2-mode per-user vault-index DO (SQLite)
│   │   ├── index-store.ts    # IndexStore interface + DO-backed implementation
│   │   ├── r2-ops.ts         # R2-mode vault operations
│   │   ├── mcp.ts            # MCP JSON-RPC handler, tool definitions
│   │   ├── oauth.ts          # OAuth 2.1 for Claude connectors (DCR, consent, PKCE)
│   │   ├── secrets.ts        # Per-user secrets endpoint
│   │   ├── auth.ts           # Token validation middleware (KV lookup)
│   │   ├── models.ts         # TypeScript interfaces for WS messages
│   │   └── config.ts         # Environment bindings type definitions
│   ├── test/                 # vitest suites (R2 mode)
│   ├── wrangler.toml.example # Copy to wrangler.toml (gitignored) and fill in
│   ├── package.json
│   └── tsconfig.json
├── client/                   # Python client for relay mode (legacy, pip package)
├── tokens-cli/               # Token manager CLI (TypeScript, run via tsx)
├── CLAUDE.md                 # This file
└── README.md
```

## Key Constraints
- **The MCP interface is identical across modes.** Adding or changing a tool touches the Worker, the Python client (parity), and both test suites — never just one side.
- **R2 mode: the vault index is owned by `VaultIndexDO`** (per-user SQLite Durable Object, keyed by prefix). The R2 blob `_vault-bridge-index.json` is a debounced recovery snapshot only. Clients never write the index.
- **Concurrency guards are load-bearing.** `/sync/files/*` honours `If-Match`/`If-None-Match` against the index content-hash (412 on mismatch); `vault_write_file` does CAS on the R2 etag; MCP mutations stamp a 25 s write-lease surfaced to the plugin as `X-Remote-Write-Active`. Don't weaken any of these — they close real data-loss races.
- **`compatibility_date` stays `2024-12-01`.** Later dates change WebSocket close/binary semantics relay mode depends on.
- **One token per vault. Always.** The token IS the vault's identity — it maps directly to an R2 prefix. The same token pasted into two different Obsidian vaults merges them bidirectionally on first sync.
- **Relay mode is stateless; R2 mode stores vault content** under user-prefixed keys in the operator's bucket.
- **Instance config is untracked.** Copy `relay/wrangler.toml.example` → `relay/wrangler.toml` and fill in your account ID, KV namespace ID, bucket, and optional route. Operators may keep an untracked `LOCAL-ADMIN.md` for account details — never commit it.

## Multi-Tenancy Model
- The token (a UUID) is the KV key; the value is `{ label, created, active, mode?: "relay"|"r2", prefix? }`.
- R2 keys are `${prefix}/${path}`; each user gets their own index DO via `idFromName(prefix)`; keys starting `_vault-bridge-` are internal and filtered from listings.
- Tokens are minted by the operator with `tokens-cli` — there is no self-service signup.

## Deploying and Operating
- Deploy: `cd relay && npm ci && npx wrangler deploy` (migrations create both DO classes on first deploy). Requires the Workers Paid plan (Durable Objects).
- Mint a token: `VAULT_BRIDGE_KV_NAMESPACE_ID=<id> npx tsx ../tokens-cli/tokens.ts add "name" --r2` — set `VAULT_BRIDGE_BASE_URL` to your Worker origin so the printed URLs are correct.
- **Agent guardrail:** if you are deploying this into a Cloudflare account you do not own, create or modify only the resources the operator has named (one Worker, one KV namespace, one R2 bucket, optionally one route). Stop and ask before touching DNS or anything that could incur cost.

## Tech Stack
- **Worker:** Cloudflare Workers, Durable Objects, R2, Workers KV, Hono, zod
- **Python client (relay mode):** Python 3.10+, websockets, python-dotenv, click
- **Deploy:** wrangler CLI

## Testing
- Relay: `cd relay && npx tsc --noEmit && npx vitest run`
- Client: `cd client && python -m pytest tests/ -v`
