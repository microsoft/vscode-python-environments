# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Static code complexity analysis using radon for Python and regex patterns for TypeScript."""

import pathlib
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

import pathspec

# Radon is optional - graceful fallback if not available
try:
    from radon.complexity import cc_visit
    from radon.metrics import mi_visit

    RADON_AVAILABLE = True
except ImportError:
    RADON_AVAILABLE = False


@dataclass
class FunctionComplexity:
    """Complexity metrics for a single function/method."""

    name: str
    line: int
    complexity: int
    length: int  # lines of code

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "line": self.line,
            "complexity": self.complexity,
            "length": self.length,
        }


@dataclass
class FileComplexity:
    """Complexity metrics for a file."""

    path: str
    total_lines: int
    code_lines: int
    functions: List[FunctionComplexity]
    max_complexity: int
    avg_complexity: float
    maintainability_index: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "total_lines": self.total_lines,
            "code_lines": self.code_lines,
            "function_count": len(self.functions),
            "max_complexity": self.max_complexity,
            "avg_complexity": round(self.avg_complexity, 2),
            "maintainability_index": round(self.maintainability_index, 2)
            if self.maintainability_index
            else None,
            "functions": [f.to_dict() for f in self.functions],
        }


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
    for part in filepath.parts:
        if part in skip_dirs:
            return False

    # Skip if matched by gitignore
    if gitignore and gitignore.match_file(rel_path):
        return False

    return True


def analyze_python_file(
    filepath: pathlib.Path, repo_root: pathlib.Path
) -> Optional[FileComplexity]:
    """Analyze a Python file for complexity metrics."""
    if not RADON_AVAILABLE:
        return None

    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None

    lines = content.splitlines()
    total_lines = len(lines)
    code_lines = sum(
        1 for line in lines if line.strip() and not line.strip().startswith("#")
    )

    try:
        cc_results = cc_visit(content)
        mi_score = mi_visit(content, multi=False)
    except SyntaxError:
        return None

    functions = []
    for block in cc_results:
        # radon returns different block types (Function, Class, etc.)
        func = FunctionComplexity(
            name=block.name,
            line=block.lineno,
            complexity=block.complexity,
            length=block.endline - block.lineno + 1 if hasattr(block, "endline") else 0,
        )
        functions.append(func)

    max_cc = max((f.complexity for f in functions), default=0)
    avg_cc = sum(f.complexity for f in functions) / len(functions) if functions else 0

    rel_path = filepath.relative_to(repo_root).as_posix()
    return FileComplexity(
        path=rel_path,
        total_lines=total_lines,
        code_lines=code_lines,
        functions=functions,
        max_complexity=max_cc,
        avg_complexity=avg_cc,
        maintainability_index=mi_score,
    )


def analyze_typescript_file(
    filepath: pathlib.Path, repo_root: pathlib.Path
) -> Optional[FileComplexity]:
    """Analyze a TypeScript file for complexity metrics using regex patterns.

    This is a simplified analysis - for accurate TypeScript complexity,
    consider using ts-morph or typescript compiler API.
    """
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None

    lines = content.splitlines()
    total_lines = len(lines)
    code_lines = sum(
        1 for line in lines if line.strip() and not line.strip().startswith("//")
    )

    # Find function/method definitions
    # Matches: function name, async function name, methodName(, async methodName(
    function_pattern = re.compile(
        r"^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{)",
        re.MULTILINE,
    )

    # Complexity indicators (simplified cyclomatic complexity estimation)
    branch_patterns = [
        r"\bif\s*\(",
        r"\belse\s+if\s*\(",
        r"\belse\s*\{",
        r"\bfor\s*\(",
        r"\bwhile\s*\(",
        r"\bswitch\s*\(",
        r"\bcase\s+",
        r"\bcatch\s*\(",
        r"\b\?\s*[^:]+\s*:",  # ternary
        r"\?\?",  # nullish coalescing
        r"\|\|",  # logical or
        r"&&",  # logical and
    ]

    functions = []
    func_matches = list(function_pattern.finditer(content))

    for i, match in enumerate(func_matches):
        func_name = match.group(1) or match.group(2) or "anonymous"
        start_line = content[: match.start()].count("\n") + 1

        # Find function end (rough estimate - count braces)
        func_end = len(content)

        if i + 1 < len(func_matches):
            func_end = func_matches[i + 1].start()

        func_content = content[match.start() : func_end]

        # Count complexity
        complexity = 1  # Base complexity
        for pattern in branch_patterns:
            complexity += len(re.findall(pattern, func_content))

        length = func_content.count("\n") + 1

        functions.append(
            FunctionComplexity(
                name=func_name,
                line=start_line,
                complexity=complexity,
                length=length,
            )
        )

    max_cc = max((f.complexity for f in functions), default=0)
    avg_cc = sum(f.complexity for f in functions) / len(functions) if functions else 0

    rel_path = filepath.relative_to(repo_root).as_posix()
    return FileComplexity(
        path=rel_path,
        total_lines=total_lines,
        code_lines=code_lines,
        functions=functions,
        max_complexity=max_cc,
        avg_complexity=avg_cc,
        maintainability_index=None,  # Not computed for TypeScript
    )


