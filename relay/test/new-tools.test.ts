import { describe, it, expect } from "vitest";
import {
  writeFile,
  editRange,
  getOutgoingLinks,
  getFilesByFrontmatter,
  appendToSection,
  readSection,
  readFrontmatter,
  resolveWikilink,
  createFile,
  handleR2ToolCall,
} from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor, indexStoreFor, MockIndexStore } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);
const today = new Date().toISOString().slice(0, 10);
const k = (p: string) => `${PREFIX}/${p}`;

describe("get_outgoing_links", () => {
  it("lists wikilinks and markdown links from the index", async () => {
    const bucket = makeBucket({});
    await writeFile(
      vault(bucket), "a.md",
      "See [[Other Note]] and [[folder/Third]] and [doc](b.md)."
    );
    const result = await getOutgoingLinks(vault(bucket), "a.md");
    expect(result).toContain("Other Note");
    expect(result).toContain("folder/Third");
    expect(result).toContain("b.md");
    expect(result).toContain("3 outgoing link(s)");
  });

  it("reports cleanly when a note has no outgoing links", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "No links here.");
    expect(await getOutgoingLinks(vault(bucket), "a.md")).toBe(
      "a.md has no outgoing links."
    );
  });

  it("handles an unindexed path gracefully (no throw)", async () => {
    const bucket = makeBucket({});
    const r = await getOutgoingLinks(vault(bucket), "missing.md");
    expect(r).toContain("No index entry");
  });
});

describe("get_files_by_frontmatter", () => {
  async function seed(bucket: MockBucket) {
    // `due:` is a static date field (write_file bumps `updated:`, so we can't
    // assert on a seeded `updated:` value — see the timezone-bump tests).
    await writeFile(vault(bucket), "n1.md", "---\nstatus: seedling\ndue: 2026-06-10\ntags: [agora, idea]\n---\n\nOne.");
    await writeFile(vault(bucket), "n2.md", "---\nstatus: growing\ndue: 2025-01-01\n---\n\nTwo.");
    await writeFile(vault(bucket), "n3.md", "---\nstatus: seedling\n---\n\nThree.");
    await writeFile(vault(bucket), "plain.md", "No frontmatter here.");
  }

  it("matches an exact scalar field, case-insensitively", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    const r = await getFilesByFrontmatter(vault(bucket), "status: SEEDLING");
    expect(r).toContain("n1.md");
    expect(r).toContain("n3.md");
    expect(r).not.toContain("n2.md");
    expect(r).not.toContain("plain.md");
  });

  it("matches list-field membership (tags) and presence (field: *)", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    expect(await getFilesByFrontmatter(vault(bucket), "tags: agora")).toContain("n1.md");
    const present = await getFilesByFrontmatter(vault(bucket), "status: *");
    expect(present).toContain("n1.md");
    expect(present).toContain("n2.md");
    expect(present).toContain("n3.md");
  });

  it("supports ISO-date comparison", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    const r = await getFilesByFrontmatter(vault(bucket), "due > 2026-01-01");
    expect(r).toContain("n1.md");
    expect(r).not.toContain("n2.md");
  });

  it("returns a clear message when nothing matches", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    expect(await getFilesByFrontmatter(vault(bucket), "status: dormant")).toContain(
      "No files match"
    );
  });

  it("rejects an unparseable query", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    expect(await getFilesByFrontmatter(vault(bucket), "justtext")).toContain(
      "Could not parse"
    );
  });

  it("handles both a >4KB file (range path) and a tiny stub (full-read path)", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "big.md", "---\nstatus: seedling\n---\n\n" + "x".repeat(8000));
    await writeFile(vault(bucket), "stub.md", "---\nstatus: seedling\n---\n");
    const r = await getFilesByFrontmatter(vault(bucket), "status: seedling");
    expect(r).toContain("big.md");
    expect(r).toContain("stub.md");
  });

  it("survives R2 answering a range request with 416 (falls back to full read)", async () => {
    // Index says the object is large (so the range path is taken), but a ranged
    // get throws like R2's 416 — the full-read fallback must still match it.
    const content = "---\nstatus: seedling\n---\n";
    const index = new MockIndexStore();
    index.files.set("s.md", {
      hash: "h", modified: "2026-01-01", size: 9000,
      preview: "", tokens: [], filenameTokens: [], tags: [], links: [],
    });
    const store = new Map<string, string>([[`${PREFIX}/s.md`, content]]);
    const bucket = {
      store,
      async get(key: string, opts?: { range?: unknown }) {
        if (!store.has(key)) return null;
        if (opts?.range) throw new Error("R2 error: 416 Range Not Satisfiable");
        const v = store.get(key)!;
        return { text: async () => v, json: async () => JSON.parse(v) };
      },
    };
    const r = await getFilesByFrontmatter(
      { bucket: bucket as unknown as R2Bucket, prefix: PREFIX, index },
      "status: seedling"
    );
    expect(r).toContain("s.md");
  });
});

