---
name: generate-snapshot
description: Generate a codebase health snapshot for technical debt tracking and planning. Analyzes git history, code complexity, debt markers, and dependencies to identify hotspots and refactoring priorities.
argument-hint: '--output path --pretty'
---

# Generate Codebase Snapshot

This skill generates a comprehensive code health snapshot using the analysis modules in `analysis/`.

## When to Use

- During planning phase to identify work items
- To find refactoring hotspots (high churn + high complexity)
- To track technical debt over time
- Before major releases to assess code health
- To identify knowledge silos (bus factor risks)

## How to Generate

```powershell
cd analysis
python snapshot.py --output ../analysis-snapshot.json
```

Add `--pretty` flag to also print the JSON to stdout.

**Note:** The snapshot is written to the repository root (`analysis-snapshot.json`), not inside the `analysis/` folder. This path is ignored by `.gitignore`.

## Snapshot Structure

The snapshot contains these sections:

### `summary` - High-level metrics dashboard

- `files_with_changes`: Number of files with git changes
- `total_churn`: Total lines added + deleted
- `high_complexity_files`: Count of files with high complexity
- `todo_count`, `fixme_count`: Debt marker counts
- `circular_dependency_count`: Architectural issues
- `single_author_file_ratio`: Bus factor indicator

### `priority_hotspots` - Top 20 refactoring candidates

Files sorted by `priority_score = change_count × max_complexity`

```json
{
    "path": "src/features/terminal/terminalManager.ts",
    "change_count": 45,
    "churn": 1200,
    "max_complexity": 18,
    "priority_score": 810
}
```

High priority_score = frequently changed AND complex = prime refactoring target.

### `git_analysis` - Change patterns

- `hotspots`: Most frequently changed files
- `temporal_coupling`: Files that change together (hidden dependencies)
- `bus_factor`: Knowledge concentration risks

### `complexity` - Code complexity metrics

- `by_language.typescript`: TypeScript file metrics (max_complexity, avg_complexity, function_count)
- `high_complexity_functions`: Functions with cyclomatic complexity > 10

### `debt_indicators` - Technical debt markers

- `debt_markers.by_type`: TODO, FIXME, HACK comments by type
- `large_files`: Files exceeding 500 lines of code
- `long_functions`: Functions exceeding 50 lines

### `dependencies` - Module coupling analysis

- `circular_dependencies`: Cycles in import graph
- `highly_coupled_modules`: Modules with fan-out > 10
- `hub_modules`: Modules with fan-in > 10
- `layer_violations`: Lower layers importing from higher layers

## Interpreting Results

### Priority Hotspots

1. Sort by `priority_score` descending
2. Top items = files that change often AND are complex
3. These are prime candidates for:
    - Breaking into smaller modules
    - Adding tests before changes
    - Simplifying complex functions

### Temporal Coupling

Files with `coupling_ratio > 0.8` changing together indicate:

- Hidden dependencies not visible in imports
- Copy-paste code that should be shared
- Features spread across unrelated files

### Knowledge Silos

Files with `author_count = 1` and `change_count >= 3`:

- Single point of failure for knowledge
- Consider documentation or pair programming
- Higher risk for bugs during that author's absence

### Circular Dependencies

Any cycles in the import graph:

- Indicates tight coupling
- Makes testing difficult
- Consider introducing interfaces or restructuring

## Example Usage in Planning

```
User: What should we work on next?

Agent: Let me generate a snapshot and analyze it...
[generates snapshot]

Based on the snapshot:

Top 3 priority items:
1. **src/features/terminal/terminalManager.ts** (priority: 810)
   - 45 changes, complexity 18
   - High churn indicates active development area
   - Recommend: Split terminal concerns into separate modules

2. **src/managers/common/nativePythonFinder.ts** (priority: 540)
   - 30 changes, complexity 18
   - Multiple FIXME markers found
   - Recommend: Address type guards and cache issues

3. **src/features/interpreterSelection.ts** (priority: 360)
   - 24 changes, complexity 15
   - Temporal coupling with settings files
   - Recommend: Reduce coupling with settings module
```
