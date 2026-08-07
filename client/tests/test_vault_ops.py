"""Unit tests for vault_ops — all four file operations + path sanitisation."""

import os
import unicodedata
from datetime import datetime, timezone

import pytest
from pathlib import Path
from vault_bridge_client.vault_ops import (
    _safe_resolve,
    list_directory,
    read_file,
    write_file,
    search_files,
    delete_file,
    edit_range,
    get_backlinks,
    list_tags,
    get_recent_files,
    begin_session,
    get_outgoing_links,
    get_files_by_frontmatter,
    append_to_section,
    read_section,
    read_frontmatter,
    resolve_wikilink,
    create_file,
    move_file,
)

TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")


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


# --- delete_file ---


class TestDeleteFile:
    def test_delete_existing(self, vault):
        result = delete_file(vault, "README.md")
        assert result == "Deleted: README.md"
        assert not (vault / "README.md").exists()

    def test_delete_not_found(self, vault):
        with pytest.raises(FileNotFoundError):
            delete_file(vault, "nope.md")

    def test_traversal_blocked(self, vault):
        with pytest.raises(ValueError, match="Path traversal denied"):
            delete_file(vault, "../escape.md")


# --- edit_range ---


class TestEditRange:
    def test_unique_replace(self, vault):
        result = edit_range(vault, "notes/hello.md", "Hello world", "Goodbye world")
        assert result == "Edited: notes/hello.md"
        assert (vault / "notes" / "hello.md").read_text().startswith("Goodbye world")

    def test_not_found_errors_and_no_write(self, vault):
        before = (vault / "notes" / "hello.md").read_text()
        with pytest.raises(ValueError, match="old_string not found"):
            edit_range(vault, "notes/hello.md", "absent text", "x")
        assert (vault / "notes" / "hello.md").read_text() == before

    def test_not_unique_errors_and_no_write(self, vault):
        (vault / "dup.md").write_text("ping\nping\n")
        with pytest.raises(ValueError, match=r"not unique in dup.md \(2 matches\)"):
            edit_range(vault, "dup.md", "ping", "pong")
        assert (vault / "dup.md").read_text() == "ping\nping\n"

    def test_replace_all(self, vault):
        (vault / "dup.md").write_text("ping\nping\n")
        result = edit_range(vault, "dup.md", "ping", "pong", replace_all=True)
        assert result == "Edited: dup.md (2 occurrences)"
        assert (vault / "dup.md").read_text() == "pong\npong\n"

    def test_missing_file_errors(self, vault):
        with pytest.raises(FileNotFoundError):
            edit_range(vault, "nope.md", "a", "b")

    def test_bumps_updated_frontmatter(self, vault):
        content = "---\ntitle: T\nupdated: 2025-01-01\n---\n\nBody text.\n"
        (vault / "fm.md").write_text(content)
        edit_range(vault, "fm.md", "Body text.", "New body.")
        out = (vault / "fm.md").read_text()
        assert f"updated: {TODAY}" in out
        assert "updated: 2025-01-01" not in out
        assert "New body." in out

    def test_no_updated_field_not_injected(self, vault):
        content = "---\ntitle: T\n---\n\nBody text.\n"
        (vault / "fm2.md").write_text(content)
        edit_range(vault, "fm2.md", "Body text.", "New body.")
        out = (vault / "fm2.md").read_text()
        assert "updated:" not in out
        assert out == "---\ntitle: T\n---\n\nNew body.\n"

    def test_no_frontmatter_no_injection(self, vault):
        (vault / "plain.md").write_text("Just text here.\n")
        edit_range(vault, "plain.md", "text", "words")
        out = (vault / "plain.md").read_text()
        assert out == "Just words here.\n"
        assert not out.startswith("---")

    def test_preserves_wikilinks_byte_for_byte(self, vault):
        content = "# H\n\nSee [[Other]] and [text](notes/project.md).\n\nTarget line.\n"
        (vault / "links.md").write_text(content)
        edit_range(vault, "links.md", "Target line.", "Edited line.")
        out = (vault / "links.md").read_text()
        assert out == content.replace("Target line.", "Edited line.")
        assert "[[Other]]" in out

    # --- Regression: 2026-06-16 normalisation mismatch (see r2-ops.ts twin) ---

    def test_matches_crlf_file_with_lf_old_string(self, vault):
        # Plant real CRLF bytes (write_bytes bypasses text-mode translation).
        (vault / "crlf.md").write_bytes(b"alpha\r\nbeta surfaces | gamma\r\ndelta\r\n")
        result = edit_range(vault, "crlf.md", "surfaces |", "surfaces ||")
        assert result == "Edited: crlf.md"
        # read_text collapses CRLF, so compare in LF space.
        assert (vault / "crlf.md").read_text() == "alpha\nbeta surfaces || gamma\ndelta\n"

    def test_matches_nfd_stored_with_nfc_old_string(self, vault):
        # Build e-acute from a code point so the source stays pure-ASCII and
        # the test can't be skewed by this file's own on-disk encoding.
        e = chr(0x00E9)  # U+00E9, the single composed NFC form
        nfc_old = "caf" + e + " au lait"
        stored = unicodedata.normalize("NFD", "Title: " + nfc_old + "\n")
        (vault / "nfd.md").write_bytes(stored.encode("utf-8"))
        result = edit_range(vault, "nfd.md", nfc_old, "caf" + e)
        assert result == "Edited: nfd.md"
        # Read back as UTF-8 (Windows' default read_text encoding is cp1252,
        # which would mojibake the é that edit_range wrote as UTF-8).
        assert (vault / "nfd.md").read_text(encoding="utf-8") == "Title: caf" + e + "\n"

    # --- Regression: 2026-06-16 (round 2) param aliases + clean errors ---

    def test_accepts_old_str_new_str_aliases(self, vault):
        result = edit_range(vault, "notes/hello.md", old_str="Hello world", new_str="Hi world")
        assert result == "Edited: notes/hello.md"
        assert read_file(vault, "notes/hello.md").startswith("Hi world")

    def test_missing_old_string_errors_cleanly(self, vault):
        before = read_file(vault, "notes/hello.md")
        with pytest.raises(ValueError, match="old_string is required"):
            edit_range(vault, "notes/hello.md", None, "x")
        assert read_file(vault, "notes/hello.md") == before

    def test_missing_path_errors_cleanly(self, vault):
        with pytest.raises(ValueError, match="missing required argument: path"):
            edit_range(vault, "", "a", "b")


