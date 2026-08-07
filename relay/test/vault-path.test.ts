import { describe, it, expect } from "vitest";
import {
  validateVaultPath,
  isValidVaultPath,
  assertKeyWithinPrefix,
} from "../src/vault-path.js";

describe("validateVaultPath — accepts legitimate paths", () => {
  for (const p of [
    "note.md",
    "folder/note.md",
    "a/b/c/deep.md",
    "solaria/_Start Here.md",
    "attachments/image.png",
    "note with spaces.md",
    "Проект/файл.md",
    "emoji-😀.md",
  ]) {
    it(`accepts ${JSON.stringify(p)}`, () => {
      expect(validateVaultPath(p)).toBe(p);
    });
  }

  it("accepts empty only when allowEmpty is set", () => {
    expect(validateVaultPath("", { allowEmpty: true })).toBe("");
    expect(isValidVaultPath("")).toBe(false);
  });
});

describe("validateVaultPath — rejects traversal and escapes", () => {
  for (const p of [
    "../escape.md",
    "../../etc/passwd",
    "folder/../../escape.md",
    "a/b/../../../c.md",
    "..",
    "foo/..",
    "./relative.md",
    "foo/./bar.md",
  ]) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      expect(isValidVaultPath(p)).toBe(false);
      expect(() => validateVaultPath(p)).toThrow();
    });
  }
});

describe("validateVaultPath — rejects absolute paths and drive letters", () => {
  for (const p of ["/etc/passwd", "/abs.md", "C:/Windows/x.md", "c:\\x.md"]) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      expect(isValidVaultPath(p)).toBe(false);
    });
  }
});

describe("validateVaultPath — rejects Windows hazards", () => {
  for (const p of [
    "nul",
    "nul.md",
    "NUL.md",
    "con.txt",
    "aux",
    "com1.md",
    "lpt9.md",
    "folder/nul.md",
    "trailing.",
    "trailing ",
    "folder/space /x.md",
    "back\\slash.md",
  ]) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      expect(isValidVaultPath(p)).toBe(false);
    });
  }

  it("allows a reserved word as a non-initial name part", () => {
    expect(isValidVaultPath("connections.md")).toBe(true);
    expect(isValidVaultPath("my-nul-notes.md")).toBe(true);
  });
});

describe("validateVaultPath — rejects malformed input", () => {
  for (const p of [null, undefined, 42, {}, "//doubled.md", "a//b.md", "trail/"]) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      expect(isValidVaultPath(p as unknown)).toBe(false);
    });
  }

  it("rejects control characters and NUL byte", () => {
    expect(isValidVaultPath("a\x00b.md")).toBe(false);
    expect(isValidVaultPath("a\nb.md")).toBe(false);
  });
});

describe("assertKeyWithinPrefix — resolved-key containment", () => {
  it("keeps in-bounds paths under the prefix", () => {
    expect(assertKeyWithinPrefix("alice", "note.md")).toBe("alice/note.md");
    expect(assertKeyWithinPrefix("alice", "a/b/c.md")).toBe("alice/a/b/c.md");
  });

  it("rejects a resolved key that climbs out of the prefix", () => {
    expect(() => assertKeyWithinPrefix("alice", "../bob/secret.md")).toThrow();
    expect(() => assertKeyWithinPrefix("alice", "../../etc/passwd")).toThrow();
  });

  it("does not let a prefix-name collision pass (alice vs alice-evil)", () => {
    // "../alice-evil/x" would resolve to "alice-evil/x", a sibling prefix.
    expect(() => assertKeyWithinPrefix("alice", "../alice-evil/x.md")).toThrow();
  });
});
