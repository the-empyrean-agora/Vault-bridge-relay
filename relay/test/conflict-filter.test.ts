import { describe, it, expect } from "vitest";
import {
  writeFile,
  searchFiles,
  getBacklinks,
  listTags,
  getRecentFiles,
  resolveWikilink,
} from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);

// A conflict copy is a near-duplicate of a real note, so it must not surface in
// index-backed views (search, backlinks, tags, recent, wikilink resolution) —
// but it stays in R2 so the user can still open and resolve it.
describe(".conflict.md files are excluded from index-backed queries", () => {
  async function seed(bucket: MockBucket) {
    await writeFile(vault(bucket), "note.md", "#project [[Target]] hello world");
    await writeFile(vault(bucket), "note.conflict.md", "#project [[Target]] hello world");
    await writeFile(vault(bucket), "Target.md", "the target");
  }

  it("search_files does not return the conflict copy", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    const res = await searchFiles(vault(bucket), "hello");
    expect(res).toContain("note.md");
    expect(res).not.toContain("note.conflict.md");
  });

  it("list_tags counts the real note once, not twice", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    const res = await listTags(vault(bucket));
    expect(res).toContain("#project (1)");
  });

  it("get_backlinks ignores the conflict copy", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    const res = await getBacklinks(vault(bucket), "Target.md");
    expect(res).toContain("note.md");
    expect(res).not.toContain("note.conflict.md");
  });

  it("resolve_wikilink does not offer the conflict copy as a duplicate", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "Unique.md", "x");
    await writeFile(vault(bucket), "Unique.conflict.md", "x");
    expect(await resolveWikilink(vault(bucket), "[[Unique]]")).toBe("Unique.md");
  });

  it("get_recent_files skips conflict copies", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    const res = await getRecentFiles(vault(bucket), 7, 25);
    expect(res).not.toContain("note.conflict.md");
  });
});
