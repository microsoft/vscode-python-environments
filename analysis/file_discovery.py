# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Shared file discovery and filtering utilities for analysis modules."""

import pathlib
import subprocess
from typing import List, Optional

import pathspec


def load_gitignore(repo_root: pathlib.Path) -> Optional[pathspec.PathSpec]:
    """Load .gitignore patterns."""
    gitignore_path = repo_root / ".gitignore"
    if not gitignore_path.exists():
        return None

    with open(gitignore_path, "r", encoding="utf-8") as f:
        patterns = f.read().splitlines()

    return pathspec.PathSpec.from_lines("gitwildmatch", patterns)


# Common directories to skip during analysis
SKIP_DIRS = {
    "node_modules",
    "dist",
    "out",
    ".venv",
    "__pycache__",
    ".git",
    ".vscode-test",
}

# Test-related path patterns to optionally skip
TEST_PATH_PATTERNS = ["/test/", "/tests/", "/__tests__/", "/mocks/"]
TEST_FILENAME_PREFIXES = ["test_"]
TEST_FILENAME_SUFFIXES = [
    "_test.py",
    "_tests.py",
    ".test.py",
    ".spec.py",
    ".test.ts",
    ".test.tsx",
    ".spec.ts",
    ".spec.tsx",
    ".test.js",
    ".test.jsx",
    ".spec.js",
    ".spec.jsx",
]


def is_test_file(filepath: pathlib.Path, repo_root: pathlib.Path) -> bool:
    """Check if a file is a test file based on common naming conventions."""
    rel_path = filepath.relative_to(repo_root).as_posix()
    filename = filepath.name

    # Check path patterns (e.g., /test/, /tests/)
    if any(pattern in f"/{rel_path}" for pattern in TEST_PATH_PATTERNS):
        return True

    # Check filename prefixes (e.g., test_*.py)
    if any(filename.startswith(prefix) for prefix in TEST_FILENAME_PREFIXES):
        return True

    # Check filename suffixes (e.g., *.test.ts)
    if any(filename.endswith(suffix) for suffix in TEST_FILENAME_SUFFIXES):
        return True

    return False


def should_analyze_file(
    filepath: pathlib.Path,
    repo_root: pathlib.Path,
    gitignore: Optional[pathspec.PathSpec],
    skip_tests: bool = False,
) -> bool:
    """Check if a file should be analyzed.

    Args:
        filepath: Path to the file
        repo_root: Root of the repository
        gitignore: Loaded gitignore patterns
        skip_tests: If True, also skip test files
    """
    rel_path = filepath.relative_to(repo_root).as_posix()

    # Skip common non-source directories
    rel_parts = filepath.relative_to(repo_root).parts
    for part in rel_parts:
        if part in SKIP_DIRS:
            return False

    # Skip if matched by gitignore
    if gitignore and gitignore.match_file(rel_path):
        return False

    # Optionally skip test files
    if skip_tests and is_test_file(filepath, repo_root):
        return False

    return True


def get_tracked_source_files(
    repo_root: pathlib.Path,
    extensions: List[str],
    skip_tests: bool = False,
) -> List[pathlib.Path]:
    """Get source files tracked by git (respects .gitignore automatically).

    Args:
        repo_root: Root of the repository
        extensions: List of file extensions to include (e.g., [".py", ".ts"])
        skip_tests: If True, filter out test files
    """
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return []

        files = []
        for line in result.stdout.splitlines():
            line = line.strip()
            if line and any(line.endswith(ext) for ext in extensions):
                filepath = repo_root / line
                if filepath.exists():
                    if skip_tests and is_test_file(filepath, repo_root):
                        continue
                    files.append(filepath)
        return files
    except (subprocess.TimeoutExpired, FileNotFoundError):
        # Fall back to rglob if git is not available
        gitignore = load_gitignore(repo_root)
        files = []
        for ext in extensions:
            for filepath in repo_root.rglob(f"*{ext}"):
                if should_analyze_file(filepath, repo_root, gitignore, skip_tests):
                    files.append(filepath)
        return files
