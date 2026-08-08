/**
 * R2-backed vault operations — MCP tools that read/write R2 directly.
 *
 * Each function takes the R2 bucket, user prefix, and tool params.
 * Paths are always relative to the user's prefix.
 *
 * The "vault index" (`{prefix}/_vault-bridge-index.json`) is the source of
 * truth for search, backlinks, tags, and recent files. The plugin populates
 * it during sync; the Worker maintains entries on writes/deletes. See
 * index-format.ts and index-manager.ts.
 */

import { linkMatchesPath, tokenize } from "./index-format.js";
import { buildEntryFromContent, type IndexStore } from "./index-store.js";
import {
  validateVaultPath,
  assertKeyWithinPrefix,
  isValidVaultPath,
} from "./vault-path.js";

const INTERNAL_PREFIX = "_vault-bridge-";

/**
 * Conflict copies the plugin writes on a sync collision (`<name>.conflict.md`).
 * They are near-duplicates of real notes, so index-backed queries must skip them
 * or they surface as phantom duplicates in search, backlinks, and tag counts.
 * They stay in R2 and in list_directory, so the user can still find and resolve
 * them — they're just excluded from the semantic index views.
 */
function isConflictPath(path: string): boolean {
  return /\.conflict\.md$/i.test(path);
}

/** Index entries with conflict copies removed — the set index-backed readers query. */
function nonConflictEntries<T>(files: Record<string, T>): Array<[string, T]> {
  return Object.entries(files).filter(([p]) => !isConflictPath(p));
}

/**
 * Per-request vault context: the R2 bucket (content), the user's key prefix,
 * and the index store (per-user Durable Object in production; in-memory in
 * tests). Every tool function takes this as its first argument. MCP-path
 * mutations pass `remoteWrite: true` on index updates to stamp the write-lease
 * the plugin's periodic sync respects; plugin sync-path mutations do not.
 */
export interface VaultCtx {
  bucket: R2Bucket;
  prefix: string;
  index: IndexStore;
  /**
   * IANA timezone for date-only frontmatter stamps (e.g. "Australia/Melbourne").
   * MCP writes come from Claude, not the plugin, so the vault's local date can
   * only be resolved server-side. Defaults to UTC when unset.
   */
  timezone?: string;
}

// --- Tools ---

const BOOTSTRAP_CANDIDATES = ["_BOOTSTRAP.md", "CLAUDE.md"];

const GENERIC_ORIENTATION = [
  "No orientation file found in this vault.",
  "",
  "Create a `_BOOTSTRAP.md` (preferred) or `CLAUDE.md` at the vault root to",
  "define the rules, conventions, and entry ritual Claude should follow here.",
  "Until then: explore with list_directory and read_file before writing, prefer",
  "edit_range over write_file for changes to existing notes, and ask the user",
  "about their preferred structure.",
].join("\n");

/**
 * Return the vault's session-orientation payload. Reads `_BOOTSTRAP.md` from the
 * vault root, falling back to `CLAUDE.md`, then to a short generic message.
 * Never throws — orientation is best-effort and must not block a session.
 */
export async function beginSession(vault: VaultCtx): Promise<string> {
  const { bucket, prefix: userPrefix } = vault;
  for (const name of BOOTSTRAP_CANDIDATES) {
    const obj = await bucket.get(`${userPrefix}/${name}`);
    if (obj) {
      const text = await obj.text();
      return `# Vault orientation (from ${name})\n\n${text}`;
    }
  }
  return GENERIC_ORIENTATION;
}

/**
 * List directory contents from R2. Uses delimiter to get immediate children only.
 */
export async function listDirectory(
  vault: VaultCtx,
  path: string
): Promise<string> {
  const { bucket, prefix: userPrefix } = vault;
  const prefix = path ? `${userPrefix}/${path}/` : `${userPrefix}/`;

  const listed = await bucket.list({ prefix, delimiter: "/" });

  const folders = (listed.delimitedPrefixes ?? []).map((p) => {
    const name = p.slice(prefix.length).replace(/\/$/, "");
    return `${name}/`;
  });

  const files = listed.objects
    .map((obj) => obj.key.slice(prefix.length))
    .filter((name) => name && !name.includes("/"));

  const entries = [...folders.sort(), ...files.sort()];

  // Filter hidden entries and internal files
  const visible = entries.filter((e) => {
    const name = e.replace(/\/$/, "");
    return !name.startsWith(".") && !name.startsWith(INTERNAL_PREFIX);
  });

  return visible.length > 0 ? visible.join("\n") : "(empty directory)";
}

/**
 * Read a file from R2.
 */
export async function readFile(vault: VaultCtx, path: string): Promise<string> {
  const key = `${vault.prefix}/${path}`;
  const object = await vault.bucket.get(key);
  if (!object) {
    throw new Error(`File not found: ${path}`);
  }
  return await object.text();
}

/**
 * Write a file to R2 and update the vault index entry for it.
 *
 * The overwrite is compare-and-swap on the live object etag (head → put
 * onlyIf) — the last blind-overwrite path in R2 mode. A write landing in the
 * head→put window (a plugin push, another MCP call) makes the put lose, and
 * we surface that to the caller instead of silently clobbering it. No retry
 * loop here, deliberately: write_file replaces the whole file, so blindly
 * re-putting after a race would just clobber the concurrent change anyway —
 * the caller must re-read and re-decide. New files put unconditionally.
 */
