import { describe, it, expect } from "vitest";
import { writeFile, searchFiles } from "../src/r2-ops.js";
import { parseFile } from "../src/index-format.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);
const firstResultPath = (out: string) =>
  out.split("\n").find((l) => l.startsWith("["))?.split("] ")[1];

describe("search: coverage ranking (multi-word is no longer noisy OR)", () => {
  it("ranks the note matching ALL terms above notes matching one term often", async () => {
    const bucket = makeBucket({});
    // The right answer: contains all three terms once.
    await writeFile(vault(bucket), "solaria/loop.md", "the clean preserve ask loop is the core gesture");
    // Decoys: each spams ONE common term many times.
    await writeFile(vault(bucket), "decoy-clean.md", "clean clean clean clean clean tidy up");
    await writeFile(vault(bucket), "decoy-ask.md", "ask ask ask ask ask a question");
    await writeFile(vault(bucket), "decoy-preserve.md", "preserve preserve preserve preserve jam");

    const out = await searchFiles(vault(bucket), "clean preserve ask");
    // The full-coverage note ranks first despite the decoys' higher term counts.
    expect(firstResultPath(out)).toBe("solaria/loop.md");
    // Coverage is surfaced in the result label.
    expect(out).toContain("[3/3");
  });

  it("a single distinctive term still returns just the relevant notes", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "mentions Schneider once");
    await writeFile(vault(bucket), "b.md", "no match here");
    const out = await searchFiles(vault(bucket), "Schneider");
    expect(out).toContain("a.md");
    expect(out).not.toContain("b.md");
  });

  it("a lone tag match does not outrank a higher-coverage content match", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "tagged.md", "---\ntags: [alpha]\n---\nunrelated body");
    await writeFile(vault(bucket), "content.md", "alpha beta gamma all present");
    const out = await searchFiles(vault(bucket), "alpha beta gamma");
    // content.md matches 3/3; tagged.md matches only 1/3 → content ranks first.
    expect(firstResultPath(out)).toBe("content.md");
  });
});

describe("search: proximity re-rank within a coverage band", () => {
  it("ranks the note where terms sit TOGETHER above one where they're scattered", async () => {
    const bucket = makeBucket({});
    const filler = Array(150).fill("filler").join(" ");
    // Both match all three terms (3/3 coverage), so only proximity separates them.
    await writeFile(vault(bucket), "scattered.md", `clean ${filler} preserve ${filler} ask`);
    await writeFile(vault(bucket), "tight.md", `the clean preserve ask loop ${filler}`);
    const out = await searchFiles(vault(bucket), "clean preserve ask");
    expect(firstResultPath(out)).toBe("tight.md");
  });

  it("single-word queries skip proximity and still return matches", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "a.md", "Schneider appears here");
    expect(await searchFiles(vault(bucket), "Schneider")).toContain("a.md");
  });
});

describe("search: filename queries handle kebab-case", () => {
  it("filename:process-log matches process-log.md (hyphen no longer breaks it)", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "solaria/process-log.md", "x");
    await writeFile(vault(bucket), "other.md", "y");
    const out = await searchFiles(vault(bucket), "filename:process-log");
    expect(out).toContain("process-log.md");
    expect(out).not.toContain("other.md");
  });

  it("filename:process still matches (substring of a token)", async () => {
    const bucket = makeBucket({});
    await writeFile(vault(bucket), "process-log.md", "x");
    await writeFile(vault(bucket), "process-notes.md", "y");
    const out = await searchFiles(vault(bucket), "filename:process");
    expect(out).toContain("process-log.md");
    expect(out).toContain("process-notes.md");
  });
});

describe("index: CRLF files extract tags and preview correctly", () => {
  it("extracts frontmatter tags from a CRLF file (the process-log bug)", () => {
    const crlf = "---\r\ntags: [solaria, process-log]\r\nstatus: seedling\r\n---\r\nBody text.\r\n";
    const entry = parseFile(crlf, "h", "2026-08-08T00:00:00Z", crlf.length, "process-log.md");
    expect(entry.tags).toContain("solaria");
    expect(entry.tags).toContain("process-log");
    // Preview strips the frontmatter even with CRLF.
    expect(entry.preview.startsWith("Body text")).toBe(true);
  });

  it("a CRLF-tagged file is now found by a #tag search end to end", async () => {
    const bucket = makeBucket({});
    // Simulate the plugin uploading a CRLF file (bucket stores raw bytes).
    await writeFile(vault(bucket), "n.md", "---\r\ntags: [solaria]\r\n---\r\nbody");
    const out = await searchFiles(vault(bucket), "#solaria");
    expect(out).toContain("n.md");
  });
});
