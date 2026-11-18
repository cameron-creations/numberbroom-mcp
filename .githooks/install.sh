#!/usr/bin/env bash
# Point git at the tracked hooks. The relative path resolves per worktree,
# so one install covers every worktree of this clone.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/*
echo "Git hooks installed: core.hooksPath=.githooks (pre-push runs the CI checks locally; bypass with git push --no-verify)"
