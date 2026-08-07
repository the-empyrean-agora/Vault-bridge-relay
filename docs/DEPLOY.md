# DEPLOY.md — Stand Up Your Own Vault Bridge

This guide deploys a complete Vault Bridge instance into **your own Cloudflare account**: a Worker, an R2 bucket, and a KV namespace. One deployment serves your whole team — each user gets their own token and their own private storage namespace.

It is written to be followed by a human with a terminal. It also works well handed to a coding agent (Claude Code or similar) — if you do that, note the guardrail in [CLAUDE.md](../CLAUDE.md): the agent must only create or modify the resources named in the values table below, and must stop and ask before touching DNS or anything that could incur cost.

## What you're building

```
Claude  ──HTTPS/MCP──>  Worker  ──>  R2 Bucket  ◀──sync──  Obsidian Plugin (each user's machine)
```

The Worker is an MCP server. Each user's Obsidian vault syncs to the R2 bucket under a private prefix via the [Obsidian plugin](https://github.com/the-empyrean-agora/vault-bridge-plugin); Claude reads and writes through the Worker. Tokens live in the KV namespace. Full architecture and constraints: [CLAUDE.md](../CLAUDE.md). Trust model: [SECURITY.md](../SECURITY.md).

## Prerequisites — check each one

- [ ] A Cloudflare account on the **Workers Paid** plan (~US$5/mo — Durable Objects require it). Free plan will fail at deploy time.
- [ ] **Node.js LTS** (`node --version` → v20 or later).
- [ ] This repo cloned; `cd relay && npm ci` completes.
- [ ] `npx wrangler login` completed; `npx wrangler whoami` shows the intended account and its **account ID** — you'll need it below.
- [ ] Optional: a domain whose DNS zone is in this Cloudflare account (only if you want a custom hostname; the free `*.workers.dev` hostname works fine).

## Values to choose — fill in before starting

Decide these now. Don't reuse anyone else's values.

| Value | Yours | Notes |
|---|---|---|
| Account ID | | From `npx wrangler whoami` |
| Worker name | | Default `vault-bridge-relay` is fine |
| KV namespace | | Created in step 1; you record the **ID** it prints |
| R2 bucket name | | e.g. `vault-bridge` |
| Hostname | | Either `<worker>.<your-subdomain>.workers.dev` (automatic) or a custom domain you control |

## Deploy

Run everything from the `relay/` directory.

### 1. Create the token store (KV)

```bash
npx wrangler kv namespace create VAULT_BRIDGE_TOKENS
```

**Verify:** it prints an `id`. Record it. `npx wrangler kv namespace list` shows the namespace.

### 2. Create the vault store (R2)

```bash
npx wrangler r2 bucket create vault-bridge     # or your chosen name
```

**Verify:** `npx wrangler r2 bucket list` shows the bucket.

### 3. Configure

```bash
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`: set `account_id`, the KV `id` from step 1, and your `bucket_name` from step 2. For a custom domain, fill in the `routes` block; otherwise delete it. Leave everything else (bindings, migrations, `compatibility_date`) exactly as it is.

### 4. Deploy the Worker

```bash
npx wrangler deploy
```

**Verify:** `curl https://<your-hostname>/health` returns `OK`.

### 5. Issue the first token

One token per user, **one token per vault** (see the warning below).

```bash
VAULT_BRIDGE_KV_NAMESPACE_ID=<kv-id> VAULT_BRIDGE_BASE_URL=https://<your-hostname> \
  npx tsx ../tokens-cli/tokens.ts add "alice" --r2
```

**Verify:** `... tokens.ts list` shows the token, and the `add` output printed the user's MCP URL and R2 prefix. Check the prefix is unique — labels are lowercased and stripped to `a-z0-9-`, so `"Jo Smith"` and `"josmith"` would collide into the same prefix and **share one vault**.

### 6. Install the plugin (per user)

From the [plugin repo](https://github.com/the-empyrean-agora/vault-bridge-plugin): install via a release (drop the release's `main.js` + `manifest.json` into `<vault>/.obsidian/plugins/vault-bridge/`) or via BRAT. In the plugin settings: set **Relay URL** to `https://<your-hostname>`, paste the user's **token**, then click **Initial upload**.

**Verify:**

```bash
curl -H "Authorization: Bearer <token>" https://<your-hostname>/sync/index
```

returns JSON listing the vault's files. That one check proves the Worker, auth, the index, and the plugin upload all at once.

### 7. Connect Claude

In Claude (web/desktop) → Settings → Connectors → Add custom connector → `https://<your-hostname>/mcp`. The browser opens a consent page; the user pastes their token there once. No token goes in the URL.

### 8. Acceptance test — you're done when this passes

1. Create a note in Obsidian; wait one sync interval (or click Sync now).
2. In Claude, ask it to read that note — content matches.
3. Ask Claude to create a small note — it appears in Obsidian within a sync interval.

## ⚠ One token per vault. Always.

A token maps directly to a storage namespace. If a user pastes an existing token into a **second** Obsidian vault, both vaults merge bidirectionally on first sync — the plugin is doing its job; it has no way to know the namespace was meant to be fresh. New vault → new token, every time. If it happens: disable the plugin in the affected vault immediately, then untangle before re-enabling.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Deploy fails mentioning Durable Objects | Account is on the free plan → upgrade to Workers Paid |
| `401` from any endpoint | Missing/revoked token → check `tokens.ts show <token>`, re-issue if needed |
| `500` "token misconfigured" | R2-mode token with no prefix in KV → delete and re-`add` with `--r2` |
| Plugin syncs 0 files | Scoped/excluded folders in plugin settings filtering everything out |
| Background sync seems to stall briefly | Claude is mid-write — the Worker holds a ~25 s write-lease and the plugin politely defers |
| `412` conflicts while editing on two sides | Working as designed — the losing copy is preserved as `<name>.conflict.md`, nothing is lost |
| Claude sees files the local vault doesn't have, and "recent files" looks flat | The plugin hasn't synced (auth problem, Obsidian closed) — not index corruption. Fix the plugin connection |
| Binary attachments (images, PDFs) arrive corrupted | Known limitation — the sync path is text-based. Add your attachments folder to the plugin's excluded folders |

## Operating notes

- **Costs:** Workers Paid ~US$5/mo; R2 and KV usage for a team of note-takers sits comfortably in the free allowances on top of that.
- **Revoke access:** `tokens.ts revoke <token>` — takes effect immediately, including for Claude connectors.
- **Token hygiene:** tokens are bearer credentials. Prefer the `Authorization: Bearer` header over `?token=` query strings. If users keep vault config in git (e.g. Obsidian Git), make sure `.obsidian/plugins/vault-bridge/data.json` is ignored — it contains the token.
- **Updates:** this is a self-hosted deployment — you own the update cadence. `git pull`, review, `npx wrangler deploy`. Watch the repo for security-relevant changes.
