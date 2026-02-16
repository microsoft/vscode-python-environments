# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""SubagentStop hook - Validates reviewer subagent completed checks.

When the reviewer agent finishes:
- Logs completion for audit trail
- Could be extended to verify review was thorough
"""

import json
import sys


def main() -> int:
    """Main entry point."""
    # Read input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    agent_type = input_data.get("agent_type", "")
    # agent_id available in input_data if needed for logging
    stop_hook_active = input_data.get("stop_hook_active", False)

    # Prevent infinite loops
    if stop_hook_active:
        print(json.dumps({}))
        return 0

    # Log reviewer completions (could be extended to write to audit file)
    if agent_type.lower() == "reviewer":
        # Currently just a passthrough - could add validation
        # For example, check that reviewer output contains expected sections
        pass

    # Allow subagent to complete
    print(json.dumps({}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