# --- get_backlinks ---


class TestGetBacklinks:
    def test_wikilink_backlink(self, vault):
        (vault / "a.md").write_text("Links to [[hello]] here.")
        result = get_backlinks(vault, "notes/hello.md")
        assert "a.md" in result

    def test_markdown_backlink(self, vault):
        (vault / "b.md").write_text("See [the note](notes/project.md).")
        result = get_backlinks(vault, "notes/project.md")
        assert "b.md" in result

    def test_no_backlinks(self, vault):
        result = get_backlinks(vault, "notes/hello.md")
        assert result == "No files link to notes/hello.md"


# --- list_tags ---


class TestListTags:
    def test_inline_and_frontmatter_tags(self, vault):
        (vault / "t1.md").write_text("Body with #project and #idea tags.")
        (vault / "t2.md").write_text("---\ntags: [project, work]\n---\n\nBody.")
        result = list_tags(vault)
        assert "#project (2)" in result
        assert "#idea (1)" in result
        assert "#work (1)" in result

    def test_frontmatter_list_form(self, vault):
        (vault / "t3.md").write_text("---\ntags:\n  - alpha\n  - beta\n---\n\nBody.")
        result = list_tags(vault)
        assert "#alpha (1)" in result
        assert "#beta (1)" in result

    def test_no_tags(self, tmp_path):
        (tmp_path / "plain.md").write_text("No tags at all.")
        result = list_tags(tmp_path)
        assert result == "No tags found in vault."