def find_source_files(
    repo_root: pathlib.Path, extensions: List[str]
) -> List[pathlib.Path]:
    """Find all source files with given extensions."""
    gitignore = load_gitignore(repo_root)
    files = []

    for ext in extensions:
        for filepath in repo_root.rglob(f"*{ext}"):
            if should_analyze_file(filepath, repo_root, gitignore):
                files.append(filepath)

    return files


def analyze_complexity(repo_root: pathlib.Path) -> dict:
    """Run complexity analysis on the repository.

    Returns:
        Dictionary with complexity metrics for all analyzed files
    """
    results: Dict[str, List[dict]] = {
        "python": [],
        "typescript": [],
    }

    # Analyze Python files
    python_files = find_source_files(repo_root, [".py"])
    for filepath in python_files:
        file_complexity = analyze_python_file(filepath, repo_root)
        if file_complexity:
            results["python"].append(file_complexity.to_dict())

    # Analyze TypeScript files
    ts_files = find_source_files(repo_root, [".ts"])
    for filepath in ts_files:
        file_complexity = analyze_typescript_file(filepath, repo_root)
        if file_complexity:
            results["typescript"].append(file_complexity.to_dict())

    # Compute summary statistics
    all_files = results["python"] + results["typescript"]

    summary = {
        "total_files": len(all_files),
        "total_functions": sum(f["function_count"] for f in all_files),
        "total_lines": sum(f["total_lines"] for f in all_files),
        "total_code_lines": sum(f["code_lines"] for f in all_files),
        "files_with_high_complexity": [
            f["path"] for f in all_files if f["max_complexity"] > 10
        ],
        "avg_file_complexity": round(
            sum(f["avg_complexity"] for f in all_files) / len(all_files), 2
        )
        if all_files
        else 0,
    }

    # Sort files by max complexity (most complex first)
    results["python"].sort(key=lambda f: f["max_complexity"], reverse=True)
    results["typescript"].sort(key=lambda f: f["max_complexity"], reverse=True)

    return {
        "by_language": results,
        "summary": summary,
        "high_complexity_functions": _get_high_complexity_functions(
            all_files, threshold=10
        ),
    }


def _get_high_complexity_functions(
    files: List[dict], threshold: int = 10
) -> List[dict]:
    """Extract functions with complexity above threshold."""
    high_cc = []
    for file_data in files:
        for func in file_data.get("functions", []):
            if func["complexity"] > threshold:
                high_cc.append(
                    {
                        "file": file_data["path"],
                        "function": func["name"],
                        "line": func["line"],
                        "complexity": func["complexity"],
                    }
                )

    high_cc.sort(key=lambda f: f["complexity"], reverse=True)
    return high_cc[:30]  # Top 30


if __name__ == "__main__":
    import json

    repo = pathlib.Path(__file__).parent.parent
    result = analyze_complexity(repo)
    print(json.dumps(result, indent=2))
