# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Stop hook - Ensures pre-commit checks were run before session ends.

For maintainer sessions that modified files:
- Checks if there are uncommitted changes
- Verifies lint/type-check/tests passed or reminds to run them
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple


def run_command(cmd: List[str], cwd: Optional[Path] = None) -> Tuple[int, str]:
    """Run a command and return (exit_code, output)."""
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode, result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 1, str(e)


def has_uncommitted_changes(repo_root: Path) -> bool:
    """Check if there are uncommitted changes (tracked files only)."""
    code, output = run_command(["git", "status", "--porcelain"], repo_root)
    if code == 0 and output:
        # Filter to only tracked files (staged/modified, not untracked with ??)
        lines = [
            line
            for line in output.split("\n")
            if line.strip() and not line.strip().startswith("??")
        ]
        return len(lines) > 0
    return False


def has_untracked_ts_files(repo_root: Path) -> bool:
    """Check if there are untracked TypeScript files."""
    code, output = run_command(["git", "status", "--porcelain"], repo_root)
    if code == 0 and output:
        for line in output.split("\n"):
            if line.strip().startswith("??"):
                # Extract filename from untracked entry (format: "?? path/to/file")
                filename = line.strip()[3:].strip()
                if filename.endswith((".ts", ".tsx")):
                    return True
    return False


def has_staged_changes(repo_root: Path) -> bool:
    """Check if there are staged but uncommitted changes."""
    code, output = run_command(["git", "diff", "--cached", "--name-only"], repo_root)
    return code == 0 and bool(output.strip())


def check_ts_files_changed(repo_root: Path) -> bool:
    """Check if any TypeScript files were changed."""
    code, output = run_command(
        ["git", "diff", "--name-only", "HEAD"],
        repo_root,
    )
    if code == 0 and output:
        return any(f.endswith((".ts", ".tsx")) for f in output.split("\n"))

    # Also check staged files
    code, output = run_command(
        ["git", "diff", "--cached", "--name-only"],
        repo_root,
    )
    if code == 0 and output:
        return any(f.endswith((".ts", ".tsx")) for f in output.split("\n"))

    return False


def main() -> int:
    """Main entry point."""
    # Read input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    repo_root = Path(input_data.get("cwd", os.getcwd()))

    # Check if this is already a continuation from a previous stop hook
    stop_hook_active = input_data.get("stop_hook_active", False)
    if stop_hook_active:
        # Don't block again to prevent infinite loop
        print(json.dumps({}))
        return 0

    # Check for uncommitted TypeScript changes (including new untracked TS files)
    ts_work_present = (
        has_uncommitted_changes(repo_root) and check_ts_files_changed(repo_root)
    ) or has_untracked_ts_files(repo_root)
    if ts_work_present:
        # There are uncommitted TS changes - remind about pre-commit checks
        response = {
            "hookSpecificOutput": {
                "hookEventName": "Stop",
                "decision": "block",
                "reason": (
                    "You have uncommitted TypeScript changes. "
                    "Before finishing, use the run-pre-commit-checks skill "
                    "or manually run: npm run lint && npm run compile-tests && npm run unittest. "
                    "If checks pass and changes are ready, commit them. "
                    "If this session is just research/exploration, you can proceed without committing."
                ),
            }
        }
        print(json.dumps(response))
        return 0

    # Check for staged but uncommitted changes
    if has_staged_changes(repo_root):
        response = {
            "hookSpecificOutput": {
                "hookEventName": "Stop",
                "decision": "block",
                "reason": (
                    "You have staged changes that haven't been committed. "
                    "Either commit them with a proper message or unstage them before finishing."
                ),
            }
        }
        print(json.dumps(response))
        return 0

    # All good
    print(json.dumps({}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
