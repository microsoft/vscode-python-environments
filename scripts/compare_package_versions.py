#!/usr/bin/env python3
"""Verify that the extension and the public API npm package share the same version.

The root ``package.json`` (the VS Code extension) and ``api/package.json`` (the
published ``@vscode/python-environments`` npm package) must always declare the same
``version``. This keeps the published API package in lock-step with the extension
that implements it.

Exits with status 0 when the versions match, and status 1 (printing an error) when
they differ. Intended to be run from CI, but can also be run locally:

    python scripts/compare_package_versions.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXTENSION_PACKAGE = REPO_ROOT / "package.json"
API_PACKAGE = REPO_ROOT / "api" / "package.json"


def read_version(package_json: Path) -> str:
    """Return the ``version`` field from the given package.json file.

    Args:
        package_json: Path to a ``package.json`` file.

    Returns:
        The declared version string.

    Raises:
        SystemExit: If the file is missing, unparseable, or has no ``version``.
    """
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"::error::{package_json} not found")
    except json.JSONDecodeError as exc:
        sys.exit(f"::error::Failed to parse {package_json}: {exc}")

    version = data.get("version")
    if not isinstance(version, str) or not version:
        sys.exit(f"::error::{package_json} is missing a 'version' field")
    return version


def main() -> int:
    """Compare the extension and API package versions.

    Returns:
        0 when the versions match, 1 when they differ.
    """
    extension_version = read_version(EXTENSION_PACKAGE)
    api_version = read_version(API_PACKAGE)

    print(f"Extension version (package.json):       {extension_version}")
    print(f"API package version (api/package.json): {api_version}")

    if extension_version != api_version:
        print(
            f"::error::Version mismatch: package.json is {extension_version} but "
            f"api/package.json is {api_version}. Update package.json and/or api/package.json so both versions match."
        )
        return 1

    print("Versions match.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
