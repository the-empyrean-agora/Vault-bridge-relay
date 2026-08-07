/**
 * Vault path validation — the containment boundary for R2 mode.
 *
 * Every path that arrives over the wire (MCP tool params, /sync/* routes) is
 * turned into an R2 key `${prefix}/${path}`. R2 treats keys as opaque strings,
 * so a `../` never escapes the bucket on the relay itself — but the Obsidian
 * plugin mirrors index entries onto a real filesystem on every synced device,
 * where `../foo` DOES escape the vault folder. So the boundary is enforced here,
 * at the edge, before a hostile path can reach either the index or a client.
 *
 * Two independent checks, deliberately redundant (defence in depth):
 *   1. validateVaultPath()   — a rule about the NAME (reject traversal,
 *                              absolute paths, Windows device names, …).
 *   2. assertKeyWithinPrefix() — a re-check of the RESOLVED key against the
 *                              prefix root, so even a normalisation gap in (1)
 *                              cannot produce a key outside the user's space.
 */

// CON, PRN, AUX, NUL, COM1-9, LPT1-9 — reserved on Windows even with an
// extension (`nul.md` opens the null device, silently succeeding into nothing).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// Control characters (0x00-0x1F) and DEL (0x7F) — never legitimate in a path.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Throw if `path` is not a safe, in-vault relative path. Returns the path
 * unchanged on success so it can be used inline. `allowEmpty` permits the
 * empty string (the vault root — valid only for list_directory).
 */
export function validateVaultPath(
  path: unknown,
  opts: { allowEmpty?: boolean } = {}
): string {
  if (typeof path !== "string") {
    throw new Error("invalid path: must be a string");
  }
  if (path === "") {
    if (opts.allowEmpty) return path;
    throw new Error("invalid path: must not be empty");
  }
  if (path.length > 1024) {
    throw new Error("invalid path: too long");
  }
  if (CONTROL_CHARS.test(path)) {
    throw new Error("invalid path: contains control characters");
  }
  // Backslashes are Windows separators; the vault only ever uses forward
  // slashes. Rejecting them keeps segment analysis honest.
  if (path.includes("\\")) {
    throw new Error("invalid path: backslashes not allowed (use '/')");
  }
  // Absolute paths and Windows drive letters.
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new Error("invalid path: must be relative to the vault root");
  }

  for (const segment of path.split("/")) {
    if (segment === "") {
      throw new Error(
        "invalid path: empty segment (leading, trailing, or doubled '/')"
      );
    }
    if (segment === "." || segment === "..") {
      throw new Error("invalid path: '.' and '..' segments are not allowed");
    }
    // Windows strips trailing dots/spaces from names, so `foo.` and `foo `
    // collide with `foo` — reject them rather than let the collision through.
    if (segment !== segment.trimEnd() || segment.endsWith(".")) {
      throw new Error("invalid path: segment has a trailing space or dot");
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new Error(`invalid path: '${segment}' is a reserved device name`);
    }
  }

  return path;
}

/** Non-throwing form. */
export function isValidVaultPath(
  path: unknown,
  opts: { allowEmpty?: boolean } = {}
): boolean {
  try {
    validateVaultPath(path, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Second, independent check: build the R2 key and confirm it still resolves
 * inside `${prefix}/`. Collapses any `.`/`..` segments the first check might
 * have missed and rejects a key that climbs out. Returns the safe key.
 */
export function assertKeyWithinPrefix(prefix: string, path: string): string {
  const root = `${prefix}/`;
  const resolved = resolveKey(root + path);
  if (resolved !== prefix && !resolved.startsWith(root)) {
    throw new Error("invalid path: escapes the vault root");
  }
  return resolved;
}

/** Collapse `.`/`..`/doubled-slash segments in a key, without touching disk. */
function resolveKey(key: string): string {
  const out: string[] = [];
  for (const segment of key.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}
