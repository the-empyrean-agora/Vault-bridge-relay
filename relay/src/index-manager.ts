/**
 * Index manager — read, update, and write the vault index in R2.
 *
 * The index is stored at `{userPrefix}/_vault-bridge-index.json` as a single
 * JSON blob. Reads return an empty index if the file is missing or corrupt
 * rather than throwing — the index is best-effort and self-healing.
 *
 * Writes are not protected by conditional headers (etag matching). For our
 * scale (1-2 users, small vaults), the race window between Worker writes and
 * plugin full-rebuilds is brief and the plugin's next sync will reconcile.
 */

import {
  EMPTY_INDEX,
  parseFile,
  type FileIndexEntry,
  type VaultIndex,
} from "./index-format.js";

const INDEX_KEY_SUFFIX = "/_vault-bridge-index.json";

function indexKey(userPrefix: string): string {
  return `${userPrefix}${INDEX_KEY_SUFFIX}`;
}

/**
 * Load the index for a user. Returns an empty index if missing or corrupt.
 */
export async function loadIndex(
  bucket: R2Bucket,
  userPrefix: string
): Promise<VaultIndex> {
  const obj = await bucket.get(indexKey(userPrefix));
  if (!obj) {
    return { ...EMPTY_INDEX, files: {} };
  }
  try {
    const parsed = (await obj.json()) as VaultIndex;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.files &&
      typeof parsed.files === "object"
    ) {
      return parsed;
    }
  } catch {
    // Fall through to empty
  }
  return { ...EMPTY_INDEX, files: {} };
}

/**
 * Persist the index. Sets `lastUpdated` to now.
 */
export async function saveIndex(
  bucket: R2Bucket,
  userPrefix: string,
  index: VaultIndex
): Promise<void> {
  index.lastUpdated = new Date().toISOString();
  await bucket.put(indexKey(userPrefix), JSON.stringify(index), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Add or replace a single file's entry in the index.
 */
export async function setIndexEntry(
  bucket: R2Bucket,
  userPrefix: string,
  path: string,
  entry: FileIndexEntry
): Promise<void> {
  const index = await loadIndex(bucket, userPrefix);
  index.files[path] = entry;
  await saveIndex(bucket, userPrefix, index);
}

/**
 * Remove a single file's entry from the index.
 */
export async function removeIndexEntry(
  bucket: R2Bucket,
  userPrefix: string,
  path: string
): Promise<void> {
  const index = await loadIndex(bucket, userPrefix);
  if (path in index.files) {
    delete index.files[path];
    await saveIndex(bucket, userPrefix, index);
  }
}

/**
 * Build a full index entry from a file's text content. Computes the SHA-256
 * hash and runs the shared parser to extract tokens, tags, links, and preview.
 * This matches the plugin's local computation byte-for-byte so index state
 * stays consistent whether a write came from the plugin or from an MCP tool.
 */
export async function buildEntryFromContent(
  content: string,
  path: string,
  modifiedISO: string = new Date().toISOString()
): Promise<FileIndexEntry> {
  const buf = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  const hash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const filename = path.split("/").pop() ?? path;
  return parseFile(content, hash, modifiedISO, buf.byteLength, filename);
}
