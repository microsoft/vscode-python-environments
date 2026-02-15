# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Technical debt indicator detection.

Scans code for common debt markers like TODO comments, large files,
long functions, and code smells.
"""

import pathlib
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

import pathspec


@dataclass
class DebtMarker:
    """A technical debt marker found in code."""

    file: str
    line: int
    marker_type: str  # TODO, FIXME, HACK, XXX, etc.
    text: str

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "type": self.marker_type,
            "text": self.text[:200],  # Truncate long comments
        }


@dataclass
class LargeFile:
    """A file that exceeds size thresholds."""

    path: str
    total_lines: int
    code_lines: int

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "total_lines": self.total_lines,
            "code_lines": self.code_lines,
        }


@dataclass
class LongFunction:
    """A function that exceeds length thresholds."""

    file: str
    function_name: str
    line: int
    length: int

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "function": self.function_name,
            "line": self.line,
            "length": self.length,
        }


# Debt marker patterns
DEBT_PATTERNS = [
    (r"#\s*(TODO|FIXME|HACK|XXX|BUG|REFACTOR|OPTIMIZE|REVIEW)[:\s](.+)$", "python"),
    (
        r"//\s*(TODO|FIXME|HACK|XXX|BUG|REFACTOR|OPTIMIZE|REVIEW)[:\s](.+)$",
        "typescript",
    ),
    (
        r"/\*\s*(TODO|FIXME|HACK|XXX|BUG|REFACTOR|OPTIMIZE|REVIEW)[:\s](.+?)\*/",
        "typescript",
    ),
]

# Thresholds (configurable)
LARGE_FILE_THRESHOLD = 500  # lines of code
LONG_FUNCTION_THRESHOLD = 50  # lines


def load_gitignore(repo_root: pathlib.Path) -> Optional[pathspec.PathSpec]:
    """Load .gitignore patterns."""
    gitignore_path = repo_root / ".gitignore"
    if not gitignore_path.exists():
        return None

    with open(gitignore_path, "r", encoding="utf-8") as f:
        patterns = f.read().splitlines()

    return pathspec.PathSpec.from_lines("gitwildmatch", patterns)


def should_analyze_file(
    filepath: pathlib.Path,
    repo_root: pathlib.Path,
    gitignore: Optional[pathspec.PathSpec],
) -> bool:
    """Check if a file should be analyzed."""
    rel_path = filepath.relative_to(repo_root).as_posix()

    # Skip common non-source directories
    skip_dirs = {
        "node_modules",
        "dist",
        "out",
        ".venv",
        "__pycache__",
        ".git",
        ".vscode-test",
    }
    # Use relative path parts to avoid matching directories in repo root path
    rel_parts = filepath.relative_to(repo_root).parts
    for part in rel_parts:
        if part in skip_dirs:
            return False

    # Skip if matched by gitignore
    if gitignore and gitignore.match_file(rel_path):
        return False

    return True


def find_debt_markers(
    filepath: pathlib.Path, repo_root: pathlib.Path
) -> List[DebtMarker]:
    """Find TODO/FIXME/HACK markers in a file."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    rel_path = filepath.relative_to(repo_root).as_posix()
    markers = []

    # Determine file type
    suffix = filepath.suffix.lower()
    if suffix == ".py":
        file_type = "python"
    elif suffix in {".ts", ".js", ".tsx", ".jsx"}:
        file_type = "typescript"
    else:
        return []

    for pattern, pattern_type in DEBT_PATTERNS:
        if pattern_type != file_type:
            continue

        for line_num, line in enumerate(content.splitlines(), start=1):
            match = re.search(pattern, line, re.IGNORECASE)
            if match:
                marker_type = match.group(1).upper()
                text = match.group(2).strip() if match.lastindex >= 2 else ""
                markers.append(
                    DebtMarker(
                        file=rel_path,
                        line=line_num,
                        marker_type=marker_type,
                        text=text,
                    )
                )

    return markers


