"""Vault file operations — ported from v1 server.py.

Four operations against a local Obsidian vault directory.
All paths are relative to the vault root. Path traversal is blocked.
"""

from __future__ import annotations

import os
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