export async function writeFile(
  vault: VaultCtx,
  path: string,
  content: string
): Promise<string> {
  const key = `${vault.prefix}/${path}`;
  // Bump `updated:` like edit_range/append_to_section do — an MCP write_file is
  // a modification, so the data contract's date field must move with it.
  const toWrite = bumpUpdatedFrontmatter(content, vault.timezone);
  const existing = await vault.bucket.head(key);
  const put = await vault.bucket.put(
    key,
    toWrite,
    existing ? { onlyIf: { etagMatches: existing.etag } } : undefined
  );
  if (put === null) {
    throw new Error(
      `${path} changed since you read it (a concurrent write landed) — re-read the file and retry`
    );
  }
  const entry = await buildEntryFromContent(toWrite, path);
  await vault.index.setEntry(path, entry, { remoteWrite: true });
  return `${existing ? "Overwrote" : "Created"} ${path}: ${toWrite.split("\n").length} lines, ${toWrite.length} chars.`;
}

/**
 * Canonicalise text before matching so an edit isn't defeated by invisible
 * encoding differences between what `read_file` emitted and what the caller
 * re-typed. Normalises line endings (CRLF / lone CR → LF) and Unicode to NFC.
 *
 * Why this is necessary: the Worker's `object.text()` preserves stored bytes
 * exactly, so a Windows-authored note holds `\r\n`, but the model reproduces
 * `old_string` with bare `\n` (and silently NFC-normalises Unicode). Matching
 * raw bytes then fails on text copied verbatim from `read_file` — the live
 * regression observed 2026-06-16. We canonicalise both sides and rewrite the
 * file in canonical form. That whole-file rewrite is free here: an edit already
 * puts the entire object back to R2, and the plugin pulls whole files rather
 * than line-diffs, so no extra sync churn. It also makes the `updated:` bump
 * (whose regex is LF-based) work on previously-CRLF notes.
 */
function normalizeForMatch(text: string): string {
  return text.replace(/\r\n?/g, "\n").normalize("NFC");
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * An empty needle counts as zero (an empty old_string is not a valid match).
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Format a signed integer delta for change summaries: 5 → "+5", -3 → "-3". */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/**
 * Today's date as YYYY-MM-DD in the given IANA timezone (default UTC).
 * `en-CA` formats as YYYY-MM-DD. An unknown timezone id must never abort a
 * write, so we fall back to UTC on error.
 */
function todayInTz(timezone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * If the content opens with YAML frontmatter containing an `updated:` field,
 * set that field to today's date in the vault's timezone. Returns the content
 * unchanged when there is no frontmatter or no `updated:` field — we never
 * inject frontmatter.
 */
function bumpUpdatedFrontmatter(content: string, timezone = "UTC"): string {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return content;
  const block = fm[0];
  const updatedRe = /^(updated:[ \t]*).*$/m;
  if (!updatedRe.test(block)) return content;
  const newBlock = block.replace(updatedRe, `$1${todayInTz(timezone)}`);
  return newBlock + content.slice(block.length);
}

const CAS_MAX_ATTEMPTS = 4;

/**
 * Read-modify-write a file with optimistic concurrency. Re-reads and re-applies
 * `transform` if the object changed between read and write (R2 etag `onlyIf`),
 * up to CAS_MAX_ATTEMPTS. `transform` receives the current (LF+NFC normalised)
 * content and returns the new content, or throws to abort — aborts (e.g. "match
 * not found") are NOT retried. This closes the get→put window so a concurrent
 * plugin push (or another MCP write) can't be silently clobbered: the put only
 * lands if the file is still what we read, otherwise we re-apply on fresh
 * content. Returns the written content.
 */
async function casReadModifyWrite(
  bucket: R2Bucket,
  key: string,
  path: string,
  transform: (content: string) => string
): Promise<string> {
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const object = await bucket.get(key);
    if (!object) {
      throw new Error(`File not found: ${path}`);
    }
    const content = normalizeForMatch(await object.text());
    const updated = transform(content); // may throw to abort (no retry)
    const put = await bucket.put(key, updated, {
      onlyIf: { etagMatches: object.etag },
    });
    if (put !== null) return updated;
    // Raced with a concurrent write — loop and re-apply against fresh content.
  }
  throw new Error(
    `${path} is being modified concurrently; please re-read and retry`
  );
}

/**
 * Surgically replace an exact text span in an existing file — the R2-mode
 * equivalent of Claude Code's Edit tool. Everything outside the matched span
 * is preserved byte-for-byte; the vault index is refreshed exactly as
 * writeFile does so search/backlinks/tags stay current.
 *
 *   - zero matches  → error, no write
 *   - >1 match and replaceAll false → error, no write
 *   - replaceAll true → replace every occurrence
 *
 * On a successful edit, an `updated:` frontmatter field (if present) is bumped
 * to today's date. Matching is normalisation-tolerant (see normalizeForMatch);
 * the file is rewritten in canonical LF + NFC form. The write is compare-and-
 * swap (see casReadModifyWrite) so a concurrent write can't be clobbered.
 */
export async function editRange(
  vault: VaultCtx,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): Promise<string> {
  // Validate before touching R2 so a missing/misnamed arg yields a clean,
  // diagnostic error rather than an opaque "File not found: undefined" or a raw
  // TypeError from normalizeForMatch.
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("missing required argument: path");
  }
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error("old_string is required and must be a non-empty string");
  }
  if (typeof newString !== "string") {
    throw new Error("new_string is required and must be a string");
  }

  const key = `${vault.prefix}/${path}`;
  const old = normalizeForMatch(oldString);
  const replacement = normalizeForMatch(newString);
  let count = 0;

  const updated = await casReadModifyWrite(vault.bucket, key, path, (content) => {
    count = countOccurrences(content, old);
    if (count === 0) {
      throw new Error(`old_string not found in ${path}`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `old_string is not unique in ${path} (${count} matches); add surrounding context or set replace_all`
      );
    }
    let next: string;
    if (replaceAll) {
      next = content.split(old).join(replacement);
    } else {
      const idx = content.indexOf(old);
      next = content.slice(0, idx) + replacement + content.slice(idx + old.length);
    }
    return bumpUpdatedFrontmatter(next, vault.timezone);
  });

  const entry = await buildEntryFromContent(updated, path);
  await vault.index.setEntry(path, entry, { remoteWrite: true });

  // Change summary so a malformed edit is visible on the spot rather than
  // surfacing indirectly two calls later.
  const oldNl = (old.match(/\n/g) ?? []).length;
  const newNl = (replacement.match(/\n/g) ?? []).length;
  const lineDelta = count * (newNl - oldNl);
  const charDelta = count * (replacement.length - old.length);
  const occ = replaceAll && count > 1 ? ` (${count} occurrences)` : "";
  let msg = `Edited ${path}${occ}: ${signed(lineDelta)} lines, ${signed(charDelta)} chars.`;
  // Accidental-insert guard: if new_string still CONTAINS old_string, the edit
  // added text around it rather than replacing it — the usual way a delete gets
  // expressed backwards (text placed in new_string instead of old_string).
  if (replacement !== old && replacement.includes(old)) {
    msg +=
      " Note: new_string contains old_string, so text was ADDED around it, not" +
      " replaced. To delete text, put it in old_string and leave new_string empty.";
  }
  return msg;
}

