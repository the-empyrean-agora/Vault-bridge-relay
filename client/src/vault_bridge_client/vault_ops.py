"""Vault file operations — ported from v1 server.py.

Four operations against a local Obsidian vault directory.
All paths are relative to the vault root. Path traversal is blocked.
"""

from __future__ import annotations

import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path


def _safe_resolve(vault_path: Path, relative_path: str) -> Path:
    """Resolve a relative path within the vault, preventing traversal attacks."""
    if not relative_path or not relative_path.strip():
        return vault_path
    target = (vault_path / relative_path).resolve()
    if not str(target).startswith(str(vault_path.resolve())):
        raise ValueError(f"Path traversal denied: {relative_path}")
    return target


def list_directory(vault_path: Path, path: str = "") -> list[str]:
    """List contents of a directory in the vault.

    Returns sorted entries: directories first (with trailing /), then files.
    Hidden entries (starting with .) are excluded.
    """
    target = _safe_resolve(vault_path, path)
    if not target.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    lines = []
    for entry in entries:
        if entry.name.startswith("."):
            continue
        lines.append(f"{entry.name}/" if entry.is_dir() else entry.name)
    return lines


def read_file(vault_path: Path, path: str) -> str:
    """Read a file from the vault by relative path."""
    target = _safe_resolve(vault_path, path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    return target.read_text(encoding="utf-8", errors="replace")


def write_file(vault_path: Path, path: str, content: str) -> str:
    """Create or overwrite a file in the vault. Creates parent directories as needed."""
    target = _safe_resolve(vault_path, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Written: {path}"


def search_files(vault_path: Path, query: str) -> list[str]:
    """Search for files by filename or content. Returns up to 50 results.

    Searches filenames first, then file contents (text files only).
    """
    query_lower = query.lower()
    results: list[str] = []
    max_results = 50

    for root, dirs, files in os.walk(vault_path):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for filename in files:
            if len(results) >= max_results:
                break
            filepath = Path(root) / filename
            rel = filepath.relative_to(vault_path).as_posix()

            if query_lower in filename.lower():
                results.append(f"[name] {rel}")
                continue

            if filepath.suffix in (".md", ".txt", ".csv", ".json", ".yaml", ".yml"):
                try:
                    text = filepath.read_text(encoding="utf-8", errors="replace")
                    for i, line in enumerate(text.splitlines(), 1):
                        if query_lower in line.lower():
                            snippet = line.strip()[:120]
                            results.append(f"[content] {rel}:{i}  {snippet}")
                            break
                except OSError:
                    continue

    return results


def delete_file(vault_path: Path, path: str) -> str:
    """Permanently delete a file from the vault."""
    target = _safe_resolve(vault_path, path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    target.unlink()
    return f"Deleted: {path}"


def _normalize_for_match(text: str) -> str:
    """Canonicalise text before matching so an edit isn't defeated by invisible
    encoding differences between what read_file emitted and what the caller
    re-typed. Normalises line endings (CRLF / lone CR → LF) and Unicode to NFC.

    See the R2-mode twin (relay/src/r2-ops.ts:normalizeForMatch) for the full
    rationale and the 2026-06-16 regression this fixes. Python's read_text
    already collapses CRLF on read, so the line-ending step is mostly defensive
    here; NFC is the half relay mode was missing.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return unicodedata.normalize("NFC", text)


def _today_iso() -> str:
    """Today's date as ISO YYYY-MM-DD (UTC)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _bump_updated_frontmatter(content: str) -> str:
    """Set an `updated:` frontmatter field to today's date if one exists.

    Returns content unchanged when there is no frontmatter or no `updated:`
    field — frontmatter is never injected.
    """
    fm = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not fm:
        return content
    block = fm.group(0)
    if not re.search(r"^updated:[ \t]*.*$", block, re.MULTILINE):
        return content
    new_block = re.sub(
        r"^(updated:[ \t]*).*$",
        r"\g<1>" + _today_iso(),
        block,
        count=1,
        flags=re.MULTILINE,
    )
    return new_block + content[len(block):]


def edit_range(
    vault_path: Path,
    path: str,
    old_string: str | None = None,
    new_string: str | None = None,
    replace_all: bool = False,
    *,
    old_str: str | None = None,
    new_str: str | None = None,
) -> str:
    """Surgically replace an exact text span in an existing file.

    Mirrors Claude Code's Edit tool: everything outside the matched span is
    preserved byte-for-byte. Errors (with no write) on zero matches, or on more
    than one match when replace_all is false. Bumps an `updated:` frontmatter
    field to today's date on success.

    Canonical args are old_string/new_string; the abbreviated old_str/new_str
    spelling some MCP callers use is accepted too (mirrors the R2-mode dispatch).
    """
    if not isinstance(path, str) or path.strip() == "":
        raise ValueError("missing required argument: path")
    # Accept the abbreviated spelling, then validate — so a missing/misnamed arg
    # gives a clean error instead of a TypeError deep in the match path.
    if old_string is None:
        old_string = old_str
    if new_string is None:
        new_string = new_str
    if not isinstance(old_string, str) or old_string == "":
        raise ValueError("old_string is required and must be a non-empty string")
    if not isinstance(new_string, str):
        raise ValueError("new_string is required and must be a string")

    target = _safe_resolve(vault_path, path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    content = _normalize_for_match(
        target.read_text(encoding="utf-8", errors="replace")
    )
    old = _normalize_for_match(old_string)
    new = _normalize_for_match(new_string)

    count = content.count(old) if old else 0
    if count == 0:
        raise ValueError(f"old_string not found in {path}")
    if count > 1 and not replace_all:
        raise ValueError(
            f"old_string is not unique in {path} ({count} matches); "
            "add surrounding context or set replace_all"
        )

    if replace_all:
        updated = content.replace(old, new)
    else:
        updated = content.replace(old, new, 1)

    updated = _bump_updated_frontmatter(updated)
    target.write_text(updated, encoding="utf-8")

    if replace_all and count > 1:
        return f"Edited: {path} ({count} occurrences)"
    return f"Edited: {path}"


# --- Index-style parsing (mirrors the TS index-format parser used in R2 mode) ---


def _extract_links(content: str) -> list[str]:
    """Outgoing links: wikilinks ([[Page]]) and markdown links to .md files."""
    seen: set[str] = set()
    out: list[str] = []
    for m in re.finditer(r"\[\[([^\]\|#]+)", content):
        link = m.group(1).strip()
        if link and link not in seen:
            seen.add(link)
            out.append(link)
    for m in re.finditer(r"\[[^\]]*\]\(([^)]+\.md)\)", content):
        link = m.group(1).strip()
        if link and link not in seen:
            seen.add(link)
            out.append(link)
    return out


def _extract_tags(content: str) -> list[str]:
    """Inline (#tag) and frontmatter tags, lowercased and de-duplicated."""
    seen: set[str] = set()
    out: list[str] = []

    for m in re.finditer(r"(?:^|\s)#([\w/-]+)", content):
        tag = m.group(1).lower()
        if tag not in seen:
            seen.add(tag)
            out.append(tag)

    fm = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if fm:
        block = fm.group(1)
        # tags: [a, b] or tags: a, b  (inline, same line only)
        inline = re.search(r"^tags:[ \t]*\[?(.+?)\]?[ \t]*$", block, re.MULTILINE)
        if inline:
            for raw in inline.group(1).split(","):
                tag = re.sub(r"['\"#]", "", raw.strip()).lower()
                if tag and tag not in seen:
                    seen.add(tag)
                    out.append(tag)
        # tags:\n  - a\n  - b  (list form)
        listmatch = re.search(
            r"^tags:[ \t]*\n((?:[ \t]*-[ \t]*.+\n?)+)", block, re.MULTILINE
        )
        if listmatch:
            for item in re.findall(r"-[ \t]*(.+)", listmatch.group(1)):
                tag = re.sub(r"['\"#]", "", item.strip()).lower()
                if tag and tag not in seen:
                    seen.add(tag)
                    out.append(tag)

    return out


def _link_matches_path(link: str, path: str) -> bool:
    """True if a wikilink/markdown link target resolves to the given path."""
    path_no_ext = re.sub(r"\.md$", "", path)
    filename = path_no_ext.split("/")[-1]
    return link in (path, path_no_ext, filename)


def _iter_vault_files(vault_path: Path):
    """Yield (filepath, relative_posix_path) for every non-hidden file."""
    for root, dirs, files in os.walk(vault_path):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for filename in files:
            if filename.startswith("."):
                continue
            filepath = Path(root) / filename
            yield filepath, filepath.relative_to(vault_path).as_posix()


def get_backlinks(vault_path: Path, path: str) -> str:
    """Find all files that link TO the given path via wikilinks/markdown links."""
    backlinks: list[str] = []
    for filepath, rel in _iter_vault_files(vault_path):
        if rel == path or filepath.suffix != ".md":
            continue
        try:
            text = filepath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for link in _extract_links(text):
            if _link_matches_path(link, path):
                backlinks.append(rel)
                break

    if not backlinks:
        return f"No files link to {path}"
    backlinks.sort()
    return f"{len(backlinks)} file(s) linking to {path}:\n" + "\n".join(backlinks)


def list_tags(vault_path: Path) -> str:
    """List every unique tag in the vault with usage counts, most-used first."""
    counts: dict[str, int] = {}
    for filepath, _rel in _iter_vault_files(vault_path):
        if filepath.suffix != ".md":
            continue
        try:
            text = filepath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for tag in _extract_tags(text):
            counts[tag] = counts.get(tag, 0) + 1

    if not counts:
        return "No tags found in vault."
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    lines = [f"#{tag} ({count})" for tag, count in ordered]
    return f"{len(counts)} unique tag(s):\n" + "\n".join(lines)


def get_recent_files(vault_path: Path, days: int = 7, limit: int = 25) -> str:
    """List files modified in the last N days, most recent first."""
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    recent: list[tuple[str, float]] = []
    for filepath, rel in _iter_vault_files(vault_path):
        try:
            mtime = filepath.stat().st_mtime
        except OSError:
            continue
        if mtime >= cutoff:
            recent.append((rel, mtime))

    recent.sort(key=lambda x: x[1], reverse=True)
    top = recent[:limit]
    if not top:
        return f"No files modified in the last {days} day(s)."
    lines = [
        f"{rel}  ({datetime.fromtimestamp(mtime, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})"
        for rel, mtime in top
    ]
    return (
        f"{len(top)} of {len(recent)} file(s) modified in the last {days} day(s):\n"
        + "\n".join(lines)
    )


def get_outgoing_links(vault_path: Path, path: str) -> str:
    """List the notes a file links OUT to (mirror of get_backlinks)."""
    target = _safe_resolve(vault_path, path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    links = _extract_links(target.read_text(encoding="utf-8", errors="replace"))
    if not links:
        return f"{path} has no outgoing links."
    links_sorted = sorted(links)
    return f"{len(links_sorted)} outgoing link(s) from {path}:\n" + "\n".join(links_sorted)


# --- Frontmatter querying (get_files_by_frontmatter) ---

_FM_QUERY_RE = re.compile(r"^([A-Za-z0-9_-]+)\s*(>=|<=|>|<|:)\s*(.*)$")


def _unquote(s: str) -> str:
    return re.sub(r"^['\"]|['\"]$", "", s)


def _frontmatter_block(text: str) -> str | None:
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    return m.group(1) if m else None


def _parse_frontmatter(block: str) -> dict:
    """Parse scalar and simple list fields from a YAML frontmatter block."""
    out: dict = {}
    lines = block.split("\n")
    i = 0
    while i < len(lines):
        m = re.match(r"^([A-Za-z0-9_-]+):[ \t]*(.*)$", lines[i])
        if not m:
            i += 1
            continue
        key, rest = m.group(1), m.group(2).strip()
        if rest == "":
            items = []
            j = i + 1
            while j < len(lines) and re.match(r"^[ \t]*-[ \t]*\S", lines[j]):
                items.append(_unquote(re.sub(r"^[ \t]*-[ \t]*", "", lines[j]).strip()))
                j += 1
            out[key] = items if items else ""
            i = j if items else i + 1
        elif rest.startswith("[") and rest.endswith("]"):
            out[key] = [_unquote(s.strip()) for s in rest[1:-1].split(",") if s.strip()]
            i += 1
        else:
            out[key] = _unquote(rest)
            i += 1
    return out


def _compare_scalar(a: str, b: str) -> int:
    try:
        na, nb = float(a), float(b)
        return (na > nb) - (na < nb)
    except ValueError:
        return (a > b) - (a < b)


def _matches_condition(fm: dict, field: str, op: str, value: str) -> tuple[bool, str]:
    if field not in fm:
        return False, ""
    raw = fm[field]
    values = raw if isinstance(raw, list) else [raw]
    display = ", ".join(raw) if isinstance(raw, list) else str(raw)
    if op == ":":
        if value == "*":
            return True, display
        wanted = value.lower()
        for v in values:
            if str(v).lower() == wanted:
                return True, display
        return False, ""
    v = str(values[0])
    cmp = _compare_scalar(v, value)
    ok = (
        (op == ">" and cmp > 0)
        or (op == "<" and cmp < 0)
        or (op == ">=" and cmp >= 0)
        or (op == "<=" and cmp <= 0)
    )
    return (True, v) if ok else (False, "")


def get_files_by_frontmatter(vault_path: Path, query: str) -> str:
    """Find notes by a single YAML frontmatter condition (mirror of R2 mode)."""
    cond = _FM_QUERY_RE.match(query.strip())
    if not cond:
        return (
            f"Could not parse query '{query}'. Use forms like "
            "'status: seedling' or 'updated > 2026-01-01'."
        )
    field, op, value = cond.group(1), cond.group(2), cond.group(3).strip()
    matches: list[tuple[str, str]] = []
    for filepath, rel in _iter_vault_files(vault_path):
        if filepath.suffix != ".md":
            continue
        try:
            text = filepath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        block = _frontmatter_block(text)
        if not block:
            continue
        ok, matched = _matches_condition(_parse_frontmatter(block), field, op, value)
        if ok:
            matches.append((rel, matched))
    if not matches:
        return f"No files match frontmatter '{query}'."
    matches.sort(key=lambda x: x[0])
    top = matches[:100]
    suffix = " (showing first 100)" if len(matches) > 100 else ""
    lines = [f"{rel}  ({field}: {val})" for rel, val in top]
    return f"{len(matches)} file(s) match '{query}'{suffix}:\n" + "\n".join(lines)


# --- Section-aware append (append_to_section) ---


def _heading_level(line: str) -> int:
    m = re.match(r"^(#{1,6})\s+\S", line)
    return len(m.group(1)) if m else 0


def _heading_text(line: str) -> str:
    return re.sub(r"^#{1,6}\s+", "", line).strip()


def _strip_trailing_blanks(arr: list[str]) -> list[str]:
    end = len(arr)
    while end > 0 and arr[end - 1].strip() == "":
        end -= 1
    return arr[:end]


def _strip_leading_blanks(arr: list[str]) -> list[str]:
    start = 0
    while start < len(arr) and arr[start].strip() == "":
        start += 1
    return arr[start:]


def append_to_section(
    vault_path: Path,
    path: str,
    heading: str | None = None,
    content: str | None = None,
    position: str = "end",
) -> str:
    """Insert content under a markdown heading without resending the file.

    Mirrors the R2-mode appendToSection. The heading must resolve to exactly one
    section; "end" inserts before the next heading of equal/higher level (or
    EOF), "start" immediately after the heading. Bumps `updated:` on success.
    """
    if not isinstance(path, str) or path.strip() == "":
        raise ValueError("missing required argument: path")
    if not isinstance(heading, str) or heading.strip() == "":
        raise ValueError("heading is required and must be a non-empty string")
    if not isinstance(content, str):
        raise ValueError("content is required and must be a string")
    position = "start" if position == "start" else "end"

    target = _safe_resolve(vault_path, path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    lines = _normalize_for_match(
        target.read_text(encoding="utf-8", errors="replace")
    ).split("\n")

    wanted = heading.strip()
    idxs = [
        i
        for i, line in enumerate(lines)
        if _heading_level(line) > 0 and _heading_text(line) == wanted
    ]
    if not idxs:
        raise ValueError(f'heading not found in {path}: "{wanted}"')
    if len(idxs) > 1:
        raise ValueError(
            f'heading is not unique in {path} ({len(idxs)} matches): "{wanted}"'
        )

    h = idxs[0]
    level = _heading_level(lines[h])
    add_lines = re.sub(r"\n+$", "", content).split("\n")

    if position == "start":
        head = lines[: h + 1]
        body = _strip_leading_blanks(lines[h + 1 :])
        merged = head + [""] + add_lines + ([""] + body if body else [])
    else:
        end = len(lines)
        for i in range(h + 1, len(lines)):
            lv = _heading_level(lines[i])
            if 0 < lv <= level:
                end = i
                break
        head = _strip_trailing_blanks(lines[:end])
        tail = lines[end:]
        merged = head + [""] + add_lines
        if tail:
            merged = merged + [""] + _strip_leading_blanks(tail)

    updated = "\n".join(merged)
    if not updated.endswith("\n"):
        updated += "\n"
    updated = _bump_updated_frontmatter(updated)
    target.write_text(updated, encoding="utf-8")
    return f'Appended to "{wanted}" in {path}'


def read_section(vault_path: Path, path: str, heading: str | None = None) -> str:
    """Read one section of a note: the heading through to the next heading of
    equal/higher level. Heading must resolve to exactly one section."""
    if not isinstance(heading, str) or heading.strip() == "":
        raise ValueError("heading is required and must be a non-empty string")
    target = _safe_resolve(vault_path, path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    lines = _normalize_for_match(
        target.read_text(encoding="utf-8", errors="replace")
    ).split("\n")

    wanted = heading.strip()
    idxs = [
        i
        for i, line in enumerate(lines)
        if _heading_level(line) > 0 and _heading_text(line) == wanted
    ]
    if not idxs:
        raise ValueError(f'heading not found in {path}: "{wanted}"')
    if len(idxs) > 1:
        raise ValueError(
            f'heading is not unique in {path} ({len(idxs)} matches): "{wanted}"'
        )

    h = idxs[0]
    level = _heading_level(lines[h])
    end = len(lines)
    for i in range(h + 1, len(lines)):
        lv = _heading_level(lines[i])
        if 0 < lv <= level:
            end = i
            break
    return "\n".join(_strip_trailing_blanks(lines[h:end]))


def read_frontmatter(vault_path: Path, path: str) -> str:
    """Read just the YAML frontmatter block of a note (without the body)."""
    target = _safe_resolve(vault_path, path)
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    block = _frontmatter_block(
        _normalize_for_match(target.read_text(encoding="utf-8", errors="replace"))
    )
    return f"No frontmatter in {path}." if block is None else block


def resolve_wikilink(vault_path: Path, link: str) -> str:
    """Resolve a wikilink target to the actual vault path(s)."""
    if not isinstance(link, str) or link.strip() == "":
        raise ValueError("link is required and must be a non-empty string")
    cleaned = link.strip()
    cleaned = re.sub(r"^\[\[", "", cleaned)
    cleaned = re.sub(r"\]\]$", "", cleaned)
    cleaned = cleaned.split("|")[0].split("#")[0].strip()
    if cleaned == "":
        raise ValueError(f'Could not parse a link target from "{link}"')

    matches = [
        rel
        for _fp, rel in _iter_vault_files(vault_path)
        if _link_matches_path(cleaned, rel)
    ]
    if not matches:
        return f"No file resolves to [[{cleaned}]]."
    if len(matches) == 1:
        return matches[0]
    matches.sort()
    return f"{len(matches)} files resolve to [[{cleaned}]]:\n" + "\n".join(matches)


def create_file(vault_path: Path, path: str, content: str | None = None) -> str:
    """Create a NEW file, erroring if one already exists (create-only)."""
    if not isinstance(content, str):
        raise ValueError("content is required and must be a string")
    target = _safe_resolve(vault_path, path)
    if target.exists():
        raise FileExistsError(
            f"File already exists: {path} (use write_file to overwrite)"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Created: {path}"


def move_file(
    vault_path: Path,
    from_path: str | None = None,
    to_path: str | None = None,
) -> str:
    """Move or rename a file within the vault — metadata-only, content untouched.

    Mirrors the R2-mode moveFile: errors if the source is missing or the
    destination already exists (a move never overwrites). Creates the
    destination's parent directories as needed. Deliberately does NOT prune an
    emptied source folder (no os.renames) — Obsidian folders are real
    directories the user may want to keep.

    The MCP params are `from`/`to`; the dispatch remaps them to
    from_path/to_path because `from` is a Python keyword.
    """
    if not isinstance(from_path, str) or from_path.strip() == "":
        raise ValueError("missing required argument: from")
    if not isinstance(to_path, str) or to_path.strip() == "":
        raise ValueError("missing required argument: to")

    src = _safe_resolve(vault_path, from_path)
    dest = _safe_resolve(vault_path, to_path)
    if not src.is_file():
        raise FileNotFoundError(f"File not found: {from_path}")
    if src == dest:
        raise ValueError(f"Cannot move {from_path} onto itself")
    # Allow a case-only rename on case-insensitive filesystems (dest "exists"
    # but is the same file); block every other existing destination.
    if dest.exists() and not dest.samefile(src):
        raise FileExistsError(
            f"Destination already exists: {to_path} — a move never overwrites; "
            "delete it first or pick another path"
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dest)
    return f"Moved: {from_path} → {to_path}"


_GENERIC_ORIENTATION = (
    "No orientation file found in this vault.\n\n"
    "Create a `_BOOTSTRAP.md` (preferred) or `CLAUDE.md` at the vault root to\n"
    "define the rules, conventions, and entry ritual Claude should follow here.\n"
    "Until then: explore with list_directory and read_file before writing, prefer\n"
    "edit_range over write_file for changes to existing notes, and ask the user\n"
    "about their preferred structure."
)


def begin_session(vault_path: Path) -> str:
    """Return the vault's orientation file (_BOOTSTRAP.md → CLAUDE.md → generic)."""
    for name in ("_BOOTSTRAP.md", "CLAUDE.md"):
        candidate = vault_path / name
        if candidate.is_file():
            text = candidate.read_text(encoding="utf-8", errors="replace")
            return f"# Vault orientation (from {name})\n\n{text}"
    return _GENERIC_ORIENTATION
