# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""PostToolUse hook - Runs validation after file edits.

After editFiles tool:
- Runs ESLint on changed TypeScript files
- Reports lint errors back to the model as additional context
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# Tools that modify files and should trigger validation
FILE_EDIT_TOOLS = {"editFiles", "createFile", "create_file", "replace_string_in_file"}

# File patterns to validate
TYPESCRIPT_EXTENSIONS = {".ts", ".tsx"}


def run_eslint(files: list[str], cwd: Path) -> str | None:
    """Run ESLint on specified files and return errors."""
    ts_files = [f for f in files if Path(f).suffix in TYPESCRIPT_EXTENSIONS]
    if not ts_files:
        return None

    try:
        result = subprocess.run(
            ["npx", "eslint", "--format", "compact", *ts_files],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 and result.stdout:
            # Parse compact format and summarize
            lines = result.stdout.strip().split("\n")
            error_count = sum(
                1 for line in lines if "Error" in line or "error" in line.lower()
            )
            warning_count = sum(
                1 for line in lines if "Warning" in line or "warning" in line.lower()
            )

            if error_count > 0 or warning_count > 0:
                summary = []
                if error_count > 0:
                    summary.append(f"{error_count} error(s)")
                if warning_count > 0:
                    summary.append(f"{warning_count} warning(s)")

                # Include first few actual errors
                sample_errors = [
                    line
                    for line in lines[:5]
                    if "Error" in line or "error" in line.lower()
                ]

                return f"ESLint: {', '.join(summary)}. " + " | ".join(sample_errors[:3])
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return None


def extract_files_from_tool_input(tool_name: str, tool_input: dict) -> list[str]:
    """Extract file paths from tool input based on tool type."""
    files = []

    if tool_name in {"editFiles", "edit_files"}:
        # editFiles has a 'files' array
        if isinstance(tool_input, dict):
            files.extend(tool_input.get("files", []))
    elif tool_name in {"createFile", "create_file"}:
        # createFile has 'filePath'
        if isinstance(tool_input, dict) and "filePath" in tool_input:
            files.append(tool_input["filePath"])
    elif tool_name == "replace_string_in_file":
        # replace_string_in_file has 'filePath'
        if isinstance(tool_input, dict) and "filePath" in tool_input:
            files.append(tool_input["filePath"])

    return files


def main() -> int:
    """Main entry point."""
    # Read input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    repo_root = Path(input_data.get("cwd", os.getcwd()))

    # Only process file edit tools
    if tool_name not in FILE_EDIT_TOOLS:
        print(json.dumps({}))
        return 0

    # Extract files that were edited
    files = extract_files_from_tool_input(tool_name, tool_input)
    if not files:
        print(json.dumps({}))
        return 0

    # Run ESLint on TypeScript files
    lint_result = run_eslint(files, repo_root)

    # Build response
    if lint_result:
        response = {
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": lint_result,
            }
        }
    else:
        response = {}

    print(json.dumps(response))
    return 0


if __name__ == "__main__":
    sys.exit(main())
