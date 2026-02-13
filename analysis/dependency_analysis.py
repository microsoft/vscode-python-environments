# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""Dependency and coupling analysis for TypeScript/JavaScript modules.

Analyzes import/export patterns to identify:
- Module dependencies
- Circular dependencies
- Highly coupled modules (too many imports)
- Fan-in/fan-out metrics
"""

import pathlib
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

import pathspec


@dataclass
class ModuleInfo:
    """Information about a single module's dependencies."""

    path: str
    imports: Set[str] = field(default_factory=set)  # Modules this imports
    imported_by: Set[str] = field(default_factory=set)  # Modules that import this

    @property
    def fan_out(self) -> int:
        """Number of modules this depends on (outgoing edges)."""
        return len(self.imports)

    @property
    def fan_in(self) -> int:
        """Number of modules that depend on this (incoming edges)."""
        return len(self.imported_by)

    @property
    def instability(self) -> float:
        """Instability metric: fan_out / (fan_in + fan_out).

        0 = maximally stable (nothing depends on this module's dependencies)
        1 = maximally unstable (all dependencies, no dependents)
        """
        total = self.fan_in + self.fan_out
        if total == 0:
            return 0.0
        return self.fan_out / total

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "fan_out": self.fan_out,
            "fan_in": self.fan_in,
            "instability": round(self.instability, 3),
            "imports": sorted(self.imports),
            "imported_by": sorted(self.imported_by),
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

    # Skip test and mock files for dependency analysis
    if any(x in rel_path for x in ["/test/", "/mocks/", ".test.", ".spec."]):
        return False

    return True