/**
 * Delete a file from R2 and remove its index entry.
 */
export async function deleteFile(vault: VaultCtx, path: string): Promise<string> {
  const key = `${vault.prefix}/${path}`;

  // Check it exists first so we can return a clear error
  const head = await vault.bucket.head(key);
  if (!head) {
    throw new Error(`File not found: ${path}`);
  }

  await vault.bucket.delete(key);
  await vault.index.removeEntry(path, { remoteWrite: true });

  return `Deleted: ${path}`;
}

// --- Move (first-class rename — O3 of docs/sync-hardening-brief.md) ---

export interface MoveResult {
  from: string;
  to: string;
  /**
   * 200 = moved; 400 = invalid paths; 404 = source missing;
   * 409 = destination exists; 412 = ifMatch stale (source changed in R2).
   */
  status: 200 | 400 | 404 | 409 | 412;
}

/**
 * Move/rename one file: copy the R2 object to the new key (get → put(stream) →
 * delete — R2 bindings have no server-side copy), then rename its index row in
 * place. Content is untouched, so both the single-part etag (content-MD5) and
 * the index hash (content-SHA256) survive — downstream If-Match guards keep
 * working across a move.
 *
 * Guards, in order: source must exist in R2 (404); `ifMatch`, when given, must
 * equal the source's current index hash (412 — same version token as the sync
 * PUT guard); destination must not exist (409 — a move never overwrites).
 * Copy-then-delete ordering means a failure mid-move can leave a duplicate,
 * never a loss.
 *
 * `remoteWrite: true` stamps the O4 write-lease — an MCP move is a remote
 * write the plugin must not interleave with. Plugin move batches don't stamp
 * it (the plugin must never defer to itself).
 */
export async function moveFile(
  vault: VaultCtx,
  from: string,
  to: string,
  opts?: { ifMatch?: string | null; remoteWrite?: boolean }
): Promise<MoveResult> {
  if (
    typeof from !== "string" || from.trim() === "" ||
    typeof to !== "string" || to.trim() === "" ||
    from === to ||
    from.includes(INTERNAL_PREFIX) || to.includes(INTERNAL_PREFIX) ||
    !isValidVaultPath(from) || !isValidVaultPath(to)
  ) {
    return { from, to, status: 400 };
  }

  const srcObj = await vault.bucket.get(`${vault.prefix}/${from}`);
  if (!srcObj) {
    return { from, to, status: 404 };
  }

  if (opts?.ifMatch != null) {
    const currentHash = (await vault.index.getEntry(from))?.hash ?? null;
    if (opts.ifMatch !== currentHash) {
      return { from, to, status: 412 };
    }
  }

  const destKey = `${vault.prefix}/${to}`;
  if (await vault.bucket.head(destKey)) {
    return { from, to, status: 409 };
  }

  await vault.bucket.put(destKey, srcObj.body, {
    httpMetadata: srcObj.httpMetadata,
  });
  await vault.bucket.delete(`${vault.prefix}/${from}`);

  const renamed = await vault.index.renameEntry(from, to, {
    remoteWrite: opts?.remoteWrite,
  });
  if (!renamed) {
    // Source had no index entry (legacy upload, unindexed attachment) — the
    // object still moved; rebuild the entry best-effort so search stays whole.
    try {
      const moved = await vault.bucket.get(destKey);
      if (moved) {
        const entry = await buildEntryFromContent(await moved.text(), to);
        await vault.index.setEntry(to, entry, { remoteWrite: opts?.remoteWrite });
      }
    } catch {
      // Index repair is best-effort; the move itself already succeeded.
    }
  }

  return { from, to, status: 200 };
}

/**
 * Search the vault index. Supports several query forms:
 *   "hello world"   → token match in content/filename (boosted on filename)
 *   "#projects"     → exact tag match
 *   "path:notes/"   → path prefix match
 *   "filename:foo"  → filename token match only
 */