# --- get_recent_files ---


class TestGetRecentFiles:
    def test_lists_recent(self, vault):
        result = get_recent_files(vault, days=7)
        assert "README.md" in result

    def test_excludes_old(self, vault):
        old = vault / "ancient.md"
        old.write_text("old content")
        # Set mtime to ~100 days ago
        past = datetime.now(timezone.utc).timestamp() - 100 * 86400
        os.utime(old, (past, past))
        result = get_recent_files(vault, days=7)
        assert "ancient.md" not in result

    def test_limit_respected(self, vault):
        bulk = vault / "many"
        bulk.mkdir()
        for i in range(10):
            (bulk / f"f{i}.md").write_text("x")
        result = get_recent_files(vault, days=7, limit=3)
        # Header says "3 of N" and lists exactly 3 file lines
        assert result.startswith("3 of ")

    def test_none_recent(self, tmp_path):
        f = tmp_path / "old.md"
        f.write_text("x")
        past = datetime.now(timezone.utc).timestamp() - 100 * 86400
        os.utime(f, (past, past))
        result = get_recent_files(tmp_path, days=7)
        assert result == "No files modified in the last 7 day(s)."


# --- get_outgoing_links ---


class TestGetOutgoingLinks:
    def test_lists_links(self, vault):
        (vault / "a.md").write_text("See [[Other]] and [doc](notes/project.md).")
        result = get_outgoing_links(vault, "a.md")
        assert "Other" in result
        assert "notes/project.md" in result

    def test_no_links(self, vault):
        (vault / "a.md").write_text("Nothing to see.")
        assert get_outgoing_links(vault, "a.md") == "a.md has no outgoing links."

    def test_missing_file_errors(self, vault):
        with pytest.raises(FileNotFoundError):
            get_outgoing_links(vault, "nope.md")


# --- get_files_by_frontmatter ---


class TestGetFilesByFrontmatter:
    @pytest.fixture
    def fm_vault(self, tmp_path):
        (tmp_path / "n1.md").write_text("---\nstatus: seedling\nupdated: 2026-06-10\ntags: [agora, idea]\n---\n\nOne.")
        (tmp_path / "n2.md").write_text("---\nstatus: growing\nupdated: 2025-01-01\n---\n\nTwo.")
        (tmp_path / "n3.md").write_text("---\nstatus: seedling\n---\n\nThree.")
        (tmp_path / "plain.md").write_text("No frontmatter.")
        return tmp_path

    def test_scalar_match_case_insensitive(self, fm_vault):
        r = get_files_by_frontmatter(fm_vault, "status: SEEDLING")
        assert "n1.md" in r and "n3.md" in r
        assert "n2.md" not in r and "plain.md" not in r

    def test_list_membership_and_presence(self, fm_vault):
        assert "n1.md" in get_files_by_frontmatter(fm_vault, "tags: agora")
        present = get_files_by_frontmatter(fm_vault, "status: *")
        assert "n1.md" in present and "n2.md" in present and "n3.md" in present

    def test_date_comparison(self, fm_vault):
        r = get_files_by_frontmatter(fm_vault, "updated > 2026-01-01")
        assert "n1.md" in r and "n2.md" not in r

    def test_no_match(self, fm_vault):
        assert "No files match" in get_files_by_frontmatter(fm_vault, "status: dormant")

    def test_unparseable_query(self, fm_vault):
        assert "Could not parse" in get_files_by_frontmatter(fm_vault, "justtext")


# --- append_to_section ---


