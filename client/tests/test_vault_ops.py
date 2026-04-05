"""Unit tests for vault_ops — all four file operations + path sanitisation."""

import pytest
from pathlib import Path
from vault_bridge_client.vault_ops import (
    _safe_resolve,
    list_directory,
    read_file,
    write_file,
    search_files,
)


@pytest.fixture
def vault(tmp_path):
    """Create a minimal vault structure for testing."""
    # Directories
    (tmp_path / "notes").mkdir()
    (tmp_path / "daily").mkdir()
    (tmp_path / ".obsidian").mkdir()  # hidden, should be excluded

    # Files
    (tmp_path / "README.md").write_text("# My Vault\nWelcome to the vault.")
    (tmp_path / "notes" / "hello.md").write_text("Hello world\nThis is a test note.")
    (tmp_path / "notes" / "project.md").write_text("# Project\nTasks and plans.")
    (tmp_path / "daily" / "2026-04-05.md").write_text("Daily log for today.")
    (tmp_path / ".obsidian" / "config.json").write_text("{}")

    return tmp_path


# --- Path sanitisation ---


class TestSafeResolve:
    def test_empty_path_returns_vault_root(self, vault):
        assert _safe_resolve(vault, "") == vault
        assert _safe_resolve(vault, "  ") == vault

    def test_valid_relative_path(self, vault):
        result = _safe_resolve(vault, "notes/hello.md")
        assert result == (vault / "notes" / "hello.md").resolve()

    def test_traversal_blocked(self, vault):
        with pytest.raises(ValueError, match="Path traversal denied"):
            _safe_resolve(vault, "../outside.md")

    def test_traversal_via_nested_dotdot(self, vault):
        with pytest.raises(ValueError, match="Path traversal denied"):
            _safe_resolve(vault, "notes/../../outside.md")


# --- list_directory ---


class TestListDirectory:
    def test_root_listing(self, vault):
        entries = list_directory(vault)
        assert "daily/" in entries
        assert "notes/" in entries
        assert "README.md" in entries
        # Hidden dirs excluded
        assert ".obsidian/" not in entries

    def test_dirs_before_files(self, vault):
        entries = list_directory(vault)
        dir_indices = [i for i, e in enumerate(entries) if e.endswith("/")]
        file_indices = [i for i, e in enumerate(entries) if not e.endswith("/")]
        if dir_indices and file_indices:
            assert max(dir_indices) < min(file_indices)

    def test_subdirectory(self, vault):
        entries = list_directory(vault, "notes")
        assert "hello.md" in entries
        assert "project.md" in entries

    def test_empty_directory(self, vault):
        (vault / "empty").mkdir()
        entries = list_directory(vault, "empty")
        assert entries == []

    def test_not_a_directory(self, vault):
        with pytest.raises(NotADirectoryError):
            list_directory(vault, "README.md")


# --- read_file ---


class TestReadFile:
    def test_read_existing(self, vault):
        content = read_file(vault, "README.md")
        assert "My Vault" in content

    def test_read_nested(self, vault):
        content = read_file(vault, "notes/hello.md")
        assert "Hello world" in content

    def test_file_not_found(self, vault):
        with pytest.raises(FileNotFoundError):
            read_file(vault, "nonexistent.md")

    def test_directory_not_a_file(self, vault):
        with pytest.raises(FileNotFoundError):
            read_file(vault, "notes")


# --- write_file ---


class TestWriteFile:
    def test_write_new_file(self, vault):
        result = write_file(vault, "new.md", "New content")
        assert result == "Written: new.md"
        assert (vault / "new.md").read_text() == "New content"

    def test_write_creates_parents(self, vault):
        write_file(vault, "deep/nested/file.md", "Deep content")
        assert (vault / "deep" / "nested" / "file.md").read_text() == "Deep content"

    def test_overwrite_existing(self, vault):
        write_file(vault, "README.md", "Overwritten")
        assert (vault / "README.md").read_text() == "Overwritten"

    def test_traversal_blocked(self, vault):
        with pytest.raises(ValueError, match="Path traversal denied"):
            write_file(vault, "../escape.md", "bad")


# --- search_files ---


class TestSearchFiles:
    def test_filename_match(self, vault):
        results = search_files(vault, "hello")
        assert any("[name]" in r and "hello.md" in r for r in results)

    def test_content_match(self, vault):
        results = search_files(vault, "Tasks and plans")
        assert any("[content]" in r and "project.md" in r for r in results)

    def test_case_insensitive(self, vault):
        results = search_files(vault, "HELLO")
        assert any("hello.md" in r for r in results)

    def test_no_results(self, vault):
        results = search_files(vault, "zzz_nonexistent_zzz")
        assert results == []

    def test_hidden_dirs_excluded(self, vault):
        results = search_files(vault, "config")
        # .obsidian/config.json should NOT appear
        assert not any(".obsidian" in r for r in results)

    def test_max_results_cap(self, vault):
        # Create 60 files matching a query
        bulk = vault / "bulk"
        bulk.mkdir()
        for i in range(60):
            (bulk / f"match_{i}.md").write_text("filler")
        results = search_files(vault, "match_")
        assert len(results) <= 50