export async function searchFiles(vault: VaultCtx, query: string): Promise<string> {
  const fileEntries = nonConflictEntries(await vault.index.allEntries());

  if (fileEntries.length === 0) {
    return "Search index is empty. Open Obsidian on a device with the Vault Bridge plugin to populate the index, or write any file to seed it.";
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return "Empty query.";
  }

  // --- Tag query: #projects ---
  if (trimmed.startsWith("#")) {
    const tag = trimmed.slice(1).toLowerCase();
    const matches = fileEntries
      .filter(([, e]) => e.tags.includes(tag))
      .map(([path]) => path);
    if (matches.length === 0) return `No files tagged #${tag}`;
    return `${matches.length} file(s) tagged #${tag}:\n${matches.sort().join("\n")}`;
  }

  // --- Path prefix query: path:notes/ ---
  if (trimmed.toLowerCase().startsWith("path:")) {
    const prefix = trimmed.slice(5).trim();
    const matches = fileEntries
      .filter(([path]) => path.startsWith(prefix))
      .map(([path]) => path);
    if (matches.length === 0) return `No files matching path prefix '${prefix}'`;
    const top = matches.sort().slice(0, 50);
    return `${matches.length} file(s) under '${prefix}'${matches.length > 50 ? " (showing first 50)" : ""}:\n${top.join("\n")}`;
  }

  // --- Filename-only query: filename:foo ---
  if (trimmed.toLowerCase().startsWith("filename:")) {
    const term = trimmed.slice(9).trim();
    // Tokenise the query the same way filenames are indexed (splits on hyphens
    // and other non-word chars), then require every sub-token to appear in the
    // basename. So `filename:process-log` matches `process-log.md` even though
    // the hyphen splits it — the old code compared the whole hyphenated term
    // against already-split tokens and never matched.
    const qTokens = tokenize(term);
    if (qTokens.length === 0) {
      return "Enter at least one search term after 'filename:'.";
    }
    const matches = fileEntries
      .map(([path]) => path)
      .filter((path) => {
        const base = (path.split("/").pop() ?? path).toLowerCase();
        return qTokens.every((qt) => base.includes(qt));
      })
      .sort();
    if (matches.length === 0) return `No filename matches for '${term}'`;
    const top = matches.slice(0, 50);
    return `${matches.length} filename match(es)${matches.length > 50 ? " (showing first 50)" : ""}:\n${top.join("\n")}`;
  }

  // --- Default: full-text search, ranked by query-token COVERAGE ---
  // Tokenise the query the same way the index is built, so query and content
  // agree on word boundaries and stopwords.
  const queryTokens = tokenize(trimmed);
  if (queryTokens.length === 0) {
    return `No searchable terms in '${query}'. Try a #tag, path:prefix, or filename: query.`;
  }

  const scored: Array<{
    path: string;
    coverage: number;
    weight: number;
    reason: string;
    preview: string;
  }> = [];

  for (const [path, entry] of fileEntries) {
    const matched = new Set<string>();
    let weight = 0;
    let reason = "";
    for (const qt of queryTokens) {
      // Count each query token once per doc, at its highest-signal location.
      if (entry.filenameTokens.some((ft) => ft.includes(qt))) {
        weight += 100;
        matched.add(qt);
        if (!reason) reason = "filename";
      } else if (entry.tags.some((tag) => tag.includes(qt))) {
        weight += 50;
        matched.add(qt);
        if (!reason) reason = "tag";
      } else if (entry.tokens.some((ct) => ct.includes(qt))) {
        weight += 5;
        matched.add(qt);
        if (!reason) reason = "content";
      }
    }
    if (matched.size > 0) {
      scored.push({
        path,
        coverage: matched.size,
        weight,
        reason,
        preview: entry.preview,
      });
    }
  }

  if (scored.length === 0) {
    return `No results found for: ${query}`;
  }

  // Coverage first: a note matching all query terms beats one that matches a
  // single common term many times (the old OR-scoring buried the right answer).
  // Weight (filename > tag > content) only breaks ties within equal coverage,
  // so a lone weak tag hit can no longer top a multi-term content match.
  scored.sort((a, b) => b.coverage - a.coverage || b.weight - a.weight);
  const top = scored.slice(0, 50);
  const n = queryTokens.length;

  const lines = top.map(
    (r) => `[${r.coverage}/${n} ${r.reason}] ${r.path}\n  ${r.preview || "(no preview)"}`
  );
  return `Found ${scored.length} result(s) for '${query}'${scored.length > 50 ? " (showing top 50 by relevance)" : ""}:\n${lines.join("\n")}`;
}

/**
 * Find files that link to the given path (backlinks via wikilinks/markdown links).
 */
export async function getBacklinks(vault: VaultCtx, path: string): Promise<string> {
  const files = await vault.index.allEntries();
  const backlinks: string[] = [];

  for (const [filePath, entry] of nonConflictEntries(files)) {
    if (filePath === path) continue;
    for (const link of entry.links) {
      if (linkMatchesPath(link, path)) {
        backlinks.push(filePath);
        break;
      }
    }
  }

  if (backlinks.length === 0) {
    return `No files link to ${path}`;
  }
  return `${backlinks.length} file(s) linking to ${path}:\n${backlinks.sort().join("\n")}`;
}

/**
 * List all unique tags in the vault with usage counts.
 */