describe("append_to_section", () => {
  const DOC = [
    "---", "title: T", "updated: 2025-01-01", "---", "",
    "# Top", "", "Intro line.", "",
    "## Tasks", "", "- one", "- two", "",
    "## Notes", "", "Some note.", "",
  ].join("\n");

  it("appends at the end of a section, before the next heading, and bumps updated", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "d.md", DOC);
    const res = await appendToSection(vault(bucket), "d.md", "Tasks", "- three", "end");
    expect(res).toContain('under "Tasks" in d.md');
    const out = bucket.store.get(k("d.md"))!;
    expect(out.indexOf("- two")).toBeLessThan(out.indexOf("- three"));
    expect(out.indexOf("- three")).toBeLessThan(out.indexOf("## Notes"));
    expect(out).toContain(`updated: ${today}`);
    expect(out).not.toMatch(/\n{3,}/); // no ugly triple blanks introduced
  });

  it("appends at the start of a section, right after the heading", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "d.md", DOC);
    await appendToSection(vault(bucket), "d.md", "Tasks", "- zero", "start");
    const out = bucket.store.get(k("d.md"))!;
    expect(out.indexOf("## Tasks")).toBeLessThan(out.indexOf("- zero"));
    expect(out.indexOf("- zero")).toBeLessThan(out.indexOf("- one"));
  });

  it("appends to the final section at EOF", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "d.md", DOC);
    await appendToSection(vault(bucket), "d.md", "Notes", "Appended tail.", "end");
    const out = bucket.store.get(k("d.md"))!;
    expect(out.trimEnd().endsWith("Appended tail.")).toBe(true);
  });

  it("respects heading level: a ## section ends at the next ##/#, not its ### subsection", async () => {
    const bucket = makeBucket({});
    const doc = "# Top\n\n## Sec\n\ntext\n\n### Sub\n\nsubtext\n\n## Next\n\nn\n";
    await writeFile(vault(bucket), "lvl.md", doc);
    await appendToSection(vault(bucket), "lvl.md", "Sec", "- added", "end");
    const out = bucket.store.get(k("lvl.md"))!;
    expect(out.indexOf("subtext")).toBeLessThan(out.indexOf("- added"));
    expect(out.indexOf("- added")).toBeLessThan(out.indexOf("## Next"));
  });

  it("errors without writing when the heading is not found", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "d.md", DOC);
    // write_file may bump `updated:` on seed, so compare against what it stored,
    // not the raw DOC — the point is that the FAILED append writes nothing.
    const seeded = bucket.store.get(k("d.md"))!;
    await expect(
      appendToSection(vault(bucket), "d.md", "Ghost", "x", "end")
    ).rejects.toThrow("heading not found");
    expect(bucket.store.get(k("d.md"))).toBe(seeded);
  });

  it("errors when the heading is not unique", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "dup.md", "# A\n\nx\n\n# A\n\ny\n");
    await expect(
      appendToSection(vault(bucket), "dup.md", "A", "z", "end")
    ).rejects.toThrow("not unique");
  });

  it("is reachable through the tool dispatch with a default position", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "d.md", DOC);
    const res = await handleR2ToolCall(vault(bucket), "append_to_section", {
      path: "d.md",
      heading: "Notes",
      content: "Via dispatch.",
    });
    expect(res).toContain('under "Notes" in d.md');
    expect(bucket.store.get(k("d.md"))!).toContain("Via dispatch.");
  });
});

