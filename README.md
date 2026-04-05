# Vault Bridge Relay

A multi-tenant relay that gives [Claude.ai](https://claude.ai) persistent remote access to [Obsidian](https://obsidian.md) vaults via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

## How It Works

```
Claude.ai  ──HTTPS/MCP──>  Relay (VPS)  ──WSS──>  Client (your machine)  ──>  Obsidian Vault
```

The relay is a stateless broker. Claude sends MCP tool requests (read file, write file, search, list directory) to the relay. The relay routes them over WebSocket to a lightweight Python client running on your machine. The client reads/writes your local vault and returns results. Vault content never persists on the relay.

## Components

| Component | Language | Description |
|---|---|---|
| **Relay** | TypeScript (Hono) | Hosted on VPS, handles MCP ↔ WebSocket routing |
| **Client** | Python (pip) | Runs on your machine, connects outbound to relay |
| **Token CLI** | TypeScript | Admin tool for managing user tokens |

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
