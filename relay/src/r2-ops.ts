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

import { linkMatchesPath } from "./index-format.js";
import {
  buildEntryFromContent,
  loadIndex,
  setIndexEntry,
  removeIndexEntry,
} from "./index-manager.js";

const INTERNAL_PREFIX = "_vault-bridge-";

// --- Tools ---

/**
 * List directory contents from R2. Uses delimiter to get immediate children only.
 */
export async function listDirectory(
  bucket: R2Bucket,
  userPrefix: string,
  path: string
): Promise<string> {
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
export async function readFile(
  bucket: R2Bucket,
  userPrefix: string,
  path: string
): Promise<string> {
  const key = `${userPrefix}/${path}`;
  const object = await bucket.get(key);
  if (!object) {
    throw new Error(`File not found: ${path}`);
  }
  return await object.text();
}

/**
 * Write a file to R2 and update the vault index entry for it.
 */
export async function writeFile(
  bucket: R2Bucket,
  userPrefix: string,
  path: string,
  content: string
): Promise<string> {
  const key = `${userPrefix}/${path}`;
  await bucket.put(key, content);
  const entry = await buildEntryFromContent(content, path);
  await setIndexEntry(bucket, userPrefix, path, entry);
  return `Written: ${path}`;
}

/**
 * Delete a file from R2 and remove its index entry.
 */
export async function deleteFile(
  bucket: R2Bucket,
  userPrefix: string,
  path: string
): Promise<string> {
  const key = `${userPrefix}/${path}`;

  // Check it exists first so we can return a clear error
  const head = await bucket.head(key);
  if (!head) {
    throw new Error(`File not found: ${path}`);
  }

  await bucket.delete(key);
  await removeIndexEntry(bucket, userPrefix, path);

  return `Deleted: ${path}`;
}

/**
 * Search the vault index. Supports several query forms:
 *   "hello world"   → token match in content/filename (boosted on filename)
 *   "#projects"     → exact tag match
 *   "path:notes/"   → path prefix match
 *   "filename:foo"  → filename token match only
 */
export async function searchFiles(
  bucket: R2Bucket,
  userPrefix: string,
  query: string
): Promise<string> {
  const index = await loadIndex(bucket, userPrefix);
  const fileEntries = Object.entries(index.files);

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
    const term = trimmed.slice(9).trim().toLowerCase();
    const queryTokens = term.split(/\s+/).filter((t) => t.length > 0);
    const scored = fileEntries
      .map(([path, entry]) => {
        let score = 0;
        for (const qt of queryTokens) {
          for (const ft of entry.filenameTokens) {
            if (ft.includes(qt)) score += 1;
          }
        }
        return { path, score, preview: entry.preview };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    if (scored.length === 0) return `No filename matches for '${term}'`;
    return `${scored.length} filename match(es):\n${scored.map((r) => r.path).join("\n")}`;
  }

  // --- Default: full-text token search ---
  const queryTokens = trimmed.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const scored: Array<{ path: string; score: number; reason: string; preview: string }> = [];

  for (const [path, entry] of fileEntries) {
    let score = 0;
    let reason = "";

    // Filename match — highest signal
    for (const qt of queryTokens) {
      for (const ft of entry.filenameTokens) {
        if (ft.includes(qt)) {
          score += 100;
          if (!reason) reason = "filename";
        }
      }
    }

    // Tag match — high signal
    for (const qt of queryTokens) {
      for (const tag of entry.tags) {
        if (tag.includes(qt)) {
          score += 50;
          if (!reason) reason = "tag";
        }
      }
    }

    // Content token match — count each query token at most once per file
    for (const qt of queryTokens) {
      for (const ct of entry.tokens) {
        if (ct.includes(qt)) {
          score += 1;
          if (!reason) reason = "content";
          break;
        }
      }
    }

    if (score > 0) {
      scored.push({ path, score, reason, preview: entry.preview });
    }
  }

  if (scored.length === 0) {
    return `No results found for: ${query}`;
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 50);

  const lines = top.map(
    (r) => `[${r.reason}] ${r.path}\n  ${r.preview || "(no preview)"}`
  );
  return `Found ${scored.length} result(s) for '${query}'${scored.length > 50 ? " (showing top 50 by relevance)" : ""}:\n${lines.join("\n")}`;
}

/**
 * Find files that link to the given path (backlinks via wikilinks/markdown links).
 */
export async function getBacklinks(
  bucket: R2Bucket,
  userPrefix: string,
  path: string
): Promise<string> {
  const index = await loadIndex(bucket, userPrefix);
  const backlinks: string[] = [];

  for (const [filePath, entry] of Object.entries(index.files)) {
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
export async function listTags(
  bucket: R2Bucket,
  userPrefix: string
): Promise<string> {
  const index = await loadIndex(bucket, userPrefix);

  const counts = new Map<string, number>();
  for (const entry of Object.values(index.files)) {
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
  bucket: R2Bucket,
  userPrefix: string,
  days: number,
  limit: number
): Promise<string> {
  const index = await loadIndex(bucket, userPrefix);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const recent: Array<{ path: string; modified: string }> = [];
  for (const [path, entry] of Object.entries(index.files)) {
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
 * Handle an MCP tool call against R2.
 */
export async function handleR2ToolCall(
  bucket: R2Bucket,
  userPrefix: string,
  tool: string,
  params: Record<string, unknown>
): Promise<string> {
  switch (tool) {
    case "list_directory":
      return listDirectory(bucket, userPrefix, (params.path as string) ?? "");
    case "read_file":
      return readFile(bucket, userPrefix, params.path as string);
    case "write_file":
      return writeFile(
        bucket,
        userPrefix,
        params.path as string,
        params.content as string
      );
    case "delete_file":
      return deleteFile(bucket, userPrefix, params.path as string);
    case "search_files":
      return searchFiles(bucket, userPrefix, params.query as string);
    case "get_backlinks":
      return getBacklinks(bucket, userPrefix, params.path as string);
    case "list_tags":
      return listTags(bucket, userPrefix);
    case "get_recent_files":
      return getRecentFiles(
        bucket,
        userPrefix,
        (params.days as number) ?? 7,
        (params.limit as number) ?? 25
      );
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
