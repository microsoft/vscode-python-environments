#!/usr/bin/env python3
"""
check_api_changes.py - Detects changes to the public API and enforces documentation updates.

This script is invoked by the pre-commit hook to ensure that any modifications
to public API files are accompanied by corresponding documentation changes.
"""

import subprocess
import sys


# Files that define the public API surface
PUBLIC_API_FILES = [
    "src/extension.ts",
    "src/api.ts",
]

# Documentation files that must be updated when the API changes
DOCS_FILES = [
    "README.md",
    "docs/api.md",
    "CHANGELOG.md",
]


def get_staged_files():
    """Return list of files staged for the current commit."""
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []
    return [f for f in result.stdout.strip().split("\n") if f]


def has_api_changes(staged_files):
    """Check whether any public API files are staged."""
    return any(f in PUBLIC_API_FILES for f in staged_files)


def has_doc_changes(staged_files):
    """Check whether any documentation files are staged."""
    return any(f in DOCS_FILES for f in staged_files)


def main():
    """Enforce that API changes are documented."""
    staged_files = get_staged_files()

    if not has_api_changes(staged_files):
        sys.exit(0)

    if has_doc_changes(staged_files):
        print("API changes detected with documentation updates.")
        sys.exit(0)

    print("WARNING: Public API changes detected without documentation updates.")
    print("Modified API files:")
    for f in PUBLIC_API_FILES:
        if f in staged_files:
            print(f"  - {f}")
    print("Please update one or more of these documentation files:")
    for f in DOCS_FILES:
        print(f"  - {f}")
    sys.exit(1)


if __name__ == "__main__":
    main()