class TestAppendToSection:
    DOC = (
        "---\ntitle: T\nupdated: 2025-01-01\n---\n\n"
        "# Top\n\nIntro line.\n\n"
        "## Tasks\n\n- one\n- two\n\n"
        "## Notes\n\nSome note.\n"
    )

    def test_append_end(self, vault):
        (vault / "d.md").write_text(self.DOC)
        res = append_to_section(vault, "d.md", "Tasks", "- three", "end")
        assert res == 'Appended to "Tasks" in d.md'
        out = read_file(vault, "d.md")
        assert out.index("- two") < out.index("- three") < out.index("## Notes")
        assert f"updated: {TODAY}" in out
        assert "\n\n\n" not in out

    def test_append_start(self, vault):
        (vault / "d.md").write_text(self.DOC)
        append_to_section(vault, "d.md", "Tasks", "- zero", "start")
        out = read_file(vault, "d.md")
        assert out.index("## Tasks") < out.index("- zero") < out.index("- one")

    def test_append_eof(self, vault):
        (vault / "d.md").write_text(self.DOC)
        append_to_section(vault, "d.md", "Notes", "Appended tail.", "end")
        assert read_file(vault, "d.md").rstrip().endswith("Appended tail.")

    def test_level_boundary(self, vault):
        (vault / "lvl.md").write_text("# Top\n\n## Sec\n\ntext\n\n### Sub\n\nsubtext\n\n## Next\n\nn\n")
        append_to_section(vault, "lvl.md", "Sec", "- added", "end")
        out = read_file(vault, "lvl.md")
        assert out.index("subtext") < out.index("- added") < out.index("## Next")

    def test_heading_not_found(self, vault):
        (vault / "d.md").write_text(self.DOC)
        with pytest.raises(ValueError, match="heading not found"):
            append_to_section(vault, "d.md", "Ghost", "x", "end")
        assert read_file(vault, "d.md") == self.DOC

    def test_heading_not_unique(self, vault):
        (vault / "dup.md").write_text("# A\n\nx\n\n# A\n\ny\n")
        with pytest.raises(ValueError, match="not unique"):
            append_to_section(vault, "dup.md", "A", "z", "end")

    def test_missing_path_errors_cleanly(self, vault):
        with pytest.raises(ValueError, match="missing required argument: path"):
            append_to_section(vault, "", "Tasks", "x", "end")


# --- read_section ---


class TestReadSection:
    DOC = "# Top\n\nIntro.\n\n## Tasks\n\n- one\n- two\n\n## Notes\n\nA note.\n"

    def test_returns_section(self, vault):
        (vault / "d.md").write_text(self.DOC)
        out = read_section(vault, "d.md", "Tasks")
        assert "## Tasks" in out and "- one" in out and "- two" in out
        assert "## Notes" not in out and "A note." not in out

    def test_missing_heading(self, vault):
        (vault / "d.md").write_text(self.DOC)
        with pytest.raises(ValueError, match="heading not found"):
            read_section(vault, "d.md", "Ghost")

    def test_not_unique(self, vault):
        (vault / "dup.md").write_text("# A\n\nx\n\n# A\n\ny\n")
        with pytest.raises(ValueError, match="not unique"):
            read_section(vault, "dup.md", "A")


# --- read_frontmatter ---


class TestReadFrontmatter:
    def test_returns_block(self, vault):
        (vault / "n.md").write_text("---\nstatus: seedling\ntags: [a, b]\n---\n\nBody.")
        out = read_frontmatter(vault, "n.md")
        assert "status: seedling" in out and "tags: [a, b]" in out
        assert "Body." not in out

    def test_none(self, vault):
        (vault / "p.md").write_text("Just a body.\n")
        assert read_frontmatter(vault, "p.md") == "No frontmatter in p.md."


# --- resolve_wikilink ---


class TestResolveWikilink:
    @pytest.fixture
    def wl_vault(self, tmp_path):
        (tmp_path / "notes").mkdir()
        (tmp_path / "archive").mkdir()
        (tmp_path / "notes" / "Big Idea.md").write_text("x")
        (tmp_path / "archive" / "Big Idea.md").write_text("y")
        (tmp_path / "Unique Note.md").write_text("z")
        return tmp_path

    def test_unique_bare_name(self, wl_vault):
        assert resolve_wikilink(wl_vault, "Unique Note") == "Unique Note.md"

    def test_strips_brackets_alias_section(self, wl_vault):
        assert resolve_wikilink(wl_vault, "[[Unique Note|alias]]") == "Unique Note.md"
        assert resolve_wikilink(wl_vault, "Unique Note#H") == "Unique Note.md"

    def test_ambiguous(self, wl_vault):
        out = resolve_wikilink(wl_vault, "Big Idea")
        assert "notes/Big Idea.md" in out and "archive/Big Idea.md" in out

    def test_folder_path(self, wl_vault):
        assert resolve_wikilink(wl_vault, "notes/Big Idea") == "notes/Big Idea.md"

    def test_not_found(self, wl_vault):
        assert "No file resolves" in resolve_wikilink(wl_vault, "Nope")


