#!/usr/bin/env python3
"""Check a generated kb/ folder for depth, citation quality, and broken links.

Usage: check_kb.py KB_DIR [--root SOURCE_ROOT ...] [--min-sources N] [--max-doc-ratio R]
       check_kb.py --self-test

Exits 1 and prints one line per problem when the KB fails.
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

CITE = re.compile(r"`([^`\s:]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?`")
HOP = re.compile(r"^\s*\d+\.\s", re.M)
# `name` — `path:line` (also "-", "at", "(") — the shape the briefs ask for when naming a symbol.
NAMED = re.compile(r"`([A-Za-z_$][\w$.]*)(?:\(\))?`\s*(?:—|–|-|at|in)?\s*\(?`([^`\s:]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`")
DOC_COMMENT_SLACK = 8  # a citation may land on the doc comment just above the declaration
SIGNATURE_SLACK = 3  # ...or a few lines into a multi-line signature
CODE_EXTS = {"ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "rb", "json", "md", "yml", "yaml", "toml", "css", "html", "sql"}
URL = re.compile(r"https?://[^\s)`>\]]+")
LINK = re.compile(r"\]\(([^)\s]+)\)")
DOC_NAMES = {"readme", "agents", "claude", "contributing", "changelog"}
DOC_EXTS = {".md", ".mdx", ".rst", ".txt"}
# Pages that must stand on real sources; index/glossary/run-and-test may lean on docs.
DEEP = ("areas/", "flows/", "architecture.md", "task-map.md")
MIN_HOPS = 6


def is_doc(path: str) -> bool:
    p = Path(path)
    return p.suffix.lower() in DOC_EXTS or p.stem.lower() in DOC_NAMES


def misplaced_name(roots: list[Path], name: str, path: str, start: int, end: int) -> str | None:
    """Return a problem when `name` isn't in the cited lines (or the comment just above them)."""
    for r in roots:
        f = r / path
        if f.is_file():
            lines = f.read_text(encoding="utf-8", errors="ignore").splitlines()
            # The range end gets the slack too: a citation that stops on a doc comment still names its function.
            window = lines[max(0, start - 1 - SIGNATURE_SLACK) : end + DOC_COMMENT_SLACK]
            if re.search(rf"(?<![\w$]){re.escape(name)}(?![\w$])", "\n".join(window)):
                return None
            actual = next((i for i, l in enumerate(lines, 1) if re.search(rf"(?<![\w$]){re.escape(name)}(?![\w$])", l)), None)
            hint = f", first appears at line {actual}" if actual else ", not found in file"
            return f"`{name}` not at {path}:{start}{hint}"
    return None  # missing files are reported separately


def check(kb: Path, roots: list[Path], min_sources: int, max_doc_ratio: float) -> list[str]:
    problems = []
    if not (kb / "_verify.md").is_file():
        problems.append("_verify.md: missing (write the verification report)")
    pages = sorted(p for p in kb.rglob("*.md"))
    if not pages:
        return problems + [f"{kb}: no pages"]
    for page in pages:
        rel = page.relative_to(kb).as_posix()
        text = page.read_text(encoding="utf-8")
        for target in LINK.findall(text):
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            if not (page.parent / target.split("#")[0]).exists():
                problems.append(f"{rel}: broken link {target}")
        found = CITE.findall(text)
        cites = [c for c, _ in found]
        if roots:
            for c in set(cites):
                if not any((r / c).exists() for r in roots):
                    problems.append(f"{rel}: cited file not found {c}")
            for name, path, start, end in NAMED.findall(text):
                if "." in name and name.rsplit(".", 1)[1] in CODE_EXTS:
                    continue  # `schema.ts` — `path:line` names a file, not a symbol
                problem = misplaced_name(roots, name.split(".")[-1], path, int(start), int(end or start))
                if problem:
                    problems.append(f"{rel}: {problem}")
        if not rel.startswith(DEEP) or rel == "_verify.md":
            continue
        docs = [c for c in cites if is_doc(c)]
        # A `file:1` citation points at the file, not at a claim, so it doesn't count as a source.
        sources = {c for c, line in found if not is_doc(c) and line != "1"} | set(URL.findall(text))
        line_one = sum(1 for c, line in found if line == "1" and not is_doc(c))
        if len(sources) < min_sources:
            problems.append(f"{rel}: {len(sources)} distinct source citations (excluding :1), need {min_sources}")
        if line_one:
            problems.append(f"{rel}: {line_one} citation(s) to line 1; cite the line the claim is about")
        if cites and len(docs) / len(cites) > max_doc_ratio:
            problems.append(f"{rel}: {len(docs)}/{len(cites)} citations are docs, max {max_doc_ratio:.0%}")
        if rel.startswith("flows/") and len(HOP.findall(text)) < MIN_HOPS:
            problems.append(f"{rel}: {len(HOP.findall(text))} numbered hops, need {MIN_HOPS}")
    return problems


