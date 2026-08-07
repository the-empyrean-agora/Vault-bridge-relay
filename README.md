# Vault Bridge Relay

A self-hostable [MCP](https://modelcontextprotocol.io/) server on Cloudflare that gives Claude persistent remote access to [Obsidian](https://obsidian.md) vaults — read, write, edit, search, backlinks, tags — from claude.ai, Claude Desktop, Claude Code, and mobile.

> **Support position:** this is a personal project, shared as-is under the [MIT licence](LICENSE). There is no support commitment. Issues and PRs are welcome but not guaranteed a response.

## How It Works

One deployment is multi-tenant: a single Worker + R2 bucket + KV namespace serves multiple users, each holding a token that maps to their own private namespace.

**R2 mode (primary):** the [Obsidian plugin](https://github.com/the-empyrean-agora/vault-bridge-plugin) syncs the local vault to R2 while Obsidian is open; Claude reads and writes through the Worker. The user's machine can be off.

```
Claude  ──HTTPS/MCP──>  Worker  ──>  R2 Bucket  ◀──sync──  Obsidian Plugin
```

**Relay mode (legacy):** a stateless broker routes MCP calls over WebSocket to a Python client on an always-on machine; vault content never persists on Cloudflare. Still works, no longer the recommended path.

## Privacy — Read This First

In R2 mode your notes are stored in the deployment operator's Cloudflare R2 bucket, and the operator has bucket-level access to all users' content. If you self-host, that operator is you. Nothing is sent anywhere else — no telemetry, no third-party services beyond Cloudflare and the Claude client you connect. See [SECURITY.md](SECURITY.md) for the full trust model.

## Deploy Your Own

Prerequisites: a Cloudflare account on the **Workers Paid** plan (~US$5/mo — Durable Objects require it), Node.js LTS, and a domain in your account if you want a custom hostname (the free `*.workers.dev` hostname works fine without one).

```bash
cd relay
npm ci
npx wrangler login
npx wrangler kv namespace create VAULT_BRIDGE_TOKENS   # note the id it prints
npx wrangler r2 bucket create vault-bridge
cp wrangler.toml.example wrangler.toml                  # fill in account ID, KV id, bucket, optional route
npx wrangler deploy
```

Create a token per user:

```bash
cd relay
VAULT_BRIDGE_KV_NAMESPACE_ID=<kv-id> VAULT_BRIDGE_BASE_URL=https://<your-worker-hostname> \
  npx tsx ../tokens-cli/tokens.ts add "alice" --r2
```

Each user then installs the Obsidian plugin, sets the relay URL + token in its settings, runs the initial upload, and adds `https://<your-worker-hostname>/mcp` as a Claude connector (authentication happens on the OAuth consent page — no token in the URL).

> **One token per vault. Always.** The token IS the vault's identity in the cloud — it maps directly to a storage namespace. The same token pasted into two different Obsidian vaults will merge their contents on first sync.

Full step-by-step guide with a verification after every step: [docs/DEPLOY.md](docs/DEPLOY.md). It's written for humans and works well handed to a coding agent.

## MCP Tools

18 tools, identical across relay and R2 modes.

**Session**

| Tool | Description |
|---|---|
| `vault_begin_session()` | Return the vault's orientation file (rules/conventions). Call first. |

**Read & navigate**

| Tool | Description |
|---|---|
| `vault_list_directory(path)` | List vault directory contents |
| `vault_read_file(path)` | Read a full file |
| `vault_read_section(path, heading)` | Read a single section of a note |
| `vault_read_frontmatter(path)` | Read just a note's YAML frontmatter |
| `vault_search_files(query)` | Search filenames, content, and tags (up to 50 results) |
| `vault_get_recent_files(days, limit)` | Recently modified files |
| `vault_get_backlinks(path)` | Files linking TO a note |
| `vault_get_outgoing_links(path)` | Notes a file links OUT to |
| `vault_list_tags()` | All tags with usage counts |
| `vault_get_files_by_frontmatter(query)` | Notes matching one frontmatter condition |
| `vault_resolve_wikilink(link)` | `[[name]]` → the actual file path(s) |

**Write & edit**

| Tool | Description |
|---|---|
| `vault_write_file(path, content)` | Create or overwrite a file |
| `vault_create_file(path, content)` | Create only — errors if the file exists |
| `vault_edit_range(path, old_string, new_string, replace_all?)` | Surgical exact-span replace |
| `vault_append_to_section(path, heading, content, position?)` | Insert content under a heading |
| `vault_move_file(from, to)` | Move/rename a file — metadata-only, never overwrites |
| `vault_delete_file(path)` | Delete a file |

## Components

| Component | Language | Description |
|---|---|---|
| **Worker + DOs** | TypeScript (Hono) | Cloudflare edge — MCP endpoint, auth, sync API, per-user vault index |
| **Obsidian plugin** | TypeScript | [Separate repo](https://github.com/the-empyrean-agora/vault-bridge-plugin) — syncs local vault ↔ R2 |
| **Token CLI** | TypeScript (tsx) | Operator tool — add/list/revoke tokens via Workers KV |
| **Python client** | Python (pip) | Legacy relay mode — connects outbound from an always-on machine |

## License

MIT — see [LICENSE](LICENSE). Vulnerability reports: see [SECURITY.md](SECURITY.md). Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
