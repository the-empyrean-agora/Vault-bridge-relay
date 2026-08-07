/**
 * In-memory IndexStore stand-in for unit tests, mirroring the mock-r2
 * pattern. The relay tests run in plain vitest (node), not workerd, so the
 * production VaultIndexDO (SQLite) is kept thin and everything above the
 * storage layer is exercised against this Map-backed implementation.
 *
 * `vaultFor(bucket)` assembles the VaultCtx the r2-ops functions take. The
 * store is memoized per bucket so repeated `vaultFor(bucket)` calls within a
 * test share index state — matching production, where the same user prefix
 * always reaches the same Durable Object.
 */

import type { FileIndexEntry, VaultIndex } from "../../src/index-format.js";
import type { EntryWriteOpts, IndexStore } from "../../src/index-store.js";
import type { VaultCtx } from "../../src/r2-ops.js";
import type { MockBucket } from "./mock-r2.js";

export class MockIndexStore implements IndexStore {
  files = new Map<string, FileIndexEntry>();
  /** Count of writes stamped as MCP mutations — lets tests assert the lease. */
  remoteWrites = 0;

  async getEntry(path: string): Promise<FileIndexEntry | null> {
    return this.files.get(path) ?? null;
  }
  async setEntry(
    path: string,
    entry: FileIndexEntry,
    opts?: EntryWriteOpts
  ): Promise<void> {
    this.files.set(path, entry);
    if (opts?.remoteWrite) this.remoteWrites++;
  }
  async removeEntry(path: string, opts?: EntryWriteOpts): Promise<void> {
    this.files.delete(path);
    if (opts?.remoteWrite) this.remoteWrites++;
  }
  async renameEntry(
    from: string,
    to: string,
    opts?: EntryWriteOpts
  ): Promise<boolean> {
    const entry = this.files.get(from);
    if (!entry) return false;
    this.files.delete(from);
    this.files.set(to, entry);
    if (opts?.remoteWrite) this.remoteWrites++;
    return true;
  }
  async allEntries(): Promise<Record<string, FileIndexEntry>> {
    return Object.fromEntries(this.files);
  }
  async fullIndex(): Promise<{ index: VaultIndex; remoteWriteActive: boolean }> {
    return {
      index: {
        version: 1,
        files: await this.allEntries(),
        lastUpdated: new Date().toISOString(),
      },
      remoteWriteActive: false,
    };
  }
}

const stores = new WeakMap<object, MockIndexStore>();

/** VaultCtx over a mock bucket; same bucket → same (memoized) index store. */
export function vaultFor(bucket: MockBucket, prefix = "u"): VaultCtx {
  let store = stores.get(bucket);
  if (!store) {
    store = new MockIndexStore();
    stores.set(bucket, store);
  }
  return {
    bucket: bucket as unknown as R2Bucket,
    prefix,
    index: store,
  };
}

/** The memoized store for a bucket — for asserting on index state directly. */
export function indexStoreFor(bucket: MockBucket): MockIndexStore {
  let store = stores.get(bucket);
  if (!store) {
    store = new MockIndexStore();
    stores.set(bucket, store);
  }
  return store;
}
