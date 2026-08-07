/**
 * VaultIndexDO — one per user (keyed by userPrefix). Owns the vault index.
 *
 * Replaces the single hot R2 key (`{prefix}/_vault-bridge-index.json`) that
 * every file write used to read-modify-write. That design throttled bulk
 * syncs to ~1 index write/s and, worse, had no etag guard — two concurrent
 * writers silently lost one entry (root causes #2/#3 of the 2026-07-07
 * incident, see docs/sync-hardening-brief.md). Here every entry update is a
 * single serialized SQLite row write: atomic, batch-friendly, no hot key.
 *
 * Migration is lazy: the first access imports the legacy R2 index JSON into
 * SQLite. The R2 JSON lives on as a debounced snapshot (written by the alarm
 * ~60s after the last mutation) purely as a recovery escape hatch — the
 * 07-07 recovery tooling worked straight off that file. The DO is the sole
 * writer of the snapshot; nothing reads it except the one-time import and
 * humans during postmortems.
 *
 * Write-lease (O4): MCP mutations (Claude's writes) stamp lastRemoteWriteAt;
 * fullIndex() reports whether the lease window is still open so the plugin
 * can defer a background sync instead of interleaving with an edit burst.
 * Plugin pushes do NOT stamp it — the plugin must never defer to itself.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config.js";
import { EMPTY_INDEX, type FileIndexEntry, type VaultIndex } from "./index-format.js";

const INDEX_KEY_SUFFIX = "/_vault-bridge-index.json";
/** How long after the last change the R2 snapshot is written. */
const SNAPSHOT_DEBOUNCE_MS = 60_000;
/** How long after an MCP mutation the vault counts as "remote write active". */
const LEASE_WINDOW_MS = 25_000;

export interface EntryWriteOpts {
  /**
   * True when the mutation came from an MCP tool call (Claude) rather than a
   * plugin push — stamps the write-lease the plugin's periodic sync respects.
   */
  remoteWrite?: boolean;
}

export class VaultIndexDO extends DurableObject<Env> {
  /** Memoized lazy import — one R2 read per DO lifetime, re-checked via meta. */
  private importPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema setup only — no external I/O in blockConcurrencyWhile.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          entry TEXT NOT NULL,
          hash TEXT NOT NULL,
          modified TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  // --- Meta helpers ---

  private metaGet(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  private metaSet(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      key,
      value
    );
  }

  // --- Lazy import from the legacy R2 index blob ---

  private ensureImported(userPrefix: string): Promise<void> {
    if (!this.importPromise) {
      this.importPromise = this.importFromR2(userPrefix);
    }
    return this.importPromise;
  }

  private async importFromR2(userPrefix: string): Promise<void> {
    // Remember the prefix for the alarm handler (which has no caller).
    this.metaSet("prefix", userPrefix);
    if (this.metaGet("imported") === "1") return;

    const obj = await this.env.VAULT_BUCKET.get(`${userPrefix}${INDEX_KEY_SUFFIX}`);
    if (obj) {
      try {
        const parsed = (await obj.json()) as VaultIndex;
        if (parsed && typeof parsed === "object" && parsed.files) {
          for (const [path, entry] of Object.entries(parsed.files)) {
            this.writeRow(path, entry);
          }
        }
      } catch (err) {
        // Corrupt legacy index → start empty; it's best-effort and
        // self-healing (the plugin's next sync repopulates entries).
        console.warn("[VaultIndexDO] Failed to import legacy index:", err);
      }
    }
    this.metaSet("imported", "1");
  }

