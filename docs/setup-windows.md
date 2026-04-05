# Vault Bridge Client — Windows Setup

## What you need

- **Python 3.10+** — [Download from python.org](https://www.python.org/downloads/)
- **Your Obsidian vault** — know the folder path (e.g. `C:\Users\you\Documents\MyVault`)
- **Your token** — your admin will give you this (a UUID like `abc12345-...`)

## Step 1: Install

Open a terminal (PowerShell or Command Prompt) and run:

```
pip install vault-bridge-client
```

If `pip` isn't recognised, try `python -m pip install vault-bridge-client`.

## Step 2: Configure

```
vault-bridge setup
```

It will ask for:
- **Path to your Obsidian vault** — paste the full path, e.g. `C:\Users\you\Documents\MyVault`
- **Your token** — paste the token your admin gave you
- **Relay URL** — press Enter to accept the default

Config is saved to `%USERPROFILE%\.vault-bridge\.env`.

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

Leave this window open. When Claude uses your vault, you'll see tool calls logged here.

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

This creates a startup script so the client runs automatically when you log in. You won't need to run `vault-bridge start` manually anymore.

## Troubleshooting

**"VAULT_BRIDGE_TOKEN not set"**
Run `vault-bridge setup` again, or check `%USERPROFILE%\.vault-bridge\.env`.

**"Vault path does not exist"**
Make sure the path you entered during setup points to an existing folder. If your vault is on Google Drive or OneDrive, use the local synced path.

**Connection drops**
The client reconnects automatically. If your internet went down, it will retry with increasing delays (2s, 4s, 8s... up to 60s).

**"Client not connected" in Claude**
Make sure `vault-bridge start` is running on your machine. Check the terminal for errors.

## Check status

```
vault-bridge status
```

Shows your config and counts the markdown files in your vault.
