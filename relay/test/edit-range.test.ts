import { describe, it, expect } from "vitest";
import { editRange, handleR2ToolCall } from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";

import { vaultFor, indexStoreFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);
const PATH = "notes/test.md";
const KEY = `${PREFIX}/${PATH}`;
const today = new Date().toISOString().slice(0, 10);

const BASE = [
  "---",
  "title: Test Note",
  "updated: 2025-01-01",
  "tags: [alpha, beta]",
  "---",
  "",
  "# Heading",
  "",
  "See [[Other Note]] and [[folder/Third]].",
  "",
  "The quick brown fox.",
  "The quick brown fox.",
  "",
].join("\n");

describe("editRange", () => {
  it("errors and writes nothing when old_string is not found", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    await expect(
      editRange(vault(bucket), PATH, "does-not-exist", "x", false)
    ).rejects.toThrow("old_string not found in notes/test.md");
    expect(bucket.store.get(KEY)).toBe(BASE); // unchanged
    expect(indexStoreFor(bucket).files.has(PATH)).toBe(false); // no index write
  });

  it("errors and writes nothing on a non-unique match without replace_all", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    await expect(
      editRange(vault(bucket), PATH, "The quick brown fox.", "X", false)
    ).rejects.toThrow("not unique in notes/test.md (2 matches)");
    expect(bucket.store.get(KEY)).toBe(BASE);
    expect(indexStoreFor(bucket).files.has(PATH)).toBe(false);
  });

  it("errors when the file does not exist", async () => {
    const bucket = makeBucket({});
    await expect(
      editRange(vault(bucket), PATH, "a", "b", false)
    ).rejects.toThrow("File not found: notes/test.md");
  });

  it("replaces a unique span byte-for-byte and bumps updated:", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    const result = await editRange(
      vault(bucket), PATH,
      "# Heading",
      "# New Heading",
      false
    );
    expect(result).toContain("Edited notes/test.md");

    const out = bucket.store.get(KEY)!;
    // Exact reconstruction: only the heading and the updated date change.
    const expected = BASE.replace("# Heading", "# New Heading").replace(
      "updated: 2025-01-01",
      `updated: ${today}`
    );
    expect(out).toBe(expected);
    // Wikilinks and frontmatter survived untouched.
    expect(out).toContain("[[Other Note]]");
    expect(out).toContain("[[folder/Third]]");
    expect(out).toContain("title: Test Note");
  });

  it("refreshes the vault index entry after an edit", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    await editRange(vault(bucket), PATH, "# Heading", "# New Heading", false);

    const entry = indexStoreFor(bucket).files.get(PATH)!;
    expect(entry).toBeTruthy();
    expect(entry.links).toContain("Other Note");
    expect(entry.links).toContain("folder/Third");
    expect(entry.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(entry.tokens).toContain("heading");
  });

  it("replace_all replaces every occurrence and reports the count", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    const result = await editRange(
      vault(bucket), PATH,
      "The quick brown fox.",
      "A lazy dog.",
      true
    );
    expect(result).toContain("Edited notes/test.md (2 occurrences)");

    const out = bucket.store.get(KEY)!;
    expect((out.match(/A lazy dog\./g) ?? []).length).toBe(2);
    expect(out).not.toContain("brown fox");
    expect(out).toContain(`updated: ${today}`);
  });

  it("leaves frontmatter alone when there is no updated: field", async () => {
    const noUpdated = "---\ntitle: X\n---\n\nHello world.\n";
    const bucket = makeBucket({ [KEY]: noUpdated });
    await editRange(vault(bucket), PATH, "Hello world.", "Goodbye world.", false);

    const out = bucket.store.get(KEY)!;
    expect(out).toBe("---\ntitle: X\n---\n\nGoodbye world.\n");
    expect(out).not.toContain("updated:");
  });

  it("never injects frontmatter into a plain file", async () => {
    const plain = "Just a plain note.\nNo frontmatter here.\n";
    const bucket = makeBucket({ [KEY]: plain });
    await editRange(vault(bucket), PATH, "plain note", "simple note", false);

    const out = bucket.store.get(KEY)!;
    expect(out).toBe("Just a simple note.\nNo frontmatter here.\n");
    expect(out.startsWith("---")).toBe(false);
  });

  // --- Regression: 2026-06-16 normalisation mismatch ---
  // These reproduce the live failure where old_string copied verbatim from
  // read_file still returned "old_string not found": the stored bytes differed
  // from the model-supplied old_string only by line endings / Unicode form.

  it("matches a multi-line span on a CRLF file when old_string uses LF", async () => {
    // A Windows-authored note: every newline is CRLF in storage.
    const crlf = BASE.replace(/\n/g, "\r\n");
    const bucket = makeBucket({ [KEY]: crlf });

    // The model sends old_string with bare LF, as it always does.
    const result = await editRange(
      vault(bucket), PATH,
      "# Heading\n\nSee [[Other Note]] and [[folder/Third]].",
      "# Heading\n\nSee [[Other Note]], [[folder/Third]], and [[New]].",
      false
    );
    expect(result).toContain("Edited notes/test.md");

    const out = bucket.store.get(KEY)!;
    expect(out).toContain("[[New]]");
    expect(out).toContain("[[Other Note]]");
    // File is rewritten in canonical LF — no stray CR survives.
    expect(out).not.toContain("\r");
    // The updated: bump (LF-anchored regex) now fires on a once-CRLF file.
    expect(out).toContain(`updated: ${today}`);
  });

  it("matches a single-line span on a CRLF file (the bare-fragment case)", async () => {
    const crlf = "alpha line\r\nbeta surfaces | gamma\r\ndelta line\r\n";
    const bucket = makeBucket({ [KEY]: crlf });
    const result = await editRange(
      vault(bucket), PATH,
      "surfaces |",
      "surfaces ||",
      false
    );
    expect(result).toContain("Edited notes/test.md");
    expect(bucket.store.get(KEY)!).toBe(
      "alpha line\nbeta surfaces || gamma\ndelta line\n"
    );
  });

  it("matches when stored text is NFD but old_string is NFC", async () => {
    // Build e-acute from its code point so the source stays pure-ASCII and the
    // test can't be skewed by this file's own on-disk encoding.
    const e = String.fromCharCode(0x00e9); // U+00E9, single composed NFC form
    const nfcOld = "caf" + e + " au lait";
    const stored = ("Title: " + nfcOld + "\n").normalize("NFD"); // e + combining acute
    const bucket = makeBucket({ [KEY]: stored });

    const result = await editRange(
      vault(bucket), PATH,
      nfcOld,
      "caf" + e,
      false
    );
    expect(result).toContain("Edited notes/test.md");
    // Written back in canonical NFC.
    expect(bucket.store.get(KEY)!).toBe("Title: caf" + e + "\n");
  });

  // --- Regression: 2026-06-16 (round 2) undefined old_string crash + aliases ---
  // A real caller sent old_str/new_str; params.old_string was undefined and
  // normalizeForMatch(undefined) threw "Cannot read properties of undefined".

  it("errors cleanly (no TypeError) when old_string is missing", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    await expect(
      editRange(vault(bucket), PATH, undefined as unknown as string, "x", false)
    ).rejects.toThrow("old_string is required");
    expect(bucket.store.get(KEY)).toBe(BASE); // unchanged
  });

  it("accepts old_str/new_str aliases through the tool dispatch", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    const result = await handleR2ToolCall(vault(bucket), "edit_range", {
      path: PATH,
      old_str: "# Heading",
      new_str: "# New Heading",
    });
    expect(result).toContain("Edited notes/test.md");
    expect(bucket.store.get(KEY)!).toContain("# New Heading");
  });

  it("dispatch surfaces a clean error when neither old_string nor old_str is given", async () => {
    const bucket = makeBucket({ [KEY]: BASE });
    await expect(
      handleR2ToolCall(vault(bucket), "edit_range", {
        path: PATH,
        new_string: "x",
      })
    ).rejects.toThrow("old_string is required");
  });
});
