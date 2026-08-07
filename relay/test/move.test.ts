import { describe, it, expect } from "vitest";
import {
  writeFile,
  moveFile,
  handleR2ToolCall,
} from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor, indexStoreFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);
const k = (p: string) => `${PREFIX}/${p}`;

describe("moveFile — first-class rename", () => {
  it("moves content, rekeys the index entry, and preserves the hash", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "notes/a.md", "hello world");
    const beforeHash = indexStoreFor(bucket).files.get("notes/a.md")!.hash;

    const res = await moveFile(vault(bucket), "notes/a.md", "archive/a.md");
    expect(res.status).toBe(200);

    expect(bucket.store.has(k("notes/a.md"))).toBe(false);
    expect(bucket.store.get(k("archive/a.md"))).toBe("hello world");

    const store = indexStoreFor(bucket);
    expect(store.files.has("notes/a.md")).toBe(false);
    expect(store.files.get("archive/a.md")?.hash).toBe(beforeHash);
  });

  it("404s when the source does not exist", async () => {
    const bucket = makeBucket({});
    const res = await moveFile(vault(bucket), "ghost.md", "b.md");
    expect(res.status).toBe(404);
  });

  it("409s when the destination exists, leaving both files untouched", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "content A");
    await writeFile(vault(bucket), "b.md", "content B");

    const res = await moveFile(vault(bucket), "a.md", "b.md");
    expect(res.status).toBe(409);
    expect(bucket.store.get(k("a.md"))).toBe("content A");
    expect(bucket.store.get(k("b.md"))).toBe("content B");
    expect(indexStoreFor(bucket).files.has("a.md")).toBe(true);
  });

  it("412s on a stale ifMatch and does not move", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "v1");

    const res = await moveFile(vault(bucket), "a.md", "moved.md", {
      ifMatch: "stale-hash",
    });
    expect(res.status).toBe(412);
    expect(bucket.store.has(k("a.md"))).toBe(true);
    expect(bucket.store.has(k("moved.md"))).toBe(false);
  });

  it("moves when ifMatch equals the current index hash", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "v1");
    const hash = indexStoreFor(bucket).files.get("a.md")!.hash;

    const res = await moveFile(vault(bucket), "a.md", "moved.md", {
      ifMatch: hash,
    });
    expect(res.status).toBe(200);
    expect(bucket.store.get(k("moved.md"))).toBe("v1");
  });

  it("400s on invalid paths: empty, self-move, internal index file", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "v1");

    expect((await moveFile(vault(bucket), "", "b.md")).status).toBe(400);
    expect((await moveFile(vault(bucket), "a.md", "")).status).toBe(400);
    expect((await moveFile(vault(bucket), "a.md", "a.md")).status).toBe(400);
    expect(
      (await moveFile(vault(bucket), "_vault-bridge-index.json", "b.md")).status
    ).toBe(400);
    expect(
      (await moveFile(vault(bucket), "a.md", "_vault-bridge-index.json")).status
    ).toBe(400);
    expect(bucket.store.get(k("a.md"))).toBe("v1");
  });

  it("stamps the write-lease only when remoteWrite is set", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "v1"); // writeFile stamps once
    const store = indexStoreFor(bucket);
    const baseline = store.remoteWrites;

    await moveFile(vault(bucket), "a.md", "b.md"); // plugin path: no stamp
    expect(store.remoteWrites).toBe(baseline);

    await moveFile(vault(bucket), "b.md", "c.md", { remoteWrite: true }); // MCP path
    expect(store.remoteWrites).toBe(baseline + 1);
  });

  it("rebuilds the index entry when the source had none (unindexed object)", async () => {
    const bucket = makeBucket({ [k("orphan.md")]: "orphan content" });

    const res = await moveFile(vault(bucket), "orphan.md", "adopted.md");
    expect(res.status).toBe(200);
    expect(bucket.store.get(k("adopted.md"))).toBe("orphan content");
    expect(indexStoreFor(bucket).files.has("adopted.md")).toBe(true);
  });
});

describe("move_file MCP tool dispatch", () => {
  it("moves and reports the new path", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "v1");
    const out = await handleR2ToolCall(vault(bucket), "move_file", {
      from: "a.md",
      to: "sub/b.md",
    });
    expect(out).toBe("Moved: a.md → sub/b.md");
    expect(bucket.store.get(k("sub/b.md"))).toBe("v1");
  });

  it("stamps the write-lease (an MCP move is a remote write)", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "v1");
    const store = indexStoreFor(bucket);
    const baseline = store.remoteWrites;
    await handleR2ToolCall(vault(bucket), "move_file", { from: "a.md", to: "b.md" });
    expect(store.remoteWrites).toBe(baseline + 1);
  });

  it("throws legible errors for missing args, 404, and 409", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "v1");
    await writeFile(vault(bucket), "b.md", "v2");

    await expect(
      handleR2ToolCall(vault(bucket), "move_file", { to: "x.md" })
    ).rejects.toThrow("missing required argument: from");
    await expect(
      handleR2ToolCall(vault(bucket), "move_file", { from: "a.md" })
    ).rejects.toThrow("missing required argument: to");
    await expect(
      handleR2ToolCall(vault(bucket), "move_file", { from: "ghost.md", to: "x.md" })
    ).rejects.toThrow("File not found: ghost.md");
    await expect(
      handleR2ToolCall(vault(bucket), "move_file", { from: "a.md", to: "b.md" })
    ).rejects.toThrow("Destination already exists: b.md");
  });
});

describe("writeFile CAS — overwrites are no longer blind", () => {
  it("creates a new file unconditionally", async () => {
    const bucket = makeBucket({});
    const out = await writeFile(vault(bucket), "new.md", "fresh");
    expect(out).toBe("Written: new.md");
    expect(bucket.store.get(k("new.md"))).toBe("fresh");
  });

  it("overwrites normally when nothing raced", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "v1");
    await writeFile(vault(bucket), "n.md", "v2");
    expect(bucket.store.get(k("n.md"))).toBe("v2");
  });

  it("errors (no clobber) when a write lands between head and put", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "v1");

    // Simulate a plugin push landing in the head→put window: the head reports
    // v1's etag, then the content changes before our conditional put.
    const realHead = bucket.head;
    bucket.head = async (key) => {
      const res = await realHead(key);
      if (key === k("n.md")) {
        bucket.store.set(key, "racer's content");
      }
      return res;
    };

    await expect(writeFile(vault(bucket), "n.md", "v2")).rejects.toThrow(
      "changed since you read it"
    );
    expect(bucket.store.get(k("n.md"))).toBe("racer's content");
  });
});
