# Vault Bridge Client

Connect your Obsidian vault to the [Vault Bridge](https://vault-bridge.the-empyrean.com) relay so Claude.ai can read, write, and search your notes.

## Install

```bash
pip install vault-bridge-client
```

## Setup

```bash
vault-bridge setup
```

This walks you through configuring:
- Path to your Obsidian vault
- Your access token (provided by your admin)
- Relay URL (default: `wss://vault-bridge.the-empyrean.com/ws`)

Config is saved to `~/.vault-bridge/.env`.

## Usage

```bash
vault-bridge start       # Connect to relay (foreground)
vault-bridge status      # Check config and vault info
vault-bridge install-service  # Auto-start on login (Windows/Linux)
```

## How It Works

The client connects outbound to the relay via WebSocket. When Claude invokes a tool (read, write, list, search), the relay forwards the request over the WebSocket to your client, which executes it against your local vault and returns the result. No inbound ports needed — works behind NAT.

## Requirements

- Python 3.10+
- An Obsidian vault on your local filesystem
- A Vault Bridge token