  private writeRow(path: string, entry: FileIndexEntry): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO files (path, entry, hash, modified) VALUES (?, ?, ?, ?)",
      path,
      JSON.stringify(entry),
      entry.hash,
      entry.modified
    );
  }

  /** Record a change: bump lastUpdated and debounce the R2 snapshot alarm. */
  private async markDirty(opts?: EntryWriteOpts): Promise<void> {
    this.metaSet("lastUpdated", new Date().toISOString());
    this.metaSet("dirty", "1");
    if (opts?.remoteWrite) {
      this.metaSet("lastRemoteWriteAt", String(Date.now()));
    }
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_DEBOUNCE_MS);
    }
  }

  // --- RPC surface (called via DoIndexStore) ---

  async getEntry(userPrefix: string, path: string): Promise<FileIndexEntry | null> {
    await this.ensureImported(userPrefix);
    const rows = this.ctx.storage.sql
      .exec<{ entry: string }>("SELECT entry FROM files WHERE path = ?", path)
      .toArray();
    return rows.length > 0 ? (JSON.parse(rows[0].entry) as FileIndexEntry) : null;
  }

  async setEntry(
    userPrefix: string,
    path: string,
    entry: FileIndexEntry,
    opts?: EntryWriteOpts
  ): Promise<void> {
    await this.ensureImported(userPrefix);
    this.writeRow(path, entry);
    await this.markDirty(opts);
  }

  async removeEntry(
    userPrefix: string,
    path: string,
    opts?: EntryWriteOpts
  ): Promise<void> {
    await this.ensureImported(userPrefix);
    this.ctx.storage.sql.exec("DELETE FROM files WHERE path = ?", path);
    await this.markDirty(opts);
  }

  /** Rename an index row in place — content (and hash) are unchanged by a move. */
  async renameEntry(
    userPrefix: string,
    from: string,
    to: string,
    opts?: EntryWriteOpts
  ): Promise<boolean> {
    await this.ensureImported(userPrefix);
    const rows = this.ctx.storage.sql
      .exec<{ entry: string }>("SELECT entry FROM files WHERE path = ?", from)
      .toArray();
    if (rows.length === 0) return false;
    this.ctx.storage.sql.exec("DELETE FROM files WHERE path = ?", to);
    this.ctx.storage.sql.exec("UPDATE files SET path = ? WHERE path = ?", to, from);
    await this.markDirty(opts);
    return true;
  }

  async allEntries(userPrefix: string): Promise<Record<string, FileIndexEntry>> {
    await this.ensureImported(userPrefix);
    const files: Record<string, FileIndexEntry> = {};
    for (const row of this.ctx.storage.sql.exec<{ path: string; entry: string }>(
      "SELECT path, entry FROM files"
    )) {
      files[row.path] = JSON.parse(row.entry) as FileIndexEntry;
    }
    return files;
  }

  async fullIndex(
    userPrefix: string
  ): Promise<{ index: VaultIndex; remoteWriteActive: boolean }> {
    const files = await this.allEntries(userPrefix);
    const lastRemote = Number(this.metaGet("lastRemoteWriteAt") ?? 0);
    return {
      index: {
        version: 1,
        files,
        lastUpdated: this.metaGet("lastUpdated") ?? EMPTY_INDEX.lastUpdated,
      },
      remoteWriteActive: Date.now() - lastRemote < LEASE_WINDOW_MS,
    };
  }

  /**
   * Debounced snapshot: write the whole index back to the legacy R2 key as a
   * recovery/backup artifact. At most one R2 index write per debounce window
   * regardless of burst size — this key is no longer on any hot path.
   */
  async alarm(): Promise<void> {
    const prefix = this.metaGet("prefix");
    if (!prefix || this.metaGet("dirty") !== "1") return;
    const files: Record<string, FileIndexEntry> = {};
    for (const row of this.ctx.storage.sql.exec<{ path: string; entry: string }>(
      "SELECT path, entry FROM files"
    )) {
      files[row.path] = JSON.parse(row.entry) as FileIndexEntry;
    }
    const index: VaultIndex = {
      version: 1,
      files,
      lastUpdated: this.metaGet("lastUpdated") ?? new Date().toISOString(),
    };
    await this.env.VAULT_BUCKET.put(
      `${prefix}${INDEX_KEY_SUFFIX}`,
      JSON.stringify(index),
      { httpMetadata: { contentType: "application/json" } }
    );
    this.metaSet("dirty", "0");
  }
}
