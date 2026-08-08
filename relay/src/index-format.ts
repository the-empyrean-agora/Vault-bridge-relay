/**
 * Vault index format and parser.
 *
 * The index is a single JSON blob in R2 (`{prefix}/_vault-bridge-index.json`)
 * that holds search tokens, tags, outgoing links, and a preview snippet for
 * every file in the vault. It replaces the old manifest with a richer
 * structure: it still contains hash/modified/size for sync diffing, plus
 * everything needed to power search, backlinks, tag lookup, etc. without
 * scanning files at query time.
 *
 * IMPORTANT: This parser is the canonical source of truth and is duplicated
 * verbatim into the obsidian-plugin repo. If you change it here, mirror the
 * change there. The plugin and Worker MUST produce identical entries for the
 * same input or the index will get noisy and inconsistent.
 */

export interface FileIndexEntry {
  hash: string;
  modified: string;
  size: number;
  preview: string;
  tokens: string[];
  filenameTokens: string[];
  tags: string[];
  links: string[];
}

export interface VaultIndex {
  version: 1;
  files: Record<string, FileIndexEntry>;
  lastUpdated: string;
}

export const EMPTY_INDEX: VaultIndex = {
  version: 1,
  files: {},
  lastUpdated: new Date(0).toISOString(),
};

// --- Parser ---

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "can",
  "this", "that", "these", "those", "i", "you", "he", "she", "it",
  "we", "they", "them", "to", "of", "in", "on", "at", "by", "for",
  "with", "from", "as", "if", "so", "no", "not", "but",
]);

export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = text.toLowerCase().split(/[^\w]+/);
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Filter for inline (#tag in body) candidates. Frontmatter tags are the user's
 * explicit declaration and are NOT filtered — only body-scanned tags, which is
 * where the noise comes from (CSS hex values, bare numbers, URL/id fragments).
 */
function isPlausibleInlineTag(t: string): boolean {
  if (t.length < 2) return false; // single letters: #a, #c
  if (/^[0-9-]+$/.test(t)) return false; // bare numbers / invoice ids: #1, #2998-2142-5237
  if (/^[0-9a-f]{3}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(t)) return false; // hex colours: #fff, #fafaf7, #ffffff
  return true;
}

function extractTags(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string) => {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };

  // Inline tags: #tag, #tag/sub, #tag-with-dash. Strip fenced and inline code
  // first so CSS hex values and #-comments inside code aren't read as tags,
  // then filter obvious non-tags (see isPlausibleInlineTag).
  const prose = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  const inlineRegex = /(?:^|\s)#([\w/-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRegex.exec(prose)) !== null) {
    const tag = m[1].toLowerCase();
    if (isPlausibleInlineTag(tag)) add(tag);
  }

  // Frontmatter tags (explicit — not junk-filtered).
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];

    // Flow form on the SAME line: `tags: [a, b, c]` or `tags: a, b, c`.
    // [ \t]* (not \s*) so it cannot swallow the newline into a list form and
    // capture the first "- item" with its bullet (the #- tools bug).
    const inlineTagsMatch = fm.match(/^tags:[ \t]*\[?(.+?)\]?[ \t]*$/m);
    if (inlineTagsMatch) {
      for (const t of inlineTagsMatch[1].split(",")) {
        add(t.trim().replace(/['"#]/g, "").toLowerCase());
      }
    }

    // List form: tags:\n  - a\n  - b
    const listMatch = fm.match(/^tags:[ \t]*\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
    if (listMatch) {
      const items = listMatch[1].match(/-[ \t]*(.+)/g);
      if (items) {
        for (const item of items) {
          add(item.replace(/^-[ \t]*/, "").trim().replace(/['"#]/g, "").toLowerCase());
        }
      }
    }
  }

  return out;
}

function extractLinks(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // Wikilinks: [[Page]] or [[Page|alias]] or [[Page#section]] or [[folder/Page]]
  const wikiRegex = /\[\[([^\]\|#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRegex.exec(content)) !== null) {
    const link = m[1].trim();
    if (link && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }

  // Markdown links: [text](path.md) — only local .md links
  const mdRegex = /\[[^\]]*\]\(([^)]+\.md)\)/g;
  while ((m = mdRegex.exec(content)) !== null) {
    const link = m[1].trim();
    if (link && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }

  return out;
}

function extractPreview(content: string): string {
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return stripped.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Build an index entry from a file's content and metadata.
 */
export function parseFile(
  content: string,
  hash: string,
  modified: string,
  size: number,
  filename: string
): FileIndexEntry {
  // Normalise line endings (CRLF/lone CR → LF) and Unicode (→ NFC) BEFORE
  // extraction. The frontmatter/preview regexes anchor on \n, so a CRLF file
  // (~5% of a Windows-authored vault) would otherwise yield zero tags and an
  // unstripped preview. Only the extracted text is normalised — `hash` and
  // `size` are computed by the caller on the original bytes so they stay
  // identical to the plugin's computation (CAS / If-Match depend on that).
  const text = content.replace(/\r\n?/g, "\n").normalize("NFC");
  return {
    hash,
    modified,
    size,
    preview: extractPreview(text),
    tokens: tokenize(text),
    filenameTokens: tokenize(filename),
    tags: extractTags(text),
    links: extractLinks(text),
  };
}

/**
 * Resolve a wikilink target to a candidate set of paths in an index.
 * Wikilinks may be bare names ("Hello") or paths ("notes/Hello").
 * Returns possible matches without the .md extension stripping issue.
 */
export function linkMatchesPath(link: string, path: string): boolean {
  // Strip .md from path for comparison
  const pathNoExt = path.replace(/\.md$/, "");
  const filename = pathNoExt.split("/").pop() ?? pathNoExt;

  return link === path || link === pathNoExt || link === filename;
}