export async function listTags(vault: VaultCtx): Promise<string> {
  const files = await vault.index.allEntries();

  const counts = new Map<string, number>();
  for (const [, entry] of nonConflictEntries(files)) {
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return "No tags found in vault.";
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.map(([tag, count]) => `#${tag} (${count})`);
  return `${counts.size} unique tag(s):\n${lines.join("\n")}`;
}

/**
 * Files modified in the last N days, most recent first.
 */
export async function getRecentFiles(
  vault: VaultCtx,
  days: number,
  limit: number
): Promise<string> {
  const files = await vault.index.allEntries();
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const recent: Array<{ path: string; modified: string }> = [];
  for (const [path, entry] of nonConflictEntries(files)) {
    const t = Date.parse(entry.modified);
    if (!isNaN(t) && t >= cutoffMs) {
      recent.push({ path, modified: entry.modified });
    }
  }

  recent.sort((a, b) => b.modified.localeCompare(a.modified));
  const top = recent.slice(0, limit);

  if (top.length === 0) {
    return `No files modified in the last ${days} day(s).`;
  }

  const lines = top.map((r) => `${r.path}  (${r.modified})`);
  return `${top.length} of ${recent.length} file(s) modified in the last ${days} day(s):\n${lines.join("\n")}`;
}

/**
 * List the notes a file links OUT to. Index-backed (entry.links), the mirror
 * of getBacklinks. Returns the link targets as written in the note (a bare
 * name, a folder/name path, or a markdown .md target) — resolution to a single
 * file path is intentionally left to the caller / a future resolve_wikilink.
 */
export async function getOutgoingLinks(
  vault: VaultCtx,
  path: string
): Promise<string> {
  const entry = await vault.index.getEntry(path);
  if (!entry) {
    return `No index entry for ${path} — it may not exist yet or hasn't been indexed. Try read_file to confirm the path.`;
  }
  if (entry.links.length === 0) {
    return `${path} has no outgoing links.`;
  }
  const sorted = [...entry.links].sort();
  return `${sorted.length} outgoing link(s) from ${path}:\n${sorted.join("\n")}`;
}

// --- Frontmatter querying (get_files_by_frontmatter) ---

interface FmCondition {
  field: string;
  op: ":" | ">" | "<" | ">=" | "<=";
  value: string;
}

/** Parse a single frontmatter condition: "status: seedling", "updated > 2026-01-01". */
function parseFrontmatterQuery(query: string): FmCondition | null {
  const m = query.trim().match(/^([A-Za-z0-9_-]+)\s*(>=|<=|>|<|:)\s*(.*)$/);
  if (!m) return null;
  return { field: m[1], op: m[2] as FmCondition["op"], value: m[3].trim() };
}

/** The raw YAML frontmatter block (without the --- fences), or null if absent. */
function frontmatterBlock(text: string): string | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

/** Strip matching surrounding quotes from a scalar value. */
function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

/** Parse simple scalar and list fields from a YAML frontmatter block. */
function parseFrontmatter(block: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === "") {
      // Possible list form: subsequent "  - item" lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^[ \t]*-[ \t]*\S/.test(lines[j])) {
        items.push(unquote(lines[j].replace(/^[ \t]*-[ \t]*/, "").trim()));
        j++;
      }
      out[key] = items.length ? items : "";
      if (items.length) i = j - 1;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      out[key] = unquote(rest);
    }
  }
  return out;
}

/** A strict ISO date (YYYY-MM-DD, optionally with a time) → epoch ms, else null. */
function asDate(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(s.trim())) return null;
  const t = Date.parse(s.trim());
  return isNaN(t) ? null : t;
}

/** A finite number (rejecting "" / whitespace, which Number() coerces to 0), else null. */
function asNumber(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

/**
 * Ordered comparison of a field value against a query value, TYPED BY THE QUERY.
 * Returns null ("not comparable") when the query asks for a date or number but
 * the field value isn't one — so `updated > 2026-08-01` can never match a
 * placeholder like `YYYY-MM-DD` (which used to win on raw string compare because
 * 'Y' sorts above '2'). Only when the query value is a plain string do we fall
 * back to lexical ordering.
 */
function compareScalar(fieldVal: string, queryVal: string): number | null {
  const qd = asDate(queryVal);
  if (qd !== null) {
    const fd = asDate(fieldVal);
    return fd === null ? null : fd - qd;
  }
  const qn = asNumber(queryVal);
  if (qn !== null) {
    const fn = asNumber(fieldVal);
    return fn === null ? null : fn - qn;
  }
  return fieldVal < queryVal ? -1 : fieldVal > queryVal ? 1 : 0;
}

function matchesCondition(
  fm: Record<string, string | string[]>,
  cond: FmCondition
): { ok: boolean; matched: string } {
  if (!(cond.field in fm)) return { ok: false, matched: "" };
  const raw = fm[cond.field];
  const values = Array.isArray(raw) ? raw : [raw];
  const display = Array.isArray(raw) ? raw.join(", ") : String(raw);

  if (cond.op === ":") {
    if (cond.value === "*") return { ok: true, matched: display };
    const wanted = cond.value.toLowerCase();
    for (const v of values) {
      if (String(v).toLowerCase() === wanted) return { ok: true, matched: display };
    }
    return { ok: false, matched: "" };
  }

  // Comparison ops act on the (first) scalar value.
  const v = String(values[0]);
  const cmp = compareScalar(v, cond.value);
  // null = not comparable (e.g. a non-date value against a date query) → no match.
  if (cmp === null) return { ok: false, matched: "" };
  const ok =
    (cond.op === ">" && cmp > 0) ||
    (cond.op === "<" && cmp < 0) ||
    (cond.op === ">=" && cmp >= 0) ||
    (cond.op === "<=" && cmp <= 0);
  return ok ? { ok, matched: v } : { ok: false, matched: "" };
}

/**
 * Read enough of an object to capture its frontmatter. Only issues a range
 * request when the object is genuinely larger than the window: a range starting
 * at offset 0 is unsatisfiable on an empty object and pointless on a small one,
 * and R2 answers an over-long range on a small file with 416 Range Not
 * Satisfiable rather than returning the whole object. Falls back to a full read
 * on any range failure (e.g. a stale index size), so one file can't 416 the
 * whole query. Small files are cheap to read whole anyway.
 */
async function readObjectHead(
  bucket: R2Bucket,
  key: string,
  size: number,
  maxBytes: number
): Promise<string | null> {
  if (size > maxBytes) {
    try {
      const ranged = await bucket.get(key, {
        range: { offset: 0, length: maxBytes },
      });
      if (ranged) return await ranged.text();
    } catch {
      // Fall through to a full read.
    }
  }
  const full = await bucket.get(key);
  return full ? await full.text() : null;
}

/**
 * Find notes matching one frontmatter condition. The index doesn't store
 * arbitrary frontmatter fields (only tags/modified), so we read just the first
 * few KB of each note — where frontmatter lives — in parallel batches (see
 * readObjectHead for the range/416 handling). This keeps the tool single-repo
 * and full-capability; if it ever feels slow on a large vault, promote
 * frontmatter scalars into the shared index entry.
 */
export async function getFilesByFrontmatter(
  vault: VaultCtx,
  query: string
): Promise<string> {
  const cond = parseFrontmatterQuery(query);
  if (!cond) {
    return `Could not parse query '${query}'. Use forms like 'status: seedling' or 'updated > 2026-01-01'.`;
  }

  const files = await vault.index.allEntries();
  const candidates = nonConflictEntries(files)
    .filter(([p]) => p.endsWith(".md"))
    .map(([p, e]) => ({ path: p, size: e.size ?? 0 }));
  if (candidates.length === 0) {
    return "Index is empty. Open Obsidian with the Vault Bridge plugin to populate it, or write a file to seed it.";
  }

  const FRONTMATTER_BYTES = 4096;
  const CONCURRENCY = 25;
  const matches: Array<{ path: string; value: string }> = [];

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ path: p, size }) => {
        try {
          const head = await readObjectHead(
            vault.bucket,
            `${vault.prefix}/${p}`,
            size,
            FRONTMATTER_BYTES
          );
          if (head === null) return null;
          const block = frontmatterBlock(normalizeForMatch(head));
          if (!block) return null;
          const res = matchesCondition(parseFrontmatter(block), cond);
          return res.ok ? { path: p, value: res.matched } : null;
        } catch {
          return null; // one bad file must never kill the whole query
        }
      })
    );
    for (const r of results) if (r) matches.push(r);
  }

  if (matches.length === 0) {
    return `No files match frontmatter '${query}'.`;
  }
  matches.sort((a, b) => a.path.localeCompare(b.path));
  const top = matches.slice(0, 100);
  const lines = top.map((m) => `${m.path}  (${cond.field}: ${m.value})`);
  return `${matches.length} file(s) match '${query}'${matches.length > 100 ? " (showing first 100)" : ""}:\n${lines.join("\n")}`;
}