def self_test() -> None:
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "src").mkdir()
        for name in "abcde":
            (root / "src" / f"{name}.ts").write_text("x\n")
        (root / "README.md").write_text("x\n")
        kb = root / "kb"
        (kb / "areas").mkdir(parents=True)
        good = " ".join(f"`src/{n}.ts:2`" for n in "abcde") + " [i](../index.md)"
        (kb / "areas" / "good.md").write_text(good)
        (kb / "areas" / "thin.md").write_text("`README.md:1` `README.md:2` `src/a.ts:2` `src/zz.ts:3` [x](nope.md)")
        (kb / "index.md").write_text("`README.md:1`")
        (kb / "flows").mkdir()
        hops = "\n".join(f"{i}. step `src/{n}.ts:2`" for i, n in enumerate("abcdea", 1))
        (kb / "flows" / "ok.md").write_text(hops)
        (kb / "flows" / "short.md").write_text("1. `src/a.ts:1` `src/b.ts:1` `src/c.ts:2`\n2. x\n")
        out = check(kb, [root], 5, 0.2)
        assert not any(p.startswith("flows/ok.md") for p in out), out
        short = [p for p in out if p.startswith("flows/short.md")]
        assert any("1 distinct source citations" in p for p in short), short
        assert any("2 citation(s) to line 1" in p for p in short), short
        assert any("2 numbered hops" in p for p in short), short
        (kb / "flows" / "short.md").unlink()
        assert "_verify.md: missing (write the verification report)" in out, out
        assert not any(p.startswith("areas/good.md") for p in out), out
        assert not any(p.startswith("index.md") for p in out), out
        thin = [p for p in out if p.startswith("areas/thin.md")]
        assert any("broken link nope.md" in p for p in thin), thin
        assert any("cited file not found src/zz.ts" in p for p in thin), thin
        assert any("distinct source citations" in p for p in thin), thin
        assert any("are docs" in p for p in thin), thin
        (root / "src" / "f.ts").write_text("// doc\n// more\nexport function runThing() {}\n" + "x\n" * 30 + "const runThingy = 1\n")
        named = (kb / "areas" / "named.md")
        named.write_text("`runThing` — `src/f.ts:1-2` `runThing()` at `src/f.ts:3` `runThing` — `src/f.ts:5`"
                         " `runThing` — `src/f.ts:30` `obj.runThingy` — `src/f.ts:34` `f.ts` — `src/f.ts:30`")
        out = check(kb, [root], 0, 1)
        bad = [p for p in out if p.startswith("areas/named.md") and "not at" in p]
        assert bad == ["areas/named.md: `runThing` not at src/f.ts:30, first appears at line 3"], bad
        named.unlink()
        (kb / "_verify.md").write_text("ok")
        (kb / "areas" / "thin.md").unlink()
        assert check(kb, [root], 5, 0.2) == [], check(kb, [root], 5, 0.2)
    print("self-test passed")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("kb", nargs="?")
    ap.add_argument("--root", action="append", default=[], help="source root cited paths are relative to (repeatable)")
    ap.add_argument("--min-sources", type=int, default=5)
    ap.add_argument("--max-doc-ratio", type=float, default=0.2)
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.kb:
        ap.error("KB_DIR is required")
    problems = check(Path(a.kb), [Path(r) for r in a.root], a.min_sources, a.max_doc_ratio)
    for p in problems:
        print(p)
    print(f"{len(problems)} problem(s)" if problems else "KB checks passed")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
