# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""
Git-based code analysis inspired by "Your Code as a Crime Scene" and "Software Design X-Rays".

Extracts metrics from git history:
- Change frequency (hotspots)
- Code churn (lines added/removed)
- Temporal coupling (files that change together)
- Author diversity / bus factor
- File age analysis
"""

import pathlib
import subprocess
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

# Limit history analysis for performance
MAX_COMMITS = 1000
DAYS_OF_HISTORY = 365


@dataclass
class FileStats:
    """Statistics for a single file from git history."""

    path: str
    change_count: int = 0
    lines_added: int = 0
    lines_removed: int = 0
    authors: Set[str] = field(default_factory=set)
    last_modified: Optional[datetime] = None
    first_seen: Optional[datetime] = None

    @property
    def churn(self) -> int:
        """Total code churn (additions + deletions)."""
        return self.lines_added + self.lines_removed

    @property
    def author_count(self) -> int:
        """Number of unique authors who touched this file."""
        return len(self.authors)

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dictionary."""
        return {
            "path": self.path,
            "change_count": self.change_count,
            "lines_added": self.lines_added,
            "lines_removed": self.lines_removed,
            "churn": self.churn,
            "author_count": self.author_count,
            "authors": sorted(self.authors),
            "last_modified": self.last_modified.isoformat()
            if self.last_modified
            else None,
            "first_seen": self.first_seen.isoformat() if self.first_seen else None,
            "age_days": (datetime.now(timezone.utc) - self.last_modified).days
            if self.last_modified
            else None,
        }


@dataclass
class TemporalCoupling:
    """Represents files that frequently change together."""

    file1: str
    file2: str
    coupled_commits: int
    coupling_ratio: float  # coupled_commits / min(file1_changes, file2_changes)

    def to_dict(self) -> dict:
        return {
            "file1": self.file1,
            "file2": self.file2,
            "coupled_commits": self.coupled_commits,
            "coupling_ratio": round(self.coupling_ratio, 3),
        }


def run_git_command(args: List[str], cwd: pathlib.Path) -> str:
    """Run a git command and return stdout."""
    result = subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    return result.stdout


def get_tracked_files(repo_root: pathlib.Path) -> Set[str]:
    """Get set of currently tracked files in the repository."""
    output = run_git_command(["ls-files"], repo_root)
    return set(output.strip().split("\n")) if output.strip() else set()


def analyze_git_log(repo_root: pathlib.Path) -> Dict[str, FileStats]:
    """
    Parse git log to extract file statistics.

    Uses git log --numstat for efficient extraction of:
    - Change frequency per file
    - Lines added/removed per file
    - Authors per file
    - Timestamps
    """
    file_stats: Dict[str, FileStats] = defaultdict(lambda: FileStats(path=""))

    # Get commits from last N days, limited to MAX_COMMITS
    try:
        log_output = run_git_command(
            [
                "log",
                f"--since={DAYS_OF_HISTORY} days ago",
                f"-n{MAX_COMMITS}",
                "--numstat",
                "--format=%H|%aI|%aN",
                "--no-merges",
            ],
            repo_root,
        )
    except subprocess.CalledProcessError:
        return {}

    current_commit_info: Optional[Tuple[str, datetime, str]] = None
    tracked_files = get_tracked_files(repo_root)

    for line in log_output.split("\n"):
        line = line.strip()
        if not line:
            continue

        # Check if this is a commit header line
        if "|" in line and line.count("|") == 2:
            parts = line.split("|")
            if len(parts) == 3:
                commit_hash, date_str, author = parts
                try:
                    commit_date = datetime.fromisoformat(
                        date_str.replace("Z", "+00:00")
                    )
                    current_commit_info = (commit_hash, commit_date, author)
                except ValueError:
                    current_commit_info = None
                continue

        # Parse numstat line: "added\tremoved\tfilepath"
        if current_commit_info and "\t" in line:
            parts = line.split("\t")
            if len(parts) >= 3:
                added, removed, filepath = parts[0], parts[1], parts[2]

                # Skip binary files (shown as "-")
                if added == "-" or removed == "-":
                    continue

                # Only track files that currently exist
                if filepath not in tracked_files:
                    continue

                # Skip test files and generated files for hotspot analysis
                if _should_skip_file(filepath):
                    continue

                try:
                    lines_added = int(added)
                    lines_removed = int(removed)
                except ValueError:
                    continue

                _, commit_date, author = current_commit_info

                if filepath not in file_stats:
                    file_stats[filepath] = FileStats(path=filepath)

                stats = file_stats[filepath]
                stats.change_count += 1
                stats.lines_added += lines_added
                stats.lines_removed += lines_removed
                stats.authors.add(author)

                # Track dates
                if stats.last_modified is None or commit_date > stats.last_modified:
                    stats.last_modified = commit_date
                if stats.first_seen is None or commit_date < stats.first_seen:
                    stats.first_seen = commit_date

    return dict(file_stats)


def _should_skip_file(filepath: str) -> bool:
    """Check if file should be excluded from analysis."""
    # Normalize path separators so patterns work cross-platform
    normalized_path = filepath.replace("\\", "/")

    skip_patterns = [
        "node_modules/",
        "dist/",
        ".vscode-test/",
        "__pycache__/",
        ".git/",
        "package-lock.json",
        ".vsix",
        # Skip test directories
        "/test/",
        "/tests/",
        "/__tests__/",
        "/mocks/",
    ]
    if any(pattern in normalized_path for pattern in skip_patterns):
        return True

    # Check filename-based test patterns
    path = pathlib.Path(filepath)
    filename = path.name

    # Common test file naming conventions
    if (
        filename.startswith("test_")
        or filename.endswith("_test.py")
        or filename.endswith("_tests.py")
        or ".test." in filename
        or ".spec." in filename
    ):
        return True

    # Skip files in well-known test directories (check path parts)
    test_dirs = {"test", "tests", "__tests__", "mocks"}
    dir_parts = path.parts[:-1]  # exclude the filename
    if any(part in test_dirs for part in dir_parts):
        return True

    return False


