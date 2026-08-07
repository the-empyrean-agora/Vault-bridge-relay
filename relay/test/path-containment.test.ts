import { describe, it, expect } from "vitest";
import { handleR2ToolCall, writeFile } from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);

// The exact escapes Claude Desktop demonstrated live (2026-08-08): create,
// read, list, delete all reached outside the vault root. Every door must now
// refuse them before any R2 access.
describe("path traversal is contained on every door", () => {
  it("create_file refuses ../ and writes nothing outside the prefix", async () => {
    const bucket = makeBucket({});
    await expect(
      handleR2ToolCall(vault(bucket), "create_file", {
        path: "../bridge-escape-test.md",
        content: "x",
      })
    ).rejects.toThrow(/invalid path/i);
    // Nothing landed anywhere (in-bounds or out).
    expect(bucket.store.size).toBe(0);
  });

  it("write_file refuses ../", async () => {
    const bucket = makeBucket({});
    await expect(
      handleR2ToolCall(vault(bucket), "write_file", {
        path: "../escape.md",
        content: "x",
      })
    ).rejects.toThrow(/invalid path/i);
  });

  it("read_file refuses ../", async () => {
    const bucket = makeBucket({});
    await expect(
      handleR2ToolCall(vault(bucket), "read_file", { path: "../../etc/passwd" })
    ).rejects.toThrow(/invalid path/i);
  });

  it("list_directory refuses ..", async () => {
    const bucket = makeBucket({});
    await expect(
      handleR2ToolCall(vault(bucket), "list_directory", { path: ".." })
    ).rejects.toThrow(/invalid path/i);
    // Root (empty path) is allowed by the validator — see vault-path.test.ts.
  });

  it("delete_file refuses ../", async () => {
    const bucket = makeBucket({});
    await expect(
      handleR2ToolCall(vault(bucket), "delete_file", {
        path: "../bridge-escape-test.md",
      })
    ).rejects.toThrow(/invalid path/i);
  });

  it("move_file refuses a traversal in either from or to", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "real.md", "hi");
    await expect(
      handleR2ToolCall(vault(bucket), "move_file", {
        from: "real.md",
        to: "../escape.md",
      })
    ).rejects.toThrow(/invalid path/i);
    await expect(
      handleR2ToolCall(vault(bucket), "move_file", {
        from: "../secret.md",
        to: "real2.md",
      })
    ).rejects.toThrow(/invalid path/i);
  });

  it("refuses the Windows null device", async () => {
    const bucket = makeBucket({});
    await expect(
      handleR2ToolCall(vault(bucket), "create_file", {
        path: "nul.md",
        content: "x",
      })
    ).rejects.toThrow(/invalid path/i);
  });

  it("still handles a legitimate in-vault path end to end", async () => {
    const bucket = makeBucket({});
    const res = await handleR2ToolCall(vault(bucket), "create_file", {
      path: "folder/note.md",
      content: "hello",
    });
    expect(res).toMatch(/created/i);
    expect(bucket.store.has(`${PREFIX}/folder/note.md`)).toBe(true);
  });
});