describe("read_section", () => {
  const DOC = [
    "# Top", "", "Intro.", "",
    "## Tasks", "", "- one", "- two", "",
    "## Notes", "", "A note.", "",
  ].join("\n");

  it("returns the heading through to the next sibling/higher heading", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "d.md", DOC);
    const out = await readSection(vault(bucket), "d.md", "Tasks");
    expect(out).toContain("## Tasks");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
    expect(out).not.toContain("## Notes");
    expect(out).not.toContain("A note.");
  });

  it("errors on a missing heading", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "d.md", DOC);
    await expect(readSection(vault(bucket), "d.md", "Ghost")).rejects.toThrow(
      "heading not found"
    );
  });

  it("errors on a non-unique heading", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "dup.md", "# A\n\nx\n\n# A\n\ny\n");
    await expect(readSection(vault(bucket), "dup.md", "A")).rejects.toThrow(
      "not unique"
    );
  });
});

describe("read_frontmatter", () => {
  it("returns the frontmatter block without the body", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "n.md", "---\nstatus: seedling\ntags: [a, b]\n---\n\nBody.");
    const out = await readFrontmatter(vault(bucket), "n.md");
    expect(out).toContain("status: seedling");
    expect(out).toContain("tags: [a, b]");
    expect(out).not.toContain("Body.");
  });

  it("reports when a note has no frontmatter", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "p.md", "Just a body.\n");
    expect(await readFrontmatter(vault(bucket), "p.md")).toBe(
      "No frontmatter in p.md."
    );
  });
});

describe("resolve_wikilink", () => {
  async function seed(bucket: MockBucket) {
    await writeFile(vault(bucket), "notes/Big Idea.md", "x");
    await writeFile(vault(bucket), "archive/Big Idea.md", "y");
    await writeFile(vault(bucket), "Unique Note.md", "z");
  }

  it("resolves a unique bare name to its path", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    expect(await resolveWikilink(vault(bucket), "Unique Note")).toBe("Unique Note.md");
  });

  it("strips [[ ]], an |alias and a #section", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    expect(await resolveWikilink(vault(bucket), "[[Unique Note|alias]]")).toBe("Unique Note.md");
    expect(await resolveWikilink(vault(bucket), "Unique Note#Heading")).toBe("Unique Note.md");
  });

  it("lists all candidates for an ambiguous bare name", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    const out = await resolveWikilink(vault(bucket), "Big Idea");
    expect(out).toContain("notes/Big Idea.md");
    expect(out).toContain("archive/Big Idea.md");
  });

  it("disambiguates via a folder path", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    expect(await resolveWikilink(vault(bucket), "notes/Big Idea")).toBe("notes/Big Idea.md");
  });

  it("reports when nothing resolves", async () => {
    const bucket = makeBucket({});
    await seed(bucket);
    expect(await resolveWikilink(vault(bucket), "Nonexistent")).toContain(
      "No file resolves"
    );
  });
});

describe("create_file", () => {
  it("creates a new file and indexes it", async () => {
    const bucket = makeBucket({});
    const res = await createFile(vault(bucket), "new.md", "---\ntags: [x]\n---\n\nHi.");
    expect(res).toContain("Created new.md");
    expect(bucket.store.get(k("new.md"))).toContain("Hi.");
    expect(indexStoreFor(bucket).files.get("new.md")).toBeTruthy();
  });

  it("refuses to overwrite an existing file", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "exists.md", "original");
    await expect(createFile(vault(bucket), "exists.md", "new")).rejects.toThrow(
      "already exists"
    );
    expect(bucket.store.get(k("exists.md"))).toBe("original");
  });
});

describe("missing-path validation (2026-06-20 gap)", () => {
  it("editRange gives a legible error when path is missing (not 'File not found: undefined')", async () => {
    const bucket = makeBucket({});
    await expect(
      editRange(vault(bucket), undefined as unknown as string, "a", "b", false)
    ).rejects.toThrow("missing required argument: path");
  });

  it("appendToSection gives a legible error when path is missing", async () => {
    const bucket = makeBucket({});
    await expect(
      appendToSection(vault(bucket), "", "Tasks", "x", "end")
    ).rejects.toThrow("missing required argument: path");
  });

  it("dispatch rejects a path-required tool with no path, before any file open", async () => {
    const bucket = makeBucket({});
    await expect(
      handleR2ToolCall(vault(bucket), "read_file", {})
    ).rejects.toThrow("missing required argument: path");
    await expect(
      handleR2ToolCall(vault(bucket), "edit_range", {
        path: "  ",
        old_string: "x",
        new_string: "y",
      })
    ).rejects.toThrow("missing required argument: path");
  });
});
