import { describe, it, expect } from "vitest";
import {
  writeFile,
  editRange,
  putSyncFileGuarded,
  deleteSyncFileGuarded,
} from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor, indexStoreFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);
const k = (p: string) => `${PREFIX}/${p}`;
const indexHash = (b: MockBucket, path: string): string | undefined =>
  indexStoreFor(b).files.get(path)?.hash;

describe("putSyncFileGuarded — plugin push version-guard", () => {
  it("applies when If-Match matches the current index hash", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "v1");
    const base = indexHash(bucket, "n.md")!;
    const res = await putSyncFileGuarded(vault(bucket), "n.md", "v2", {
      ifMatch: base,
    });
    expect(res.status).toBe(200);
    expect(bucket.store.get(k("n.md"))).toBe("v2");
    expect(res.hash).toBe(indexHash(bucket, "n.md"));
  });

  it("rejects (412) on a stale If-Match and leaves the file untouched", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "v1");
    const res = await putSyncFileGuarded(vault(bucket), "n.md", "v2", {
      ifMatch: "stale-hash",
    });
    expect(res.status).toBe(412);
    expect(res.currentHash).toBe(indexHash(bucket, "n.md"));
    expect(bucket.store.get(k("n.md"))).toBe("v1");
  });

  it("create-only (If-None-Match: *) creates a new file", async () => {
    const bucket = makeBucket({});
    const res = await putSyncFileGuarded(vault(bucket), "new.md", "hello", {
      ifNoneMatch: "*",
    });
    expect(res.status).toBe(200);
    expect(bucket.store.get(k("new.md"))).toBe("hello");
  });

  it("create-only (If-None-Match: *) rejects when the file exists", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "exists.md", "original");
    const res = await putSyncFileGuarded(vault(bucket), "exists.md", "new", {
      ifNoneMatch: "*",
    });
    expect(res.status).toBe(412);
    expect(bucket.store.get(k("exists.md"))).toBe("original");
  });
});

describe("deleteSyncFileGuarded", () => {
  it("deletes when If-Match matches", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "v1");
    const base = indexHash(bucket, "n.md")!;
    const res = await deleteSyncFileGuarded(vault(bucket), "n.md", {
      ifMatch: base,
    });
    expect(res.status).toBe(200);
    expect(bucket.store.has(k("n.md"))).toBe(false);
  });

  it("refuses (412) on a stale If-Match", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "v1");
    const res = await deleteSyncFileGuarded(vault(bucket), "n.md", {
      ifMatch: "stale",
    });
    expect(res.status).toBe(412);
    expect(bucket.store.has(k("n.md"))).toBe(true);
  });
});

describe("editRange CAS — a write landing mid-edit", () => {
  // Each test inlines a bucket whose first put to the file "loses" the CAS
  // (returns null) and swaps in racer content, simulating a concurrent writer.

  it("retries and applies on fresh content (racer's change survives)", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "alpha TARGET omega");
    const realPut = bucket.put;
    let fired = false;
    bucket.put = async (key, value, opts) => {
      if (!fired && key === k("n.md")) {
        fired = true;
        bucket.store.set(key, "alpha TARGET omega\nplus a concurrent line");
        return null; // our conditional put loses the race
      }
      return realPut(key, value, opts);
    };
    const res = await editRange(vault(bucket), "n.md", "TARGET", "REPLACED", false);
    expect(res).toContain("Edited n.md");
    const out = bucket.store.get(k("n.md"))!;
    expect(out).toContain("REPLACED");
    expect(out).toContain("plus a concurrent line"); // racer's edit preserved
    expect(out).not.toContain("TARGET");
  });

  it("errors cleanly (no clobber) when the racer removed old_string", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "alpha TARGET omega");
    const realPut = bucket.put;
    let fired = false;
    bucket.put = async (key, value, opts) => {
      if (!fired && key === k("n.md")) {
        fired = true;
        bucket.store.set(key, "the user rewrote this entirely");
        return null;
      }
      return realPut(key, value, opts);
    };
    await expect(
      editRange(vault(bucket), "n.md", "TARGET", "REPLACED", false)
    ).rejects.toThrow("old_string not found");
    expect(bucket.store.get(k("n.md"))).toBe("the user rewrote this entirely");
  });
});
