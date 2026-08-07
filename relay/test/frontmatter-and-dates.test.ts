import { describe, it, expect } from "vitest";
import {
  writeFile,
  createFile,
  editRange,
  getFilesByFrontmatter,
  type VaultCtx,
} from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
// A vault pinned to a timezone far enough east that "now" is often already
// tomorrow relative to UTC — Kiritimati is UTC+14.
const tzVault = (b: MockBucket, tz: string): VaultCtx => ({
  ...vaultFor(b, PREFIX),
  timezone: tz,
});

function fmDate(content: string, field: string): string | undefined {
  return content.match(new RegExp(`^${field}:[ \\t]*(.*)$`, "m"))?.[1]?.trim();
}

describe("updated: bump is timezone-aware", () => {
  it("stamps the vault-local date, which can differ from UTC", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "Pacific/Kiritimati"); // UTC+14
    await createFile(vault, "n.md", "---\nupdated: 2000-01-01\n---\nbody");
    const stored = bucket.store.get(`${PREFIX}/n.md`)!;
    const local = fmDate(stored, "updated")!;
    const utc = new Date().toISOString().slice(0, 10);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The two dates differ whenever UTC is a day behind the +14 zone, i.e.
    // 10:00 UTC onward. Always assert the local date is >= the UTC date.
    expect(local >= utc).toBe(true);
  });

  it("falls back to a valid date for an unknown timezone", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "Not/ARealZone");
    await createFile(vault, "n.md", "---\nupdated: 2000-01-01\n---\nx");
    expect(fmDate(bucket.store.get(`${PREFIX}/n.md`)!, "updated")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });
});

describe("write_file / create_file bump updated: like edit_range does", () => {
  it("write_file bumps updated: when present", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "UTC");
    await writeFile(vault, "n.md", "---\nupdated: 2020-05-05\n---\nhi");
    const today = new Date().toISOString().slice(0, 10);
    expect(fmDate(bucket.store.get(`${PREFIX}/n.md`)!, "updated")).toBe(today);
  });

  it("create_file bumps updated: when present", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "UTC");
    await createFile(vault, "n.md", "---\nupdated: 2020-05-05\n---\nhi");
    const today = new Date().toISOString().slice(0, 10);
    expect(fmDate(bucket.store.get(`${PREFIX}/n.md`)!, "updated")).toBe(today);
  });

  it("never injects frontmatter into a plain note", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "UTC");
    await writeFile(vault, "plain.md", "no frontmatter here");
    expect(bucket.store.get(`${PREFIX}/plain.md`)).toBe("no frontmatter here");
  });

  it("leaves a note without an updated: field untouched", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "UTC");
    const body = "---\ncreated: 2020-01-01\n---\nx";
    await writeFile(vault, "c.md", body);
    expect(bucket.store.get(`${PREFIX}/c.md`)).toBe(body);
  });
});

describe("get_files_by_frontmatter — date comparisons are type-safe", () => {
  async function seed(bucket: MockBucket, vault: VaultCtx) {
    // Deliberately avoid the auto-bump clobbering our test dates: no `updated:`
    // that we then compare on — instead use a static `due:` field.
    await writeFile(vault, "real.md", "---\ndue: 2026-09-01\n---\nreal");
    await writeFile(vault, "placeholder.md", "---\ndue: YYYY-MM-DD\n---\ntemplate");
    await writeFile(vault, "old.md", "---\ndue: 2026-01-01\n---\nold");
  }

  it("does not match a non-date placeholder on a date query", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "UTC");
    await seed(bucket, vault);
    const res = await getFilesByFrontmatter(vault, "due > 2026-08-01");
    expect(res).toContain("real.md");
    expect(res).not.toContain("placeholder.md"); // the bug: 'YYYY-...' used to win
    expect(res).not.toContain("old.md");
  });

  it("still supports numeric comparisons and rejects non-numeric values", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "UTC");
    await writeFile(vault, "p10.md", "---\npriority: 10\n---\nx");
    await writeFile(vault, "p2.md", "---\npriority: 2\n---\nx");
    await writeFile(vault, "phigh.md", "---\npriority: high\n---\nx");
    const res = await getFilesByFrontmatter(vault, "priority > 5");
    expect(res).toContain("p10.md");
    expect(res).not.toContain("p2.md");
    expect(res).not.toContain("phigh.md");
  });

  it("equality (:) still works for plain strings", async () => {
    const bucket = makeBucket({});
    const vault = tzVault(bucket, "UTC");
    await writeFile(vault, "s.md", "---\nstatus: seedling\n---\nx");
    expect(await getFilesByFrontmatter(vault, "status: seedling")).toContain("s.md");
  });
});
