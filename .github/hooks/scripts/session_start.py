# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""SessionStart hook - Injects project context at session start.

Provides the agent with:
- Current git branch and status
- Recent commits summary
- Open issue count (if gh CLI available)
- Snapshot summary (if available)
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional


def run_command(cmd: List[str], cwd: Optional[Path] = None) -> Optional[str]:
    """Run a command and return stdout, or None on failure."""
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        # Git/gh CLI not available or timed out; return None to skip this context.
        pass
    return None


def get_git_context(repo_root: Path) -> Dict:
    """Get current git context."""
    context = {}

    # Current branch
    branch = run_command(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo_root)
    if branch:
        context["branch"] = branch

    # Short SHA
    sha = run_command(["git", "rev-parse", "--short", "HEAD"], repo_root)
    if sha:
        context["commit"] = sha

    # Uncommitted changes count
    status = run_command(["git", "status", "--porcelain"], repo_root)
    if status is not None:
        changes = len([line for line in status.split("\n") if line.strip()])
        context["uncommitted_changes"] = changes

    # Recent commits (last 3)
    log = run_command(
        ["git", "log", "-3", "--oneline", "--no-decorate"],
        repo_root,
    )
    if log:
        context["recent_commits"] = log.split("\n")

    return context


def get_issue_context(repo_root: Path) -> Dict:
    """Get open issue context if gh CLI is available."""
    context = {}

    # Check if gh CLI is available
    issues_json = run_command(
        [
            "gh",
            "issue",
            "list",
            "--state",
            "open",
            "--limit",
            "5",
            "--json",
            "number,title,labels",
        ],
        repo_root,
    )
    if issues_json:
        try:
            issues = json.loads(issues_json)
            context["open_issues_count"] = len(issues)
            context["recent_issues"] = [
                f"#{i['number']}: {i['title']}" for i in issues[:3]
            ]
        except json.JSONDecodeError:
            # Malformed JSON from gh CLI; skip issue context.
            pass

    return context


def get_snapshot_summary(repo_root: Path) -> Dict:
    """Get snapshot summary if available."""
    snapshot_path = repo_root / "analysis" / "analysis-snapshot.json"
    if not snapshot_path.exists():
        return {}

    try:
        with open(snapshot_path, "r", encoding="utf-8") as f:
            snapshot = json.load(f)

        summary = snapshot.get("summary", {})
        return {
            "high_complexity_files": summary.get("high_complexity_files", 0),
            "todo_count": summary.get("todo_count", 0),
            "fixme_count": summary.get("fixme_count", 0),
            "circular_dependencies": summary.get("circular_dependency_count", 0),
        }
    except (json.JSONDecodeError, OSError):
        # Snapshot file unreadable or malformed; skip snapshot context.
        return {}


def main() -> int:
    """Main entry point."""
    # Read input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    repo_root = Path(input_data.get("cwd", os.getcwd()))

    # Gather context
    git_context = get_git_context(repo_root)
    issue_context = get_issue_context(repo_root)
    snapshot_context = get_snapshot_summary(repo_root)

    # Build context message
    parts = []

    if git_context:
        branch = git_context.get("branch", "unknown")
        commit = git_context.get("commit", "")
        changes = git_context.get("uncommitted_changes", 0)
        parts.append(f"Git: {branch} @ {commit}")
        if changes > 0:
            parts.append(f"Uncommitted changes: {changes} files")

    if issue_context.get("recent_issues"):
        parts.append(f"Open issues: {issue_context.get('open_issues_count', 0)}")

    if snapshot_context:
        if snapshot_context.get("fixme_count", 0) > 0:
            parts.append(f"FIXMEs: {snapshot_context['fixme_count']}")
        if snapshot_context.get("circular_dependencies", 0) > 0:
            parts.append(f"Circular deps: {snapshot_context['circular_dependencies']}")

    # Add reminder about skills
    parts.append(
        "Available skills: generate-snapshot, run-pre-commit-checks, "
        "cross-platform-paths, settings-precedence, python-manager-discovery"
    )

    # Output response
    if parts:
        response = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": " | ".join(parts),
            }
        }
    else:
        response = {}

    print(json.dumps(response))
    return 0


if __name__ == "__main__":
    sys.exit(main())
