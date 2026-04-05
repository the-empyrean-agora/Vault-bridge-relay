#!/usr/bin/env npx tsx
/**
 * Token manager CLI — wraps wrangler kv commands for ergonomic token management.
 *
 * Usage (run from repo root or tokens-cli/):
 *   npx tsx tokens-cli/tokens.ts add <label>        — generate + store a new token
 *   npx tsx tokens-cli/tokens.ts list                — list all tokens
 *   npx tsx tokens-cli/tokens.ts revoke <token>      — deactivate a token
 *   npx tsx tokens-cli/tokens.ts delete <token>      — permanently remove a token
 *   npx tsx tokens-cli/tokens.ts show <token>        — show token details
 *
 * Requires: wrangler CLI authenticated (wrangler login)
 * Config: set KV_NAMESPACE_ID below or via VAULT_BRIDGE_KV_NAMESPACE_ID env var.
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// --- Config ---

const KV_NAMESPACE_ID =
  process.env.VAULT_BRIDGE_KV_NAMESPACE_ID || "PLACEHOLDER";

if (KV_NAMESPACE_ID === "PLACEHOLDER") {
  console.error(
    "⚠  KV namespace ID not configured.\n" +
      "   Set VAULT_BRIDGE_KV_NAMESPACE_ID env var or edit KV_NAMESPACE_ID in this file.\n" +
      "   Create one with: wrangler kv namespace create VAULT_BRIDGE_TOKENS"
  );
  process.exit(1);
}

// --- Helpers ---

function wrangler(args: string): string {
  try {
    return execSync(`npx wrangler ${args}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() || err.message;
    console.error(`wrangler error: ${stderr}`);
    process.exit(1);
  }
}

function kvPut(key: string, value: string): void {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmpFile = path.join(os.tmpdir(), `vb-token-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, value, "utf-8");
  try {
    wrangler(
      `kv key put --namespace-id="${KV_NAMESPACE_ID}" "${key}" --path="${tmpFile}" --remote`
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function kvGet(key: string): string | null {
  try {
    return execSync(
      `npx wrangler kv key get --namespace-id="${KV_NAMESPACE_ID}" "${key}" --remote`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch {
    return null;
  }
}

function kvList(): Array<{ name: string }> {
  const raw = wrangler(`kv key list --namespace-id="${KV_NAMESPACE_ID}" --remote`);
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function kvDelete(key: string): void {
  wrangler(`kv key delete --namespace-id="${KV_NAMESPACE_ID}" "${key}" --remote`);
}

interface TokenRecord {
  label: string;
  created: string;
  active: boolean;
  mode?: "relay" | "r2";
  prefix?: string;
}

// --- Commands ---

function add(label: string, mode: "relay" | "r2" = "relay"): void {
  const token = randomUUID();
  const record: TokenRecord = {
    label,
    created: new Date().toISOString().split("T")[0],
    active: true,
    mode,
    ...(mode === "r2" ? { prefix: label.toLowerCase().replace(/[^a-z0-9-]/g, "") } : {}),
  };
  kvPut(token, JSON.stringify(record));

  console.log(`Token created for "${label}" (${mode} mode):`);
  console.log(`  Token:  ${token}`);
  console.log(
    `  MCP URL: https://vault-bridge.the-empyrean.com/mcp?token=${token}`
  );
  if (mode === "relay") {
    console.log(
      `  WS URL:  wss://vault-bridge.the-empyrean.com/ws?token=${token}`
    );
  } else {
    console.log(`  R2 prefix: ${record.prefix}`);
  }
}

function list(): void {
  const keys = kvList();
  if (keys.length === 0) {
    console.log("No tokens found.");
    return;
  }

  console.log(`${keys.length} token(s):\n`);
  for (const key of keys) {
    const raw = kvGet(key.name);
    if (!raw) continue;
    try {
      const record: TokenRecord = JSON.parse(raw);
      const status = record.active ? "active" : "REVOKED";
      const mode = record.mode ?? "relay";
      console.log(
        `  ${key.name.slice(0, 8)}...  ${record.label.padEnd(15)} ${mode.padEnd(6)} ${record.created}  [${status}]`
      );
    } catch {
      console.log(`  ${key.name.slice(0, 8)}...  (invalid record)`);
    }
  }
}

function show(token: string): void {
  const raw = kvGet(token);
  if (!raw) {
    console.error(`Token not found: ${token}`);
    process.exit(1);
  }
  const record: TokenRecord = JSON.parse(raw);
  const mode = record.mode ?? "relay";
  console.log(`Token:   ${token}`);
  console.log(`Label:   ${record.label}`);
  console.log(`Mode:    ${mode}`);
  console.log(`Created: ${record.created}`);
  console.log(`Active:  ${record.active}`);
  if (mode === "r2") {
    console.log(`Prefix:  ${record.prefix}`);
  }
  console.log(
    `MCP URL: https://vault-bridge.the-empyrean.com/mcp?token=${token}`
  );
  if (mode === "relay") {
    console.log(
      `WS URL:  wss://vault-bridge.the-empyrean.com/ws?token=${token}`
    );
  }
}

function revoke(token: string): void {
  const raw = kvGet(token);
  if (!raw) {
    console.error(`Token not found: ${token}`);
    process.exit(1);
  }
  const record: TokenRecord = JSON.parse(raw);
  record.active = false;
  kvPut(token, JSON.stringify(record));
  console.log(`Revoked token for "${record.label}" (${token.slice(0, 8)}...)`);
}

function deleteToken(token: string): void {
  const raw = kvGet(token);
  if (!raw) {
    console.error(`Token not found: ${token}`);
    process.exit(1);
  }
  const record: TokenRecord = JSON.parse(raw);
  kvDelete(token);
  console.log(
    `Deleted token for "${record.label}" (${token.slice(0, 8)}...)`
  );
}

// --- CLI entry ---

const [, , command, ...args] = process.argv;

switch (command) {
  case "add":
    if (!args[0]) {
      console.error("Usage: tokens add <label> [--r2]");
      process.exit(1);
    }
    add(args[0], args.includes("--r2") ? "r2" : "relay");
    break;
  case "list":
    list();
    break;
  case "show":
    if (!args[0]) {
      console.error("Usage: tokens show <token>");
      process.exit(1);
    }
    show(args[0]);
    break;
  case "revoke":
    if (!args[0]) {
      console.error("Usage: tokens revoke <token>");
      process.exit(1);
    }
    revoke(args[0]);
    break;
  case "delete":
    if (!args[0]) {
      console.error("Usage: tokens delete <token>");
      process.exit(1);
    }
    deleteToken(args[0]);
    break;
  default:
    console.log(
      "Vault Bridge Token Manager\n\n" +
        "Commands:\n" +
        "  add <label>          Create a relay mode token\n" +
        "  add <label> --r2     Create an R2 mode token\n" +
        "  list                 List all tokens\n" +
        "  show <token>         Show token details\n" +
        "  revoke <token>       Deactivate a token\n" +
        "  delete <token>       Permanently remove a token\n\n" +
        "Example:\n" +
        '  npx tsx tokens-cli/tokens.ts add "leigh"\n' +
        "  npx tsx tokens-cli/tokens.ts list"
    );
    break;
}
