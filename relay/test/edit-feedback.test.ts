import { describe, it, expect } from "vitest";
import {
  writeFile,
  createFile,
  editRange,
  appendToSection,
} from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);

describe("edit_range change summary", () => {
  it("reports signed line and char deltas on a replace", async () => {
    const bucket = makeBucket({});
    await createFile(vault(bucket), "n.md", "one\ntwo\nthree\n");
    const res = await editRange(vault(bucket), "n.md", "two", "two\nTWO-B", false);
    expect(res).toMatch(/Edited n\.md:/);
    expect(res).toContain("+1 lines");
    expect(res).toContain("chars");
  });

  it("reports negative deltas when deleting via empty new_string", async () => {
    const bucket = makeBucket({});
    await createFile(vault(bucket), "n.md", "keep\nDELETE ME\nkeep\n");
    const res = await editRange(vault(bucket), "n.md", "DELETE ME\n", "", false);
    expect(res).toContain("-1 lines");
    expect(bucket.store.get(`${PREFIX}/n.md`)).toBe("keep\nkeep\n");
    // A genuine delete must NOT trigger the accidental-insert note.
    expect(res).not.toContain("ADDED");
  });

  it("flags the accidental-insert shape (new_string contains old_string)", async () => {
    const bucket = makeBucket({});
    await createFile(vault(bucket), "n.md", "- **Kaizen** the practice\n");
    // The mistake from the field report: text to add placed in new_string,
    // matching on a marker — an insert masquerading as a replace.
    const res = await editRange(
      vault(bucket),
      "n.md",
      "- **Kaizen**",
      "- **Kaizen**\n- **Think big**",
      false
    );
    expect(res).toContain("ADDED");
    expect(res).toContain("old_string");
  });

  it("does not flag a normal replacement", async () => {
    const bucket = makeBucket({});
    await createFile(vault(bucket), "n.md", "the quick brown fox\n");
    const res = await editRange(vault(bucket), "n.md", "quick", "slow", false);
    expect(res).not.toContain("ADDED");
  });
});

describe("write/create/append summaries", () => {
  it("create_file reports created + line/char counts", async () => {
    const bucket = makeBucket({});
    const res = await createFile(vault(bucket), "n.md", "a\nb\nc");
    expect(res).toMatch(/Created n\.md: 3 lines/);
  });

  it("write_file distinguishes create vs overwrite", async () => {
    const bucket = makeBucket({});
    const first = await writeFile(vault(bucket), "n.md", "hello");
    expect(first).toMatch(/^Created n\.md:/);
    const second = await writeFile(vault(bucket), "n.md", "hello again");
    expect(second).toMatch(/^Overwrote n\.md:/);
  });

  it("append_to_section reports how many lines were added", async () => {
    const bucket = makeBucket({});
    await createFile(vault(bucket), "d.md", "# Top\n\n## Tasks\n\nexisting\n");
    const res = await appendToSection(vault(bucket), "d.md", "Tasks", "- a\n- b", "end");
    expect(res).toContain('under "Tasks" in d.md');
    expect(res).toContain("2 line(s)");
  });
});
