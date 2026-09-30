#!/usr/bin/env python3
"""Tests for extract_rules.py's rule splitter."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from extract_rules import (
    build_sections,
    extract_rules_from_text,
    find_fenced_line_numbers,
    main,
    parse_args,
    parse_headings,
)


class SplitterTests(unittest.TestCase):
    def test_three_or_more_list_items_split_per_item(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            "- one\n"
            "- two\n"
            "- three\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(meta["rules"], 3)
        titles = [r["title"] for r in rules]
        self.assertEqual(titles, ["- one", "- two", "- three"])

    def test_two_list_items_split_per_item(self):
        # LIST_SPLIT_MIN_ITEMS = 2: two clearly labelled bullets are already
        # two distinct, independently gradable rules -- e.g. a project
        # file's "Otras reglas" section with one bullet about learning from
        # corrections and one unrelated bullet about the package manager
        # must not collapse into a single rule with one merged verdict.
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            "- one\n"
            "- two\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(meta["rules"], 2)
        titles = [r["title"] for r in rules]
        self.assertEqual(titles, ["- one", "- two"])

    def test_single_list_item_does_not_split(self):
        # Below LIST_SPLIT_MIN_ITEMS: one lone bullet under a heading is
        # just a heading with one paragraph, not a list a reader would scan
        # item by item, so the whole section body stays one rule.
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            "- only one item here\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(meta["rules"], 1)
        self.assertIn("- only one item here", rules[0]["text"])

    def test_fenced_code_block_does_not_split(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            "Some intro prose.\n"
            "```markdown\n"
            "# heading inside fence\n"
            "- item inside fence\n"
            "- another item\n"
            "- yet another\n"
            "```\n"
            "More prose after.\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        # The fenced "# heading" and 3 "-" items must not create a section
        # split or a list split -- the whole section body is one rule.
        self.assertEqual(meta["rules"], 1)
        self.assertIn("item inside fence", rules[0]["text"])
        self.assertIn("More prose after.", rules[0]["text"])

    def test_nested_list_item_stays_attached_to_parent(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            "1. First item\n"
            "    - nested sub point one\n"
            "    - nested sub point two\n"
            "2. Second item\n"
            "3. Third item\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(meta["rules"], 3)
        first = rules[0]
        self.assertIn("First item", first["text"])
        self.assertIn("nested sub point one", first["text"])
        self.assertIn("nested sub point two", first["text"])
        self.assertNotIn("Second item", first["text"])

    def test_heading_path_through_empty_parent_section(self):
        text = (
            "# Parent\n"
            "\n"
            "## Empty Child\n"
            "\n"
            "### Grandchild\n"
            "Some real content here.\n"
        )
        rules, _, _ = extract_rules_from_text(text, "f", "global")
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["section"], "Parent › Empty Child › Grandchild")

    def test_line_numbers_point_at_real_source_lines(self):
        text = (
            "# Title\n"          # line 1
            "\n"                 # line 2
            "## Rules\n"         # line 3
            "- alpha\n"          # line 4
            "- beta\n"           # line 5
            "- gamma\n"          # line 6
        )
        rules, _, _ = extract_rules_from_text(text, "f", "project")
        self.assertEqual([r["start_line"] for r in rules], [4, 5, 6])
        self.assertEqual([r["end_line"] for r in rules], [4, 5, 6])
        self.assertEqual(rules[0]["id"], "f#4")


class HelperTests(unittest.TestCase):
    def test_find_fenced_line_numbers_handles_indented_fence(self):
        lines = [
            "1. Item",
            "   ```bash",
            "   echo hi",
            "   ```",
            "2. Next",
        ]
        fenced = find_fenced_line_numbers(lines)
        self.assertEqual(fenced, {2, 3, 4})

    def test_parse_headings_skips_fenced_hashes(self):
        lines = ["# Real", "```", "# not a heading", "```", "## Also Real"]
        fenced = find_fenced_line_numbers(lines)
        headings = parse_headings(lines, fenced)
        self.assertEqual([h["title"] for h in headings], ["Real", "Also Real"])

    def test_build_sections_drops_whitespace_only_body_but_keeps_path(self):
        lines = ["# A", "", "## B", "", "### C", "content"]
        fenced = set()
        headings = parse_headings(lines, fenced)
        sections = build_sections(len(lines), headings)
        # section for "B" has an empty body (only whitespace up to "### C")
        b_section = next(s for s in sections if s["title"] == "B")
        b_body = lines[b_section["body_start"] - 1:b_section["body_end"]]
        self.assertTrue(all(line.strip() == "" for line in b_body))
        c_section = next(s for s in sections if s["title"] == "C")
        self.assertEqual(c_section["heading_path"], "A › B › C")


class ConditionalBlockTests(unittest.TestCase):
    """<important if="..."> blocks (references/structure.md, rule-model.md):
    a container whose rules split the same way as any other section, each
    carrying `condition`. Bare rules keep `condition: None`."""

    def test_block_with_list_splits_per_item_and_carries_condition(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            '<important if="editing backend Python files">\n'
            "- one\n"
            "- two\n"
            "</important>\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(meta["rules"], 2)
        self.assertEqual([r["title"] for r in rules], ["- one", "- two"])
        self.assertEqual(
            [r["condition"] for r in rules],
            ["editing backend Python files", "editing backend Python files"],
        )

    def test_block_with_single_paragraph_stays_one_rule_with_condition(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            '<important if="running celery beat">\n'
            "Rebuild the worker after any Python change.\n"
            "</important>\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(meta["rules"], 1)
        self.assertEqual(rules[0]["condition"], "running celery beat")
        self.assertIn("Rebuild the worker", rules[0]["text"])

    def test_bare_rules_have_null_condition(self):
        text = "# Title\n\n## Rules\n- one\n- two\n"
        rules, _, _ = extract_rules_from_text(text, "f", "project")
        self.assertEqual([r["condition"] for r in rules], [None, None])

    def test_tags_excluded_from_rule_text_and_token_cost(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            '<important if="some condition">\n'
            "Body text only.\n"
            "</important>\n"
        )
        rules, _, _ = extract_rules_from_text(text, "f", "project")
        self.assertEqual(len(rules), 1)
        self.assertNotIn("<important", rules[0]["text"])
        self.assertNotIn("</important>", rules[0]["text"])
        self.assertEqual(rules[0]["chars"], len("Body text only."))

    def test_nested_block_rejected_with_warning_not_flattened(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            '<important if="outer condition">\n'
            "Outer prose.\n"
            '<important if="inner condition">\n'
            "Inner prose.\n"
            "</important>\n"
            "</important>\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        # Nested block is rejected, not flattened: the whole body -- including
        # the literal inner tag lines -- survives as one rule under the outer
        # condition, and nothing is silently dropped.
        self.assertEqual(meta["rules"], 1)
        self.assertEqual(rules[0]["condition"], "outer condition")
        self.assertIn("Outer prose.", rules[0]["text"])
        self.assertIn('<important if="inner condition">', rules[0]["text"])
        self.assertIn("Inner prose.", rules[0]["text"])
        self.assertTrue(
            any("nested" in w for w in meta["warnings"]),
            f"expected a nested-block warning, got: {meta['warnings']}",
        )

    def test_stray_closing_tag_kept_as_text_with_warning(self):
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            "Some prose.\n"
            "</important>\n"
            "More prose.\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(meta["rules"], 1)
        self.assertIn("</important>", rules[0]["text"])
        self.assertTrue(any("stray" in w for w in meta["warnings"]))

    def test_unclosed_block_reverts_to_literal_text_and_does_not_wrap_rest_of_file(self):
        # A missing </important> must never silently wrap the rest of the
        # file -- including content in a later section, past a heading --
        # under a condition nobody closed. The whole thing reverts to plain
        # text instead.
        text = (
            "# Title\n"
            "\n"
            "## Section One\n"
            '<important if="never closed">\n'
            "Some prose.\n"
            "\n"
            "## Section Two\n"
            "This must stay bare.\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertTrue(all(r["condition"] is None for r in rules))
        section_two_rule = next(r for r in rules if "must stay bare" in r["text"])
        self.assertEqual(section_two_rule["condition"], None)
        opening_tag_rule = next(r for r in rules if "Some prose." in r["text"])
        self.assertIn('<important if="never closed">', opening_tag_rule["text"])
        self.assertTrue(any("never closed" in w for w in meta["warnings"]))

    def test_inline_mention_of_the_tag_in_prose_is_not_recognized(self):
        # references/structure.md and rule-model.md mention the tag inline
        # in prose -- that must never be treated as a real block boundary.
        text = (
            "# Title\n"
            "\n"
            "## Rules\n"
            'An `<important if="condition">` block puts a relevance signal '
            "next to the rule.\n"
        )
        rules, _, meta = extract_rules_from_text(text, "f", "project")
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["condition"], None)
        self.assertIn('<important if="condition">', rules[0]["text"])
        self.assertEqual(meta["warnings"], [])

    def test_file_without_blocks_matches_pre_restructure_output(self):
        # Regression: a file with no <important if> blocks at all must emit
        # exactly the same rules/rollups/meta as before this feature existed
        # (T1), aside from the new `condition: None` key on every rule.
        text = (
            "# Doc\n"
            "\n"
            "Some preamble prose.\n"
            "\n"
            "## Section One\n"
            "Intro paragraph.\n"
            "```python\n"
            "# not a heading\n"
            "- not a list item\n"
            "```\n"
            "More prose after the fence.\n"
            "\n"
            "## Section Two\n"
            "- alpha\n"
            "- beta\n"
            "- gamma\n"
            "\n"
            "### Nested\n"
            "1. First\n"
            "    - sub a\n"
            "    - sub b\n"
            "2. Second\n"
        )
        rules, sections, meta = extract_rules_from_text(text, "f", "project")

        # Every rule carries condition: None, and everything else matches
        # the pre-restructure fields exactly.
        self.assertTrue(all(r["condition"] is None for r in rules))
        stripped = [{k: v for k, v in r.items() if k != "condition"} for r in rules]

        # The first rule is the "# Doc" section itself (heading level 1):
        # its body is everything up to "## Section One", and since it is a
        # whole, unwrapped section under a heading, its title is the
        # heading's own title ("Doc") -- exactly as split_section_into_rules
        # behaved before this feature existed.
        self.assertEqual(stripped[0]["title"], "Doc")
        # Doc(1) + Section One(1) + Section Two's 3 bullets + Nested's
        # "1. First" (with sub a/sub b attached) and "2. Second".
        self.assertEqual(len(rules), 7)
        self.assertEqual(meta["warnings"], [])
        # Full fence body text is preserved untouched inside its rule.
        fenced_rule = next(r for r in rules if "not a list item" in r["text"])
        self.assertIn("# not a heading", fenced_rule["text"])
        self.assertIn("More prose after the fence.", fenced_rule["text"])


def _load_old_extract_rules_module():
    """Load scripts/testdata/old_extract_rules_pre_t1.py.txt -- a frozen
    copy of extract_rules.py exactly as it was before T1 (commit
    acae673^), captured with `git show acae673^:scripts/extract_rules.py`.
    Used as the ground truth for the golden test below: comparing against
    hand-written expected values (as the test above does) can only prove
    the test author's own assumptions, not real byte-for-byte compatibility
    with the pre-T1 splitter."""
    import importlib.util
    from importlib.machinery import SourceFileLoader

    old_path = Path(__file__).parent / "testdata" / "old_extract_rules_pre_t1.py.txt"
    loader = SourceFileLoader("old_extract_rules_pre_t1", str(old_path))
    spec = importlib.util.spec_from_file_location("old_extract_rules_pre_t1", old_path, loader=loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class GoldenNoBlocksRegressionTests(unittest.TestCase):
    """T1's mandatory regression: a file with no <important if> blocks must
    extract identically to the pre-T1 splitter. Frozen-golden, not
    hand-computed -- see _load_old_extract_rules_module()."""

    @classmethod
    def setUpClass(cls):
        cls.old = _load_old_extract_rules_module()

    def _assert_matches_old(self, text, label="f"):
        old_rules, old_sections, old_meta = self.old.extract_rules_from_text(text, label, "project")
        new_rules, new_sections, new_meta = extract_rules_from_text(text, label, "project")

        self.assertEqual(len(old_rules), len(new_rules))
        for old_rule, new_rule in zip(old_rules, new_rules):
            new_stripped = {k: v for k, v in new_rule.items() if k != "condition"}
            self.assertEqual(old_rule, new_stripped)
            self.assertIsNone(new_rule.get("condition"))

        self.assertEqual(old_sections, new_sections)

        new_meta_stripped = {k: v for k, v in new_meta.items() if k != "warnings"}
        self.assertEqual(old_meta, new_meta_stripped)
        self.assertEqual(new_meta.get("warnings"), [])

    def test_enriched_fixture_with_every_edge_case(self):
        # Real preamble (content before the first heading), a single-bullet
        # section (must NOT split), prose before a list, a fenced block
        # with heading/list-marker look-alikes, nested list items, an empty
        # parent heading, and trailing blank lines.
        text = (
            "Preamble prose before any heading at all.\n"
            "\n"
            "# Doc\n"
            "\n"
            "## Single Bullet\n"
            "- only one item here, must stay one rule\n"
            "\n"
            "## Prose Then List\n"
            "Some intro prose before the list starts.\n"
            "- alpha\n"
            "- beta\n"
            "\n"
            "## Fenced Lookalikes\n"
            "```markdown\n"
            "# not a real heading\n"
            "- not a real list item\n"
            "1. not a real list item either\n"
            "```\n"
            "\n"
            "## Empty Parent\n"
            "\n"
            "### Real Child\n"
            "Content that belongs to the child, not the empty parent.\n"
            "\n"
            "## Deep Nesting\n"
            "1. First\n"
            "    - sub a\n"
            "    - sub b\n"
            "2. Second\n"
            "3. Third\n"
            "\n"
            "\n"
        )
        self._assert_matches_old(text)

    def test_real_repo_files_match_the_pre_t1_splitter(self):
        # The files this skill actually grades (or documents itself with),
        # none of which had -- or, for the two written in T2, still don't
        # use as real blocks -- an <important if> container of their own.
        repo_root = Path(__file__).parent.parent
        candidates = [
            repo_root / "SKILL.md",
            repo_root / "references" / "rule-model.md",
            repo_root / "references" / "structure.md",
            repo_root / "scorers" / "adherence.md",
            repo_root / "scorers" / "rule-value.md",
        ]
        checked = 0
        for path in candidates:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            with self.subTest(file=str(path)):
                self._assert_matches_old(text, label=path.name)
            checked += 1
        self.assertGreater(checked, 0, "no candidate instruction file was found to compare")


class OnlyFlagTests(unittest.TestCase):
    """`--only` (T6 fix 5): disables auto-discovery so only `--file` paths
    are extracted, and errors when given without `--file` -- auto-discovery
    is what would otherwise supply something to grade."""

    def _make_home_with_global_claude(self, tmp):
        home = Path(tmp) / "home"
        (home / ".claude").mkdir(parents=True)
        (home / ".claude" / "CLAUDE.md").write_text(
            "# Global\n\nSome bare rule.\n", encoding="utf-8"
        )
        return home

    def test_only_without_file_errors(self):
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as cm:
            with contextlib.redirect_stderr(stderr):
                parse_args(["--out", "/tmp/doctor-md-agents-test-only", "--only"])
        self.assertEqual(cm.exception.code, 2)
        err = stderr.getvalue()
        self.assertIn("--only requires", err)
        self.assertNotIn("unrecognized", err)

    def test_only_disables_auto_discovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = self._make_home_with_global_claude(tmp)
            explicit = Path(tmp) / "PROJECT.md"
            explicit.write_text("# Project\n\nSome bare rule.\n", encoding="utf-8")
            out_dir = Path(tmp) / "out"
            with mock.patch.dict(os.environ, {"HOME": str(home)}):
                main(["--out", str(out_dir), "--only", "--file", str(explicit)])
            data = json.loads((out_dir / "rules.json").read_text())
            labels = [f["label"] for f in data["files"]]
            self.assertEqual(len(labels), 1)
            self.assertTrue(any("PROJECT.md" in l for l in labels))

    def test_without_only_default_behavior_unchanged(self):
        # Characterization test: without --only, auto-discovery still runs
        # alongside --file, exactly as before this flag existed.
        with tempfile.TemporaryDirectory() as tmp:
            home = self._make_home_with_global_claude(tmp)
            explicit = Path(tmp) / "PROJECT.md"
            explicit.write_text("# Project\n\nSome bare rule.\n", encoding="utf-8")
            out_dir = Path(tmp) / "out"
            with mock.patch.dict(os.environ, {"HOME": str(home)}):
                main(["--out", str(out_dir), "--file", str(explicit)])
            data = json.loads((out_dir / "rules.json").read_text())
            labels = [f["label"] for f in data["files"]]
            self.assertEqual(len(labels), 2)


class FileIOTests(unittest.TestCase):
    def test_extract_rules_from_file_on_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "CLAUDE.md"
            path.write_text(
                "# Doc\n\n## Section\n- one\n- two\n- three\n", encoding="utf-8"
            )
            text = path.read_text(encoding="utf-8")
            rules, sections, meta = extract_rules_from_text(text, "test:CLAUDE.md", "project")
            self.assertEqual(meta["rules"], 3)
            self.assertEqual(len(sections), 1)
            self.assertEqual(sections[0]["rule_ids"], ["test:CLAUDE.md#4", "test:CLAUDE.md#5", "test:CLAUDE.md#6"])


if __name__ == "__main__":
    unittest.main()