// --- Section-aware append (append_to_section) ---

/** Markdown heading level (1-6) of a line, or 0 if it isn't an ATX heading. */
function headingLevel(line: string): number {
  const m = line.match(/^(#{1,6})\s+\S/);
  return m ? m[1].length : 0;
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function stripTrailingBlanks(arr: string[]): string[] {
  let end = arr.length;
  while (end > 0 && arr[end - 1].trim() === "") end--;
  return arr.slice(0, end);
}

function stripLeadingBlanks(arr: string[]): string[] {
  let start = 0;
  while (start < arr.length && arr[start].trim() === "") start++;
  return arr.slice(start);
}

/**
 * Insert content under a heading without resending the whole note. Layers on
 * the same matching discipline as editRange: the heading must resolve to
 * exactly one section. "end" inserts before the next heading of equal/higher
 * level (or EOF); "start" inserts immediately after the heading. The `updated:`
 * frontmatter field is bumped on success, consistent with editRange.
 */
export async function appendToSection(
  vault: VaultCtx,
  path: string,
  heading: string,
  contentToAdd: string,
  position: "end" | "start"
): Promise<string> {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("missing required argument: path");
  }
  if (typeof heading !== "string" || heading.trim() === "") {
    throw new Error("heading is required and must be a non-empty string");
  }
  if (typeof contentToAdd !== "string") {
    throw new Error("content is required and must be a string");
  }

  const key = `${vault.prefix}/${path}`;
  const wanted = heading.trim();
  const addLines = contentToAdd.replace(/\n+$/, "").split("\n");

  const updated = await casReadModifyWrite(vault.bucket, key, path, (text) => {
    const lines = text.split("\n");

    const headingIdxs: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (headingLevel(lines[i]) > 0 && headingText(lines[i]) === wanted) {
        headingIdxs.push(i);
      }
    }
    if (headingIdxs.length === 0) {
      throw new Error(`heading not found in ${path}: "${wanted}"`);
    }
    if (headingIdxs.length > 1) {
      throw new Error(
        `heading is not unique in ${path} (${headingIdxs.length} matches): "${wanted}"`
      );
    }

    const hIdx = headingIdxs[0];
    const level = headingLevel(lines[hIdx]);

    let merged: string[];
    if (position === "start") {
      const head = lines.slice(0, hIdx + 1);
      const body = stripLeadingBlanks(lines.slice(hIdx + 1));
      merged = body.length
        ? [...head, "", ...addLines, "", ...body]
        : [...head, "", ...addLines];
    } else {
      // "end": find the next heading of equal/higher level (section boundary).
      let endIdx = lines.length;
      for (let i = hIdx + 1; i < lines.length; i++) {
        const lv = headingLevel(lines[i]);
        if (lv > 0 && lv <= level) {
          endIdx = i;
          break;
        }
      }
      const head = stripTrailingBlanks(lines.slice(0, endIdx));
      const tail = lines.slice(endIdx);
      merged = [...head, "", ...addLines];
      if (tail.length) merged = [...merged, "", ...stripLeadingBlanks(tail)];
    }

    let next = merged.join("\n");
    if (!next.endsWith("\n")) next += "\n";
    return bumpUpdatedFrontmatter(next, vault.timezone);
  });

  const entry = await buildEntryFromContent(updated, path);
  await vault.index.setEntry(path, entry, { remoteWrite: true });

  return `Appended ${addLines.length} line(s) under "${wanted}" in ${path}.`;
}

/**
 * Read a single section of a note: the matched heading line through to just
 * before the next heading of equal or higher level. The heading must resolve to
 * exactly one section (same discipline as appendToSection). Pure read.
 */
export async function readSection(
  vault: VaultCtx,
  path: string,
  heading: string
): Promise<string> {
  if (typeof heading !== "string" || heading.trim() === "") {
    throw new Error("heading is required and must be a non-empty string");
  }
  const key = `${vault.prefix}/${path}`;
  const object = await vault.bucket.get(key);
  if (!object) {
    throw new Error(`File not found: ${path}`);
  }
  const lines = normalizeForMatch(await object.text()).split("\n");

  const wanted = heading.trim();
  const idxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (headingLevel(lines[i]) > 0 && headingText(lines[i]) === wanted) {
      idxs.push(i);
    }
  }
  if (idxs.length === 0) {
    throw new Error(`heading not found in ${path}: "${wanted}"`);
  }
  if (idxs.length > 1) {
    throw new Error(
      `heading is not unique in ${path} (${idxs.length} matches): "${wanted}"`
    );
  }

  const hIdx = idxs[0];
  const level = headingLevel(lines[hIdx]);
  let endIdx = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) {
    const lv = headingLevel(lines[i]);
    if (lv > 0 && lv <= level) {
      endIdx = i;
      break;
    }
  }
  return stripTrailingBlanks(lines.slice(hIdx, endIdx)).join("\n");
}

