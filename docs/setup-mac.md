# Vault Bridge Client — Mac Setup

## What you need

- **Python 3.10+** — comes with macOS or install via [Homebrew](https://brew.sh): `brew install python`
- **Your Obsidian vault** — know the folder path (e.g. `~/Documents/MyVault`)
- **Your token** — your admin will give you this (a UUID like `abc12345-...`)

## Step 1: Install

Open Terminal and run:

```
pip3 install vault-bridge-client
```

## Step 2: Configure

```
vault-bridge setup
```

It will ask for:
- **Path to your Obsidian vault** — e.g. `~/Documents/MyVault` (tilde is expanded automatically)
- **Your token** — paste the token your admin gave you
- **Relay URL** — press Enter to accept the default

Config is saved to `~/.vault-bridge/.env`.

## Step 3: Connect

```
vault-bridge start
```

You should see:
```
Connecting to relay...
Connected. Sending handshake...
Handshake accepted. Listening for tool calls.
```

Leave this terminal open. When Claude uses your vault, you'll see tool calls logged here.

## Step 4: Add to Claude.ai

1. Go to [claude.ai](https://claude.ai)
2. Click your profile icon > **Settings** > **Integrations**
3. Click **Add integration** > **MCP connector**
4. Paste your MCP URL: `https://vault-bridge.the-empyrean.com/mcp?token=YOUR_TOKEN`
5. Start a new conversation — Claude can now read and search your vault

## Auto-start on login (optional)

```
vault-bridge install-service
```

This creates a systemd user service. Enable it with:

```
systemctl --user daemon-reload
systemctl --user enable --now vault-bridge
```

The client will start automatically on login. Check its status:

```
systemctl --user status vault-bridge
```

## Troubleshooting

**"command not found: vault-bridge"**
The install location may not be on your PATH. Try `python3 -m vault_bridge_client.cli start` instead, or add `~/.local/bin` to your PATH.

**"VAULT_BRIDGE_TOKEN not set"**
Run `vault-bridge setup` again, or check `~/.vault-bridge/.env`.

**"Vault path does not exist"**
Make sure the path you entered during setup points to an existing folder. If your vault is on iCloud Drive, use the local path: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/YourVault`.

**Connection drops**
The client reconnects automatically with increasing delays (2s, 4s, 8s... up to 60s).

**"Client not connected" in Claude**
Make sure `vault-bridge start` is running. Check the terminal for errors.

## Check status

```
vault-bridge status
```

Shows your config and counts the markdown files in your vault.