def analyze_temporal_coupling(
    repo_root: pathlib.Path, min_coupling: int = 3, min_ratio: float = 0.3
) -> List[TemporalCoupling]:
    """
    Find files that frequently change together (temporal coupling).

    High temporal coupling can indicate:
    - Hidden dependencies
    - Copy-paste code
    - Features spread across files

    Args:
        repo_root: Repository root path
        min_coupling: Minimum number of co-changes to report
        min_ratio: Minimum coupling ratio (0.0 to 1.0)
    """
    # Track which files changed in each commit
    commit_files: Dict[str, Set[str]] = defaultdict(set)
    file_change_count: Dict[str, int] = defaultdict(int)

    try:
        log_output = run_git_command(
            [
                "log",
                f"--since={DAYS_OF_HISTORY} days ago",
                f"-n{MAX_COMMITS}",
                "--name-only",
                "--format=%H",
                "--no-merges",
            ],
            repo_root,
        )
    except subprocess.CalledProcessError:
        return []

    tracked_files = get_tracked_files(repo_root)
    current_commit: Optional[str] = None

    for line in log_output.split("\n"):
        line = line.strip()
        if not line:
            continue

        # Commit hash is 40 hex characters
        if len(line) == 40 and all(c in "0123456789abcdef" for c in line):
            current_commit = line
            continue

        if current_commit and line in tracked_files and not _should_skip_file(line):
            commit_files[current_commit].add(line)
            file_change_count[line] += 1

    # Calculate coupling between file pairs
    coupling_count: Dict[Tuple[str, str], int] = defaultdict(int)

    for files in commit_files.values():
        file_list = sorted(files)
        for i, file1 in enumerate(file_list):
            for file2 in file_list[i + 1 :]:
                coupling_count[(file1, file2)] += 1

    # Filter and create coupling objects
    couplings: List[TemporalCoupling] = []
    for (file1, file2), count in coupling_count.items():
        if count < min_coupling:
            continue

        # Calculate coupling ratio relative to less-changed file
        min_changes = min(file_change_count[file1], file_change_count[file2])
        ratio = count / min_changes if min_changes > 0 else 0

        if ratio >= min_ratio:
            couplings.append(
                TemporalCoupling(
                    file1=file1,
                    file2=file2,
                    coupled_commits=count,
                    coupling_ratio=ratio,
                )
            )

    # Sort by coupling strength
    couplings.sort(key=lambda c: (c.coupling_ratio, c.coupled_commits), reverse=True)
    return couplings[:50]  # Top 50 couplings


def calculate_bus_factor(file_stats: Dict[str, FileStats]) -> dict:
    """
    Calculate bus factor metrics.

    Bus factor = minimum number of authors who need to leave
    before knowledge is lost.

    Low bus factor (1-2) indicates knowledge silos.
    """
    # Overall project bus factor
    all_authors: Set[str] = set()
    single_author_files: List[str] = []

    for stats in file_stats.values():
        all_authors.update(stats.authors)
        if stats.author_count == 1:
            single_author_files.append(stats.path)

    # Files with low bus factor (knowledge silos)
    knowledge_silos = [
        {"path": stats.path, "sole_author": sorted(stats.authors)[0]}
        for stats in file_stats.values()
        if stats.author_count == 1 and stats.change_count >= 3
    ]

    # Sort by change count (more changes = higher risk)
    knowledge_silos.sort(key=lambda x: file_stats[x["path"]].change_count, reverse=True)

    return {
        "total_authors": len(all_authors),
        "single_author_file_count": len(single_author_files),
        "single_author_file_ratio": round(len(single_author_files) / len(file_stats), 3)
        if file_stats
        else 0,
        "knowledge_silos": knowledge_silos[:20],  # Top 20 at-risk files
    }


def get_hotspots(file_stats: Dict[str, FileStats], top_n: int = 30) -> List[dict]:
    """
    Identify hotspots - files that change frequently.

    Hotspots are prime candidates for:
    - Code review focus
    - Refactoring
    - Test coverage
    """
    sorted_files = sorted(
        file_stats.values(),
        key=lambda s: (s.change_count, s.churn),
        reverse=True,
    )
    return [f.to_dict() for f in sorted_files[:top_n]]


def analyze_repository(repo_root: pathlib.Path) -> dict:
    """
    Run complete git-based analysis on a repository.

    Returns a dictionary with all git metrics.
    """
    file_stats = analyze_git_log(repo_root)
    temporal_coupling = analyze_temporal_coupling(repo_root)
    bus_factor = calculate_bus_factor(file_stats)
    hotspots = get_hotspots(file_stats)

    return {
        "hotspots": hotspots,
        "temporal_coupling": [c.to_dict() for c in temporal_coupling],
        "bus_factor": bus_factor,
        "summary": {
            "files_analyzed": len(file_stats),
            "total_changes": sum(s.change_count for s in file_stats.values()),
            "total_churn": sum(s.churn for s in file_stats.values()),
            "history_days": DAYS_OF_HISTORY,
            "max_commits": MAX_COMMITS,
        },
    }


if __name__ == "__main__":
    import json

    repo = pathlib.Path(__file__).parent.parent
    results = analyze_repository(repo)
    print(json.dumps(results, indent=2))