def analyze_file_size(
    filepath: pathlib.Path, repo_root: pathlib.Path
) -> Optional[LargeFile]:
    """Check if a file exceeds size thresholds."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None

    lines = content.splitlines()
    total_lines = len(lines)

    # Count code lines (non-empty, non-comment)
    suffix = filepath.suffix.lower()
    if suffix == ".py":
        code_lines = sum(
            1 for line in lines if line.strip() and not line.strip().startswith("#")
        )
    elif suffix in {".ts", ".js", ".tsx", ".jsx"}:
        code_lines = sum(
            1 for line in lines if line.strip() and not line.strip().startswith("//")
        )
    else:
        code_lines = total_lines

    if code_lines > LARGE_FILE_THRESHOLD:
        rel_path = filepath.relative_to(repo_root).as_posix()
        return LargeFile(path=rel_path, total_lines=total_lines, code_lines=code_lines)

    return None


def find_long_functions_python(
    filepath: pathlib.Path, repo_root: pathlib.Path
) -> List[LongFunction]:
    """Find Python functions that exceed length threshold."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    rel_path = filepath.relative_to(repo_root).as_posix()
    lines = content.splitlines()
    long_funcs = []

    # Simple pattern to find function definitions
    func_pattern = re.compile(r"^(\s*)(?:async\s+)?def\s+(\w+)\s*\(")

    current_func = None
    current_indent = 0
    func_start = 0

    for i, line in enumerate(lines):
        match = func_pattern.match(line)
        if match:
            # Check previous function
            if current_func:
                length = i - func_start
                if length > LONG_FUNCTION_THRESHOLD:
                    long_funcs.append(
                        LongFunction(
                            file=rel_path,
                            function_name=current_func,
                            line=func_start + 1,
                            length=length,
                        )
                    )

            current_indent = len(match.group(1))
            current_func = match.group(2)
            func_start = i

        # Detect when we've left the current function (dedent to same or less level)
        elif current_func and line.strip():
            line_indent = len(line) - len(line.lstrip())
            if line_indent <= current_indent and not line.strip().startswith("#"):
                # End of function
                length = i - func_start
                if length > LONG_FUNCTION_THRESHOLD:
                    long_funcs.append(
                        LongFunction(
                            file=rel_path,
                            function_name=current_func,
                            line=func_start + 1,
                            length=length,
                        )
                    )
                current_func = None

    # Check last function
    if current_func:
        length = len(lines) - func_start
        if length > LONG_FUNCTION_THRESHOLD:
            long_funcs.append(
                LongFunction(
                    file=rel_path,
                    function_name=current_func,
                    line=func_start + 1,
                    length=length,
                )
            )

    return long_funcs


def find_long_functions_typescript(
    filepath: pathlib.Path, repo_root: pathlib.Path
) -> List[LongFunction]:
    """Find TypeScript functions that exceed length threshold."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []

    rel_path = filepath.relative_to(repo_root).as_posix()
    lines = content.splitlines()
    long_funcs = []

    # Simplified pattern for function definitions
    func_pattern = re.compile(
        r"^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{)"
    )

    i = 0
    while i < len(lines):
        match = func_pattern.match(lines[i])
        if match:
            func_name = match.group(1) or match.group(2) or "anonymous"
            func_start = i

            # Count braces to find function end
            brace_count = 0
            found_open = False

            for j in range(i, len(lines)):
                line = lines[j]
                for char in line:
                    if char == "{":
                        brace_count += 1
                        found_open = True
                    elif char == "}":
                        brace_count -= 1

                if found_open and brace_count == 0:
                    length = j - func_start + 1
                    if length > LONG_FUNCTION_THRESHOLD:
                        long_funcs.append(
                            LongFunction(
                                file=rel_path,
                                function_name=func_name,
                                line=func_start + 1,
                                length=length,
                            )
                        )
                    i = j
                    break
            else:
                # Reached end without closing brace
                break

        i += 1

    return long_funcs


def analyze_debt(repo_root: pathlib.Path) -> dict:
    """Run complete debt indicator analysis.

    Returns:
        Dictionary with all debt indicators
    """
    gitignore = load_gitignore(repo_root)

    all_markers: List[DebtMarker] = []
    large_files: List[LargeFile] = []
    long_functions: List[LongFunction] = []

    # Find all source files
    extensions = [".py", ".ts", ".js", ".tsx", ".jsx"]
    source_files = []

    for ext in extensions:
        for filepath in repo_root.rglob(f"*{ext}"):
            if should_analyze_file(filepath, repo_root, gitignore):
                source_files.append(filepath)

    # Analyze each file
    for filepath in source_files:
        # Find debt markers
        markers = find_debt_markers(filepath, repo_root)
        all_markers.extend(markers)

        # Check file size
        large_file = analyze_file_size(filepath, repo_root)
        if large_file:
            large_files.append(large_file)

        # Find long functions
        suffix = filepath.suffix.lower()
        if suffix == ".py":
            long_funcs = find_long_functions_python(filepath, repo_root)
        elif suffix in {".ts", ".js", ".tsx", ".jsx"}:
            long_funcs = find_long_functions_typescript(filepath, repo_root)
        else:
            long_funcs = []

        long_functions.extend(long_funcs)

    # Group markers by type
    markers_by_type: Dict[str, List[dict]] = {}
    for marker in all_markers:
        if marker.marker_type not in markers_by_type:
            markers_by_type[marker.marker_type] = []
        markers_by_type[marker.marker_type].append(marker.to_dict())

    # Sort large files and long functions
    large_files.sort(key=lambda f: f.code_lines, reverse=True)
    long_functions.sort(key=lambda f: f.length, reverse=True)

    return {
        "debt_markers": {
            "by_type": markers_by_type,
            "total_count": len(all_markers),
            "summary": {
                marker_type: len(markers)
                for marker_type, markers in markers_by_type.items()
            },
        },
        "large_files": {
            "files": [f.to_dict() for f in large_files],
            "count": len(large_files),
            "threshold": LARGE_FILE_THRESHOLD,
        },
        "long_functions": {
            "functions": [f.to_dict() for f in long_functions[:50]],  # Top 50
            "count": len(long_functions),
            "threshold": LONG_FUNCTION_THRESHOLD,
        },
        "files_analyzed": len(source_files),
    }


if __name__ == "__main__":
    import json

    repo = pathlib.Path(__file__).parent.parent
    result = analyze_debt(repo)
    print(json.dumps(result, indent=2))