/**
 * Read just the YAML frontmatter block of a note (without the body). Returns the
 * block content, or a short note if the file has no frontmatter.
 */
export async function readFrontmatter(
  vault: VaultCtx,
  path: string
): Promise<string> {
  const key = `${vault.prefix}/${path}`;
  const object = await vault.bucket.get(key);
  if (!object) {
    throw new Error(`File not found: ${path}`);
  }
  const block = frontmatterBlock(normalizeForMatch(await object.text()));
  return block === null ? `No frontmatter in ${path}.` : block;
}

/**
 * Resolve a wikilink target to the actual vault path(s). Index-backed via
 * linkMatchesPath. Strips `[[ ]]`, an `|alias`, and a `#section` before matching.
 */
export async function resolveWikilink(
  vault: VaultCtx,
  link: string
): Promise<string> {
  if (typeof link !== "string" || link.trim() === "") {
    throw new Error("link is required and must be a non-empty string");
  }
  const cleaned = link
    .trim()
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .split("|")[0]
    .split("#")[0]
    .trim();
  if (cleaned === "") {
    throw new Error(`Could not parse a link target from "${link}"`);
  }

  const files = await vault.index.allEntries();
  const matches = Object.keys(files).filter(
    (p) => !isConflictPath(p) && linkMatchesPath(cleaned, p)
  );
  if (matches.length === 0) {
    return `No file resolves to [[${cleaned}]].`;
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return `${matches.length} files resolve to [[${cleaned}]]:\n${matches.sort().join("\n")}`;
}

/**
 * Create a NEW file, erroring if one already exists — the create-only
 * counterpart to writeFile. Updates the vault index exactly as writeFile does.
 */
export async function createFile(
  vault: VaultCtx,
  path: string,
  content: string
): Promise<string> {
  if (typeof content !== "string") {
    throw new Error("content is required and must be a string");
  }
  const key = `${vault.prefix}/${path}`;
  const existing = await vault.bucket.head(key);
  if (existing) {
    throw new Error(`File already exists: ${path} (use write_file to overwrite)`);
  }
  // Creating a note is a modification too — stamp `updated:` if present, for
  // parity with write_file/edit_range.
  const toWrite = bumpUpdatedFrontmatter(content, vault.timezone);
  await vault.bucket.put(key, toWrite);
  const entry = await buildEntryFromContent(toWrite, path);
  await vault.index.setEntry(path, entry, { remoteWrite: true });
  return `Created ${path}: ${toWrite.split("\n").length} lines, ${toWrite.length} chars.`;
}

// --- Version-guard for the plugin sync path (optimistic concurrency) ---

export interface SyncWriteResult {
  /** 200 = applied; 412 = precondition failed (caller should reconcile). */
  status: 200 | 412;
  /** New content hash, on 200. */
  hash?: string;
  /** Current index hash, on 412, so the caller can re-diff against it. */
  currentHash?: string | null;
}

/**
 * Conditional file write for the plugin's `PUT /sync/files/*`. The version token
 * is the index content-hash (which the plugin already holds as `r.hash`):
 *   - `ifNoneMatch: "*"` → create-only; 412 if the file already exists.
 *   - `ifMatch: <hash>`  → 412 unless the current index hash still matches.
 * On the way through, the R2 put is additionally conditioned on the live object
 * etag, so a write landing between the hash check and the put can't be silently
 * clobbered either (that also yields 412). Mirrors `writeFile`'s index update.
 */
export async function putSyncFileGuarded(
  vault: VaultCtx,
  path: string,
  content: string,
  opts: { ifMatch?: string | null; ifNoneMatch?: string | null }
): Promise<SyncWriteResult> {
  const currentHash = (await vault.index.getEntry(path))?.hash ?? null;

  if (opts.ifNoneMatch === "*" && currentHash !== null) {
    return { status: 412, currentHash };
  }
  if (opts.ifMatch != null && opts.ifMatch !== currentHash) {
    return { status: 412, currentHash };
  }

  const key = `${vault.prefix}/${path}`;
  const existing = await vault.bucket.head(key);
  const put = await vault.bucket.put(
    key,
    content,
    existing ? { onlyIf: { etagMatches: existing.etag } } : undefined
  );
  if (put === null) {
    // Raced between the hash check and the put — report current state.
    const fresh = await vault.index.getEntry(path);
    return { status: 412, currentHash: fresh?.hash ?? null };
  }

  const entry = await buildEntryFromContent(content, path);
  await vault.index.setEntry(path, entry);
  return { status: 200, hash: entry.hash };
}

/**
 * Conditional delete for the plugin's `DELETE /sync/files/*`. Refuses to delete
 * (412) when the current index hash no longer matches the caller's base — i.e.
 * the file changed in R2 (e.g. Claude wrote it) since the plugin last saw it.
 */
export async function deleteSyncFileGuarded(
  vault: VaultCtx,
  path: string,
  opts: { ifMatch?: string | null }
): Promise<SyncWriteResult> {
  const currentHash = (await vault.index.getEntry(path))?.hash ?? null;
  if (opts.ifMatch != null && opts.ifMatch !== currentHash) {
    return { status: 412, currentHash };
  }
  const key = `${vault.prefix}/${path}`;
  const existing = await vault.bucket.head(key);
  if (existing) await vault.bucket.delete(key);
  await vault.index.removeEntry(path);
  return { status: 200 };
}

/** Tools that require a non-empty `path` argument. */
const PATH_REQUIRED = new Set([
  "read_file",
  "write_file",
  "edit_range",
  "append_to_section",
  "delete_file",
  "get_backlinks",
  "read_section",
  "read_frontmatter",
  "get_outgoing_links",
  "create_file",
]);

/**
 * Handle an MCP tool call against R2.
 */
export async function handleR2ToolCall(
  vault: VaultCtx,
  tool: string,
  params: Record<string, unknown>
): Promise<string> {
  // Validate required args up front so a missing/blank `path` returns a legible
  // "missing required argument: path" instead of an opaque "File not found:
  // undefined" after a wasted R2 round-trip (2026-06-20 testing gap).
  if (
    PATH_REQUIRED.has(tool) &&
    (typeof params.path !== "string" || params.path.trim() === "")
  ) {
    throw new Error("missing required argument: path");
  }

  // Containment boundary: reject traversal / absolute / device-name paths on
  // every path-bearing tool before any R2 or index access. list_directory's
  // path is optional (empty = vault root), so it allows empty.
  if (PATH_REQUIRED.has(tool)) {
    validateVaultPath(params.path);
    assertKeyWithinPrefix(vault.prefix, params.path as string);
  }
  if (tool === "list_directory" && params.path != null && params.path !== "") {
    validateVaultPath(params.path);
    assertKeyWithinPrefix(vault.prefix, params.path as string);
  }
  // move_file's from/to are validated inside moveFile() (deep guard), so the
  // legible "missing required argument" checks in its case block run first.

  switch (tool) {
    case "begin_session":
      return beginSession(vault);
    case "list_directory":
      return listDirectory(vault, (params.path as string) ?? "");
    case "read_file":
      return readFile(vault, params.path as string);
    case "write_file":
      return writeFile(vault, params.path as string, params.content as string);
    case "edit_range":
      // Canonical args are old_string/new_string/replace_all, but accept the
      // abbreviated old_str/new_str (and replaceAll) spelling too — observed in
      // the wild from real MCP callers. Tolerating both is cheaper than a crash.
      return editRange(
        vault,
        params.path as string,
        (params.old_string ?? params.old_str) as string,
        (params.new_string ?? params.new_str) as string,
        (params.replace_all ?? params.replaceAll ?? false) as boolean
      );
    case "delete_file":
      return deleteFile(vault, params.path as string);
    case "search_files":
      return searchFiles(vault, params.query as string);
    case "get_backlinks":
      return getBacklinks(vault, params.path as string);
    case "list_tags":
      return listTags(vault);
    case "get_recent_files":
      return getRecentFiles(
        vault,
        (params.days as number) ?? 7,
        (params.limit as number) ?? 25
      );
    case "get_outgoing_links":
      return getOutgoingLinks(vault, params.path as string);
    case "get_files_by_frontmatter":
      return getFilesByFrontmatter(vault, params.query as string);
    case "append_to_section":
      return appendToSection(
        vault,
        params.path as string,
        params.heading as string,
        params.content as string,
        ((params.position as string) ?? "end") === "start" ? "start" : "end"
      );
    case "read_section":
      return readSection(vault, params.path as string, params.heading as string);
    case "read_frontmatter":
      return readFrontmatter(vault, params.path as string);
    case "resolve_wikilink":
      return resolveWikilink(vault, params.link as string);
    case "create_file":
      return createFile(vault, params.path as string, params.content as string);
    case "move_file": {
      const from = params.from as string;
      const to = params.to as string;
      if (typeof from !== "string" || from.trim() === "") {
        throw new Error("missing required argument: from");
      }
      if (typeof to !== "string" || to.trim() === "") {
        throw new Error("missing required argument: to");
      }
      const res = await moveFile(vault, from, to, { remoteWrite: true });
      switch (res.status) {
        case 200:
          return `Moved: ${from} → ${to}`;
        case 404:
          throw new Error(`File not found: ${from}`);
        case 409:
          throw new Error(
            `Destination already exists: ${to} — a move never overwrites; delete it first or pick another path`
          );
        default:
          throw new Error(`Cannot move ${from} → ${to}: invalid path`);
      }
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
