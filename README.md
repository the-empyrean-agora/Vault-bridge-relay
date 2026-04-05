# Vault Bridge Relay

A multi-tenant relay that gives [Claude.ai](https://claude.ai) persistent remote access to [Obsidian](https://obsidian.md) vaults via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

## How It Works

```
Claude.ai  ──HTTPS/MCP──>  Cloudflare Worker  ──>  Durable Object (per user)  ──WSS──>  Client (your machine)  ──>  Obsidian Vault
```

The relay is a stateless broker running on Cloudflare's edge. Claude sends MCP tool requests (read file, write file, search, list directory) to a Worker. The Worker routes them via Durable Object over WebSocket to a lightweight Python client on your machine. The client reads/writes your local vault and returns results. Vault content never persists on the relay.

Durable Objects hibernate when idle — your client stays connected while you pay nothing.

## Components

| Component | Language | Description |
|---|---|---|
| **Worker + DO** | TypeScript (Hono) | Cloudflare edge, handles MCP ↔ WebSocket routing |
| **Client** | Python (pip) | Runs on your machine, connects outbound to relay |

## Quick Start (Client)

```bash
pip install vault-bridge-client
vault-bridge setup     # Configure vault path + token
vault-bridge start     # Connect to relay
```

## Architecture

See [`docs/relay-architecture.md`](docs/relay-architecture.md) for the full technical spec.

## License

MIT
