/**
 * Minimal in-memory R2 bucket stand-in for unit tests. Implements only the
 * surface the r2-ops functions actually call: get/put/head/delete, plus the
 * `onlyIf` conditional support the version-guard relies on. The backing store
 * is exposed so tests can assert on raw keys (e.g. the index blob).
 */
export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

export interface MockR2Object {
  key: string;
  etag: string;
  /** Stands in for R2ObjectBody.body (a ReadableStream in production) — the
   *  mock put accepts the raw string, which is all moveFile's copy needs. */
  body: string;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface MockBucket {
  store: Map<string, string>;
  get(
    key: string,
    opts?: { onlyIf?: R2Conditional }
  ): Promise<MockR2Object | null>;
  put(
    key: string,
    value: string,
    opts?: { onlyIf?: R2Conditional }
  ): Promise<{ key: string; etag: string } | null>;
  head(key: string): Promise<{ key: string; etag: string } | null>;
  delete(key: string): Promise<void>;
}

/**
 * Deterministic content-derived ETag (djb2) — stands in for R2's MD5 etag.
 * Identical content → identical etag; any change → a different etag, which is
 * all the conditional `onlyIf` logic needs.
 */
function etagOf(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  }
  return `"${h.toString(16)}"`;
}

function conditionPasses(
  store: Map<string, string>,
  key: string,
  cond: R2Conditional | undefined
): boolean {
  if (!cond) return true;
  const exists = store.has(key);
  if (cond.etagMatches != null) {
    if (!exists || etagOf(store.get(key)!) !== cond.etagMatches) return false;
  }
  if (cond.etagDoesNotMatch != null) {
    if (exists && etagOf(store.get(key)!) === cond.etagDoesNotMatch) return false;
  }
  return true;
}

export function makeBucket(initial: Record<string, string> = {}): MockBucket {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      if (!conditionPasses(store, key, opts?.onlyIf)) return null;
      const val = store.get(key)!;
      return {
        key,
        etag: etagOf(val),
        body: val,
        httpMetadata: undefined,
        text: async () => val,
        json: async () => JSON.parse(val),
      };
    },
    async put(key, value, opts) {
      if (!conditionPasses(store, key, opts?.onlyIf)) return null;
      const str = typeof value === "string" ? value : String(value);
      store.set(key, str);
      return { key, etag: etagOf(str) };
    },
    async head(key) {
      return store.has(key) ? { key, etag: etagOf(store.get(key)!) } : null;
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
