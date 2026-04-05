/**
 * R2-backed vault operations — MCP tools that read/write R2 directly.
 *
 * Each function takes the R2 bucket, user prefix, and tool params.
 * Paths are always relative to the user's prefix.
 */

import type { Env } from "./config.js";

/**
 * List directory contents from R2. Uses delimiter to get immediate children only.
 */
export async function listDirectory(
  bucket: R2Bucket,
  userPrefix: string,
  path: string
): Promise<string> {
  const prefix = path
    ? `${userPrefix}/${path}/`
    : `${userPrefix}/`;

  const listed = await bucket.list({ prefix, delimiter: "/" });

  const folders = (listed.delimitedPrefixes ?? []).map((p) => {
    const name = p.slice(prefix.length).replace(/\/$/, "");
    return `${name}/`;
  });

  const files = listed.objects
    .map((obj) => obj.key.slice(prefix.length))
    .filter((name) => name && !name.includes("/"));  // only immediate children

  const entries = [...folders.sort(), ...files.sort()];

  // Filter hidden entries and internal files
  const visible = entries.filter((e) => {
    const name = e.replace(/\/$/, "");
    return !name.startsWith(".") && !name.startsWith("_vault-bridge-");
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
 * Write a file to R2. Creates/overwrites.
 */
export async function writeFile(
  bucket: R2Bucket,
  userPrefix: string,
  path: string,
  content: string
): Promise<string> {
  const key = `${userPrefix}/${path}`;
  await bucket.put(key, content);
  return `Written: ${path}`;
}

/**
 * Search files by filename or content. Returns up to 50 results.
 *
 * Lists all keys under user prefix, checks filename matches first,
 * then fetches and searches content of text files.
 */
export async function searchFiles(
  bucket: R2Bucket,
  userPrefix: string,
  query: string
): Promise<string> {
  const queryLower = query.toLowerCase();
  const results: string[] = [];
  const maxResults = 50;

  // List all keys under user prefix (paginated)
  let cursor: string | undefined;
  const allKeys: string[] = [];

  do {
    const listed = await bucket.list({
      prefix: `${userPrefix}/`,
      cursor,
    });
    for (const obj of listed.objects) {
      allKeys.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const textExtensions = [".md", ".txt", ".csv", ".json", ".yaml", ".yml"];

  for (const key of allKeys) {
    if (results.length >= maxResults) break;

    const rel = key.slice(`${userPrefix}/`.length);
    const filename = rel.split("/").pop() ?? "";

    // Skip hidden files/dirs and internal files
    if (rel.split("/").some((part) => part.startsWith("."))) continue;
    if (filename.startsWith("_vault-bridge-")) continue;

    // Filename match
    if (filename.toLowerCase().includes(queryLower)) {
      results.push(`[name] ${rel}`);
      continue;
    }

    // Content match (text files only)
    const ext = filename.includes(".") ? `.${filename.split(".").pop()}` : "";
    if (textExtensions.includes(ext.toLowerCase())) {
      try {
        const object = await bucket.get(key);
        if (!object) continue;
        const text = await object.text();
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            const snippet = lines[i].trim().slice(0, 120);
            results.push(`[content] ${rel}:${i + 1}  ${snippet}`);
            break;
          }
        }
      } catch {
        continue;
      }
    }
  }

  if (results.length === 0) {
    return `No results found for: ${query}`;
  }
  return `Found ${results.length} result(s) for '${query}':\n${results.join("\n")}`;
}

/**
 * Handle an MCP tool call against R2.
 * Same interface as VaultSession.handleToolCall so the MCP handler can dispatch uniformly.
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
    case "search_files":
      return searchFiles(bucket, userPrefix, params.query as string);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
