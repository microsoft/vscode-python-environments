# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Main orchestrator for code health snapshot generation.

Aggregates results from all analysis modules into a single JSON snapshot
suitable for tracking technical debt over time.
"""

import argparse
import json
import pathlib
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from typing import Optional

# Import analysis modules (relative imports for package structure)
from .complexity_analysis import analyze_complexity
from .debt_indicators import analyze_debt
from .dependency_analysis import analyze_dependencies
from .git_analysis import analyze_repository as analyze_git

# Snapshot schema version - increment when breaking changes are made
SCHEMA_VERSION = "1.0.0"


def get_git_info(repo_root: pathlib.Path) -> dict:
    """Get current git commit information."""
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()

        short_sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()

        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()

        # Get commit message
        message = subprocess.run(
            ["git", "log", "-1", "--pretty=%s"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()

        return {
            "sha": sha,
            "short_sha": short_sha,
            "branch": branch,
            "message": message[:200],  # Truncate long messages
        }
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return {
            "sha": "unknown",
            "short_sha": "unknown",
            "branch": "unknown",
            "message": "",
        }


def compute_priority_hotspots(git_data: dict, complexity_data: dict) -> list:
    """Compute priority hotspots by combining change frequency with complexity.

    Files that are both frequently changed AND complex are the highest priority
    for refactoring attention (the "X-Ray" approach from Software Design X-Rays).
    """
    # Build complexity lookup by path
    complexity_by_path = {}
    for lang_files in complexity_data.get("by_language", {}).values():
        for file_data in lang_files:
            complexity_by_path[file_data["path"]] = file_data

    priority_hotspots = []
    for hotspot in git_data.get("hotspots", []):
        path = hotspot["path"]
        complexity_info = complexity_by_path.get(path, {})

        # Priority score = change_count * max_complexity
        # Higher score = more urgent attention needed
        change_count = hotspot.get("change_count", 0)
        max_complexity = complexity_info.get("max_complexity", 1)
        priority_score = change_count * max_complexity

        priority_hotspots.append(
            {
                "path": path,
                "change_count": change_count,
                "churn": hotspot.get("churn", 0),
                "max_complexity": max_complexity,
                "avg_complexity": complexity_info.get("avg_complexity", 0),
                "code_lines": complexity_info.get("code_lines", 0),
                "priority_score": priority_score,
            }
        )

    # Sort by priority score descending
    priority_hotspots.sort(key=lambda x: x["priority_score"], reverse=True)
    return priority_hotspots[:20]  # Top 20


def compute_summary_metrics(
    git_data: dict,
    complexity_data: dict,
    debt_data: dict,
    dependency_data: dict,
) -> dict:
    """Compute high-level summary metrics for dashboard/trending."""
    return {
        # Change activity
        "files_with_changes": git_data.get("summary", {}).get("files_analyzed", 0),
        "total_changes": git_data.get("summary", {}).get("total_changes", 0),
        "total_churn": git_data.get("summary", {}).get("total_churn", 0),
        # Complexity
        "total_files_analyzed": complexity_data.get("summary", {}).get(
            "total_files", 0
        ),
        "total_functions": complexity_data.get("summary", {}).get("total_functions", 0),
        "high_complexity_files": len(
            complexity_data.get("summary", {}).get("files_with_high_complexity", [])
        ),
        "avg_file_complexity": complexity_data.get("summary", {}).get(
            "avg_file_complexity", 0
        ),
        # Debt markers
        "todo_count": debt_data.get("debt_markers", {})
        .get("summary", {})
        .get("TODO", 0),
        "fixme_count": debt_data.get("debt_markers", {})
        .get("summary", {})
        .get("FIXME", 0),
        "total_debt_markers": debt_data.get("debt_markers", {}).get("total_count", 0),
        "large_file_count": debt_data.get("large_files", {}).get("count", 0),
        "long_function_count": debt_data.get("long_functions", {}).get("count", 0),
        # Dependencies
        "module_count": dependency_data.get("summary", {}).get("total_modules", 0),
        "circular_dependency_count": dependency_data.get("summary", {}).get(
            "circular_dependency_count", 0
        ),
        "highly_coupled_module_count": dependency_data.get("summary", {}).get(
            "highly_coupled_count", 0
        ),
        # Bus factor
        "single_author_file_ratio": git_data.get("bus_factor", {}).get(
            "single_author_file_ratio", 0
        ),
        "total_authors": git_data.get("bus_factor", {}).get("total_authors", 0),
    }


def generate_snapshot(
    repo_root: pathlib.Path, output_path: Optional[pathlib.Path] = None
) -> dict:
    """Generate a complete code health snapshot.

    Args:
        repo_root: Path to repository root
        output_path: Optional path to write JSON output

    Returns:
        Complete snapshot dictionary
    """
    print("Starting code health analysis...", file=sys.stderr)

    # Gather metadata
    git_info = get_git_info(repo_root)
    timestamp = datetime.now(timezone.utc).isoformat()

    print(f"  Commit: {git_info['short_sha']} ({git_info['branch']})", file=sys.stderr)
    print(f"  Time: {timestamp}", file=sys.stderr)

    # Run all analyses
    print("  Analyzing git history...", file=sys.stderr)
    git_data = analyze_git(repo_root)

    print("  Analyzing code complexity...", file=sys.stderr)
    complexity_data = analyze_complexity(repo_root)

    print("  Scanning for debt indicators...", file=sys.stderr)
    debt_data = analyze_debt(repo_root)

    print("  Analyzing dependencies...", file=sys.stderr)
    dependency_data = analyze_dependencies(repo_root)

    # Compute derived metrics
    print("  Computing priority hotspots...", file=sys.stderr)
    priority_hotspots = compute_priority_hotspots(git_data, complexity_data)

    print("  Generating summary metrics...", file=sys.stderr)
    summary = compute_summary_metrics(
        git_data, complexity_data, debt_data, dependency_data
    )

    # Assemble snapshot
    snapshot = {
        "metadata": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": timestamp,
            "git": git_info,
        },
        "summary": summary,
        "priority_hotspots": priority_hotspots,
        "git_analysis": git_data,
        "complexity": complexity_data,
        "debt_indicators": debt_data,
        "dependencies": dependency_data,
    }

    # Write output if path specified
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, indent=2, ensure_ascii=False)
        print(f"  Snapshot written to: {output_path}", file=sys.stderr)

    print("Analysis complete!", file=sys.stderr)
    return snapshot


def build_arg_parser() -> argparse.ArgumentParser:
    """Build argument parser."""
    parser = argparse.ArgumentParser(
        description="Generate code health snapshot for technical debt tracking."
    )
    parser.add_argument(
        "--output",
        "-o",
        type=pathlib.Path,
        default=pathlib.Path("analysis-snapshot.json"),
        help="Output path for snapshot JSON (default: analysis-snapshot.json)",
    )
    parser.add_argument(
        "--repo-root",
        type=pathlib.Path,
        default=None,
        help="Repository root path (default: parent of this script)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output to stdout",
    )
    return parser


def main() -> int:
    """Main entry point."""
    parser = build_arg_parser()
    args = parser.parse_args()

    repo_root = args.repo_root or pathlib.Path(__file__).parent.parent
    repo_root = repo_root.resolve()

    if not (repo_root / ".git").exists():
        print(f"Error: {repo_root} is not a git repository", file=sys.stderr)
        return 1

    try:
        snapshot = generate_snapshot(repo_root, args.output)

        if args.pretty:
            print(json.dumps(snapshot, indent=2, ensure_ascii=False))

        return 0
    except Exception as e:
        print(f"Error generating snapshot: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