# --- create_file ---


class TestCreateFile:
    def test_creates_new(self, vault):
        res = create_file(vault, "new.md", "Hi there.")
        assert res == "Created: new.md"
        assert read_file(vault, "new.md") == "Hi there."

    def test_creates_parents(self, vault):
        create_file(vault, "deep/nested/n.md", "x")
        assert (vault / "deep" / "nested" / "n.md").is_file()

    def test_refuses_overwrite(self, vault):
        (vault / "exists.md").write_text("original")
        with pytest.raises(FileExistsError, match="already exists"):
            create_file(vault, "exists.md", "new")
        assert read_file(vault, "exists.md") == "original"


# --- move_file ---


class TestMoveFile:
    def test_moves_content(self, vault):
        res = move_file(vault, "notes/hello.md", "archive/hello.md")
        assert res == "Moved: notes/hello.md → archive/hello.md"
        assert not (vault / "notes" / "hello.md").exists()
        assert read_file(vault, "archive/hello.md") == (
            "Hello world\nThis is a test note."
        )

    def test_creates_dest_parents(self, vault):
        move_file(vault, "README.md", "deep/nested/README.md")
        assert (vault / "deep" / "nested" / "README.md").is_file()

    def test_keeps_emptied_source_folder(self, vault):
        move_file(vault, "daily/2026-04-05.md", "archive/2026-04-05.md")
        assert (vault / "daily").is_dir()  # no os.renames-style pruning

    def test_missing_source(self, vault):
        with pytest.raises(FileNotFoundError, match="File not found: ghost.md"):
            move_file(vault, "ghost.md", "elsewhere.md")

    def test_refuses_existing_destination(self, vault):
        with pytest.raises(FileExistsError, match="never overwrites"):
            move_file(vault, "notes/hello.md", "notes/project.md")
        # Both files untouched.
        assert read_file(vault, "notes/hello.md").startswith("Hello world")
        assert read_file(vault, "notes/project.md").startswith("# Project")

    def test_refuses_self_move(self, vault):
        with pytest.raises(ValueError, match="onto itself"):
            move_file(vault, "README.md", "README.md")

    def test_missing_args(self, vault):
        with pytest.raises(ValueError, match="missing required argument: from"):
            move_file(vault, None, "x.md")
        with pytest.raises(ValueError, match="missing required argument: to"):
            move_file(vault, "README.md", "")

    def test_traversal_blocked_both_ends(self, vault):
        with pytest.raises(ValueError, match="Path traversal denied"):
            move_file(vault, "../outside.md", "in.md")
        with pytest.raises(ValueError, match="Path traversal denied"):
            move_file(vault, "README.md", "../outside.md")


# --- begin_session ---


class TestBeginSession:
    def test_prefers_bootstrap(self, vault):
        (vault / "_BOOTSTRAP.md").write_text("Bootstrap rules.")
        (vault / "CLAUDE.md").write_text("Claude md.")
        result = begin_session(vault)
        assert "from _BOOTSTRAP.md" in result
        assert "Bootstrap rules." in result
        assert "Claude md." not in result

    def test_falls_back_to_claude_md(self, vault):
        (vault / "CLAUDE.md").write_text("Claude orientation.")
        result = begin_session(vault)
        assert "from CLAUDE.md" in result
        assert "Claude orientation." in result

    def test_generic_when_neither(self, vault):
        result = begin_session(vault)
        assert "No orientation file found" in result
