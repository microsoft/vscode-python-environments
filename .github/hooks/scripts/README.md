# Copilot Agent Hooks Scripts

This directory contains Python scripts used by agent hooks to automate workflow validation.

## Scripts

### session_start.py

Runs at session start to inject project context:

- Current git branch and commit
- Uncommitted changes count
- Open issues (if gh CLI available)
- Snapshot health summary (if available)
- Available skills reminder

### post_tool_use.py

Runs after file edit tools to provide immediate feedback:

- Runs ESLint on changed TypeScript files
- Reports lint errors back to the model

### stop_hook.py

Runs before session ends to enforce workflow:

- Checks for uncommitted TypeScript changes
- Reminds about pre-commit checks
- Blocks completion if staged changes aren't committed

### subagent_stop.py

Runs when subagents complete:

- Currently a passthrough for logging
- Can be extended to validate reviewer output

## Requirements

These scripts use Python 3.10+ with no external dependencies (beyond what's already in the repo).

They expect:

- `git` CLI available
- `gh` CLI available (optional, for issue context)
- `npx` available for running ESLint

## Hook Configuration

See `.github/hooks/maintainer-hooks.json` for the hook configuration that loads these scripts.