def extract_imports_typescript(
    filepath: pathlib.Path, repo_root: pathlib.Path
) -> Set[str]:
    """Extract import paths from a TypeScript/JavaScript file."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return set()

    imports = set()

    # Match various import patterns:
    # import { x } from './path'
    # import x from './path'
    # import * as x from './path'
    # import './path'
    # const x = require('./path')
    import_patterns = [
        r'import\s+(?:.*?\s+from\s+)?[\'"]([^\'"]+)[\'"]',
        r'require\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)',
        r'import\s*\(\s*[\'"]([^\'"]+)[\'"]\s*\)',  # dynamic import
    ]

    for pattern in import_patterns:
        for match in re.finditer(pattern, content):
            import_path = match.group(1)

            # Only track relative imports (local modules)
            if import_path.startswith("."):
                # Resolve relative path
                resolved = resolve_import_path(filepath, import_path, repo_root)
                if resolved:
                    imports.add(resolved)

    return imports


def resolve_import_path(
    from_file: pathlib.Path, import_path: str, repo_root: pathlib.Path
) -> Optional[str]:
    """Resolve a relative import path to a workspace-relative path."""
    from_dir = from_file.parent

    # Handle the import path
    # Remove ./ or ../ prefixes and resolve
    resolved = (from_dir / import_path).resolve()

    # Try common extensions
    candidates = [
        resolved,
        resolved.with_suffix(".ts"),
        resolved.with_suffix(".tsx"),
        resolved.with_suffix(".js"),
        resolved / "index.ts",
        resolved / "index.tsx",
        resolved / "index.js",
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            try:
                return candidate.relative_to(repo_root).as_posix()
            except ValueError:
                return None

    return None


def build_dependency_graph(repo_root: pathlib.Path) -> Dict[str, ModuleInfo]:
    """Build a dependency graph of all TypeScript modules."""
    gitignore = load_gitignore(repo_root)
    modules: Dict[str, ModuleInfo] = {}

    # Find all TypeScript/JavaScript files
    extensions = [".ts", ".tsx", ".js", ".jsx"]
    source_files = []

    for ext in extensions:
        for filepath in repo_root.rglob(f"*{ext}"):
            if should_analyze_file(filepath, repo_root, gitignore):
                source_files.append(filepath)

    # First pass: extract imports
    for filepath in source_files:
        rel_path = filepath.relative_to(repo_root).as_posix()
        imports = extract_imports_typescript(filepath, repo_root)

        modules[rel_path] = ModuleInfo(path=rel_path, imports=imports)

    # Second pass: compute imported_by (reverse dependencies)
    for module_path, module_info in modules.items():
        for imported_path in module_info.imports:
            if imported_path in modules:
                modules[imported_path].imported_by.add(module_path)

    return modules


def find_circular_dependencies(modules: Dict[str, ModuleInfo]) -> List[List[str]]:
    """Find circular dependency chains using DFS."""
    cycles = []
    visited = set()
    rec_stack = set()

    def dfs(node: str, path: List[str]) -> None:
        if node in rec_stack:
            # Found cycle - extract it
            cycle_start = path.index(node)
            cycle = path[cycle_start:] + [node]
            # Normalize cycle (start from smallest element)
            min_idx = cycle.index(min(cycle[:-1]))  # Exclude last element (duplicate)
            normalized = cycle[min_idx:-1] + cycle[:min_idx] + [cycle[min_idx]]
            if normalized not in cycles:
                cycles.append(normalized)
            return

        if node in visited:
            return

        visited.add(node)
        rec_stack.add(node)

        module = modules.get(node)
        if module:
            for imported in module.imports:
                if imported in modules:
                    dfs(imported, path + [node])

        rec_stack.remove(node)

    for module_path in modules:
        if module_path not in visited:
            dfs(module_path, [])

    return cycles


def find_highly_coupled_modules(
    modules: Dict[str, ModuleInfo], threshold: int = 10
) -> List[dict]:
    """Find modules with too many dependencies (high fan-out)."""
    highly_coupled = []

    for module_path, module_info in modules.items():
        if module_info.fan_out > threshold:
            highly_coupled.append(
                {
                    "path": module_path,
                    "fan_out": module_info.fan_out,
                    "imports": sorted(module_info.imports),
                }
            )

    highly_coupled.sort(key=lambda m: m["fan_out"], reverse=True)
    return highly_coupled


def find_hub_modules(modules: Dict[str, ModuleInfo], threshold: int = 10) -> List[dict]:
    """Find 'hub' modules with high fan-in (many dependents).

    These are candidates for careful change management - changes here affect many modules.
    """
    hubs = []

    for module_path, module_info in modules.items():
        if module_info.fan_in > threshold:
            hubs.append(
                {
                    "path": module_path,
                    "fan_in": module_info.fan_in,
                    "imported_by": sorted(module_info.imported_by),
                }
            )

    hubs.sort(key=lambda m: m["fan_in"], reverse=True)
    return hubs


def compute_layer_violations(modules: Dict[str, ModuleInfo]) -> List[dict]:
    """Detect potential architectural layer violations.

    Common pattern: lower layers should not import from higher layers.
    """
    # Define typical layer order (lower index = lower layer)
    layer_order = [
        "common",
        "utils",
        "api",
        "models",
        "services",
        "features",
        "views",
        "managers",
    ]

    def get_layer(path: str) -> int:
        """Get the layer index for a module path."""
        parts = path.lower().split("/")
        for i, layer in enumerate(layer_order):
            if layer in parts:
                return i
        return len(layer_order)  # Unknown = highest layer

    violations = []
    for module_path, module_info in modules.items():
        module_layer = get_layer(module_path)

        for imported_path in module_info.imports:
            imported_layer = get_layer(imported_path)

            # Lower layer importing from higher layer is a violation
            if module_layer < imported_layer:
                violations.append(
                    {
                        "from": module_path,
                        "from_layer": layer_order[module_layer]
                        if module_layer < len(layer_order)
                        else "unknown",
                        "imports": imported_path,
                        "imports_layer": layer_order[imported_layer]
                        if imported_layer < len(layer_order)
                        else "unknown",
                    }
                )

    return violations


def analyze_dependencies(repo_root: pathlib.Path) -> dict:
    """Run complete dependency analysis.

    Returns:
        Dictionary with dependency metrics
    """
    modules = build_dependency_graph(repo_root)

    # Compute metrics
    circular_deps = find_circular_dependencies(modules)
    highly_coupled = find_highly_coupled_modules(modules)
    hub_modules = find_hub_modules(modules)
    layer_violations = compute_layer_violations(modules)

    # Summary statistics
    fan_outs = [m.fan_out for m in modules.values()]
    fan_ins = [m.fan_in for m in modules.values()]

    summary = {
        "total_modules": len(modules),
        "total_dependencies": sum(m.fan_out for m in modules.values()),
        "avg_fan_out": round(sum(fan_outs) / len(fan_outs), 2) if fan_outs else 0,
        "avg_fan_in": round(sum(fan_ins) / len(fan_ins), 2) if fan_ins else 0,
        "max_fan_out": max(fan_outs) if fan_outs else 0,
        "max_fan_in": max(fan_ins) if fan_ins else 0,
        "circular_dependency_count": len(circular_deps),
        "highly_coupled_count": len(highly_coupled),
        "hub_module_count": len(hub_modules),
    }

    # Module details (top by instability)
    module_details = sorted(
        [m.to_dict() for m in modules.values()],
        key=lambda m: (m["instability"], m["fan_out"]),
        reverse=True,
    )[:30]

    return {
        "summary": summary,
        "circular_dependencies": circular_deps[:20],  # Top 20
        "highly_coupled_modules": highly_coupled[:20],
        "hub_modules": hub_modules[:20],
        "layer_violations": layer_violations[:30],
        "top_modules_by_instability": module_details,
    }


if __name__ == "__main__":
    import json

    repo = pathlib.Path(__file__).parent.parent
    result = analyze_dependencies(repo)
    print(json.dumps(result, indent=2))
