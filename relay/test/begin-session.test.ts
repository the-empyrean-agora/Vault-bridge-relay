import { describe, it, expect } from "vitest";
import { beginSession } from "../src/r2-ops.js";
import { makeBucket, type MockBucket } from "./helpers/mock-r2.js";
import { vaultFor } from "./helpers/mock-index-store.js";

const PREFIX = "u";
const vault = (b: MockBucket) => vaultFor(b, PREFIX);

describe("beginSession", () => {
  it("returns _BOOTSTRAP.md when present", async () => {
    const bucket = makeBucket({
      [`${PREFIX}/_BOOTSTRAP.md`]: "Bootstrap rules here.",
      [`${PREFIX}/CLAUDE.md`]: "Should not be used.",
    });
    const out = await beginSession(vault(bucket));
    expect(out).toContain("from _BOOTSTRAP.md");
    expect(out).toContain("Bootstrap rules here.");
    expect(out).not.toContain("Should not be used.");
  });

  it("falls back to CLAUDE.md when no _BOOTSTRAP.md", async () => {
    const bucket = makeBucket({ [`${PREFIX}/CLAUDE.md`]: "Claude orientation." });
    const out = await beginSession(vault(bucket));
    expect(out).toContain("from CLAUDE.md");
    expect(out).toContain("Claude orientation.");
  });

  it("returns a generic message (never errors) when neither exists", async () => {
    const bucket = makeBucket({});
    const out = await beginSession(vault(bucket));
    expect(out).toContain("No orientation file found");
  });
});
