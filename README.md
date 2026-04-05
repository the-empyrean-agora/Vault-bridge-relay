# Vault Bridge Relay

A multi-tenant relay that gives [Claude.ai](https://claude.ai) persistent remote access to [Obsidian](https://obsidian.md) vaults via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

## How It Works

```
Claude.ai  ──HTTPS/MCP──>  Cloudflare Worker  ──>  Durable Object (per user)  ──WSS──>  Client (your machine)  ──>  Obsidian Vault
```

The relay is a stateless broker on Cloudflare's edge. Claude sends MCP tool requests (read, write, search, list) to a Worker. The Worker routes them via Durable Object over WebSocket to a lightweight Python client on your machine. The client reads/writes your local vault and returns results. Vault content never persists on the relay.

## User Setup

You need: **Python 3.10+**, an **Obsidian vault** on your machine, and a **token** (your admin will give you one).

See the setup guide for your platform:
- [Windows setup](docs/setup-windows.md)
- [Mac setup](docs/setup-mac.md)

**Quick version:**

```bash
pip install vault-bridge-client
vault-bridge setup     # Paste your token, point to your vault
vault-bridge start     # Connect — leave this running
```

Then add the MCP connector URL to Claude.ai:
1. Go to [claude.ai](https://claude.ai) > Settings > Integrations
2. Add connector: `https://vault-bridge.the-empyrean.com/mcp?token=YOUR_TOKEN`
3. Start a conversation and use your vault

## Admin Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS) with `wrangler` CLI
- Cloudflare account with Workers enabled
- Domain managed by Cloudflare (for custom domain routing)

### Deploy the relay

```bash
cd relay
npm install
npx wrangler login
npx wrangler deploy
```

### Create tokens for users

```bash
cd relay
VAULT_BRIDGE_KV_NAMESPACE_ID=<your-kv-id> npx tsx ../tokens-cli/tokens.ts add "username"
```

This prints the MCP URL and WS URL to give to the user.

### Manage tokens

```bash
VAULT_BRIDGE_KV_NAMESPACE_ID=<id> npx tsx ../tokens-cli/tokens.ts list
VAULT_BRIDGE_KV_NAMESPACE_ID=<id> npx tsx ../tokens-cli/tokens.ts revoke <token>
```

## Components

| Component | Language | Description |
|---|---|---|
| **Worker + DO** | TypeScript (Hono) | Cloudflare edge — MCP endpoint, auth, WS routing |
| **Client** | Python (pip) | User's machine — connects outbound, executes vault ops |
| **Token CLI** | TypeScript (tsx) | Admin tool — add/list/revoke tokens via Workers KV |

## MCP Tools

Four tools, matching the v1 Vault Bridge interface:

| Tool | Description |
|---|---|
| `list_directory(path)` | List vault directory contents |
| `read_file(path)` | Read a file from the vault |
| `write_file(path, content)` | Create or overwrite a file |
| `search_files(query)` | Search filenames and content (up to 50 results) |

## Architecture

See [`docs/relay-architecture.md`](docs/relay-architecture.md) for the full technical spec.

## License

MIT
