import { describe, it, expect } from "vitest";
import { parseFile } from "../src/index-format.js";

const tagsOf = (content: string) =>
  parseFile(content, "h", "2026-08-08T00:00:00Z", content.length, "n.md").tags;

describe("frontmatter tag forms", () => {
  it("list form is parsed WITHOUT the leading bullet (the #- tools bug)", () => {
    const t = tagsOf("---\ntags:\n  - tools\n  - poggo\n  - collab-core\n---\nbody");
    expect(t).toContain("tools");
    expect(t).toContain("poggo");
    expect(t).toContain("collab-core");
    // The bug produced a phantom "- tools" alongside "tools".
    expect(t).not.toContain("- tools");
    expect(t.some((x) => x.startsWith("- "))).toBe(false);
  });

  it("flow form [a, b, c] still works", () => {
    const t = tagsOf("---\ntags: [solaria, process-log]\n---\nx");
    expect(t).toEqual(expect.arrayContaining(["solaria", "process-log"]));
    expect(t.some((x) => x.startsWith("- "))).toBe(false);
  });

  it("bare comma form (tags: a, b) still works", () => {
    const t = tagsOf("---\ntags: alpha, beta\n---\nx");
    expect(t).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("list form with no phantom even when a status line follows", () => {
    const t = tagsOf("---\ntags:\n  - tools\nstatus: active\n---\nx");
    expect(t).toContain("tools");
    expect(t).not.toContain("- tools");
  });
});

describe("inline tag pollution is filtered", () => {
  it("drops hex colours (incl. inside code) and keeps real tags", () => {
    const t = tagsOf("Body #project and a colour `#fafaf7` plus #ffffff and #4338ca inline.");
    expect(t).toContain("project");
    expect(t).not.toContain("fafaf7");
    expect(t).not.toContain("ffffff");
    expect(t).not.toContain("4338ca");
  });

  it("drops fenced-code content", () => {
    const t = tagsOf("Real #keeper here.\n\n```css\n.x { color: #b45309; }\n#notatag { }\n```\n");
    expect(t).toContain("keeper");
    expect(t).not.toContain("b45309");
    expect(t).not.toContain("notatag");
  });

  it("drops bare numbers and invoice-style ids", () => {
    const t = tagsOf("See #1 and #42 and invoice #2998-2142-5237 but keep #ledger.");
    expect(t).toContain("ledger");
    expect(t).not.toContain("1");
    expect(t).not.toContain("42");
    expect(t).not.toContain("2998-2142-5237");
  });

  it("drops single characters", () => {
    const t = tagsOf("#a #c #y but #ai is fine");
    expect(t).toContain("ai");
    expect(t).not.toContain("a");
    expect(t).not.toContain("c");
  });

  it("keeps legitimate multi-part inline tags", () => {
    const t = tagsOf("#vault-bridge #project/active #2026-review");
    expect(t).toContain("vault-bridge");
    expect(t).toContain("project/active");
    expect(t).toContain("2026-review"); // has letters → not a bare number
  });
});
