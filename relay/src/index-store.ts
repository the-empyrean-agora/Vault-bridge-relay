/**
 * IndexStore — the vault index behind an interface.
 *
 * Production: DoIndexStore, a thin wrapper over the per-user VaultIndexDO
 * (SQLite; see index-do.ts). Tests: an in-memory implementation in
 * test/helpers/mock-index-store.ts, mirroring the mock-r2 pattern — the
 * relay test harness is plain vitest, not workerd, so the DO itself stays
 * thin and everything interesting lives in pure functions.
 *
 * This replaces index-manager.ts, whose loadIndex/saveIndex read-modify-wrote
 * a single R2 JSON blob per entry change (the 2026-07-07 hot-key bottleneck).
 */

import { parseFile, type FileIndexEntry, type VaultIndex } from "./index-format.js";
import type { EntryWriteOpts } from "./index-do.js";
import type { VaultIndexDO } from "./index-do.js";
import type { Env } from "./config.js";

export type { EntryWriteOpts } from "./index-do.js";

export interface IndexStore {
  getEntry(path: string): Promise<FileIndexEntry | null>;
  setEntry(path: string, entry: FileIndexEntry, opts?: EntryWriteOpts): Promise<void>;
  removeEntry(path: string, opts?: EntryWriteOpts): Promise<void>;
  /** Rename a row in place (move); returns false if `from` has no entry. */
  renameEntry(from: string, to: string, opts?: EntryWriteOpts): Promise<boolean>;
  allEntries(): Promise<Record<string, FileIndexEntry>>;
  fullIndex(): Promise<{ index: VaultIndex; remoteWriteActive: boolean }>;
}

export class DoIndexStore implements IndexStore {
  constructor(
    private stub: DurableObjectStub<VaultIndexDO>,
    private prefix: string
  ) {}

  getEntry(path: string): Promise<FileIndexEntry | null> {
    return this.stub.getEntry(this.prefix, path);
  }
  setEntry(path: string, entry: FileIndexEntry, opts?: EntryWriteOpts): Promise<void> {
    return this.stub.setEntry(this.prefix, path, entry, opts);
  }
  removeEntry(path: string, opts?: EntryWriteOpts): Promise<void> {
    return this.stub.removeEntry(this.prefix, path, opts);
  }
  renameEntry(from: string, to: string, opts?: EntryWriteOpts): Promise<boolean> {
    return this.stub.renameEntry(this.prefix, from, to, opts);
  }
  allEntries(): Promise<Record<string, FileIndexEntry>> {
    return this.stub.allEntries(this.prefix);
  }
  fullIndex(): Promise<{ index: VaultIndex; remoteWriteActive: boolean }> {
    return this.stub.fullIndex(this.prefix);
  }
}

/** The per-user index store for a request. Same prefix → same DO instance. */
export function getIndexStore(env: Env, userPrefix: string): IndexStore {
  const stub = env.VAULT_INDEX.get(env.VAULT_INDEX.idFromName(userPrefix));
  return new DoIndexStore(stub, userPrefix);
}

/**
 * Build a full index entry from a file's text content. Computes the SHA-256
 * hash and runs the shared parser to extract tokens, tags, links, and preview.
 * This matches the plugin's local computation byte-for-byte so index state
 * stays consistent whether a write came from the plugin or from an MCP tool.
 */
export async function buildEntryFromContent(
  content: string,
  path: string,
  modifiedISO: string = new Date().toISOString()
): Promise<FileIndexEntry> {
  const buf = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const hash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const filename = path.split("/").pop() ?? path;
  return parseFile(content, hash, modifiedISO, buf.byteLength, filename);
}
