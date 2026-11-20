#!/usr/bin/env bash
# Make a git worktree, or a fresh clone, runnable in one command, so a session
# never retreats to the shared primary checkout for want of a secret or of
# node_modules. That retreat is how parallel sessions end up editing one tree.
#
#     bash scripts/setup-worktree.sh
#
# In a linked worktree:
#   1. symlink gitignored local files (LINK_FILES) from the primary checkout
#   2. APFS-clone each node_modules (DEP_DIRS) from the primary checkout
# Everywhere:
#   3. run npm ci in each DEP_DIRS folder unless its node_modules matches its
#      package-lock.json (scripts/lockfile-matches-install.mjs)
#   4. install the pre-push hook (.githooks/install.sh)
# Safe to re-run.
#
# numberbroom-mcp keeps local Worker secrets in .dev.vars (wrangler dev reads
# it). CI installs the root package only.
set -euo pipefail

# Gitignored files a session needs, by name only. Symlinked, never copied: one
# copy of each secret on disk, so a rotated key reaches every worktree at once.
# A name missing from the primary checkout is skipped with a note. Override per run:
#     LINK_FILES=".dev.vars" bash scripts/setup-worktree.sh
LINK_FILES="${LINK_FILES:-.dev.vars}"

# Folders with their own package-lock.json that CI installs ("." is the repo root).
DEP_DIRS="${DEP_DIRS:-.}"
NPM_CI_FLAGS="--no-audit --no-fund"
CHECK_FLAGS=""

HERE="$(git rev-parse --show-toplevel)"
MAIN="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
cd "$HERE"

# $1 folder, $2 name inside it; "." is the repo root.
in_dir() { if [ "$1" = . ]; then echo "$2"; else echo "$1/$2"; fi; }

# A link target that is not there: say so, and point at the example if one is tracked.
note_absent() {
  if [ "$HERE" = "$MAIN" ]; then
    echo "  ! $1 is missing"
  else
    echo "  ! $1 not in the primary checkout, skipped"
  fi
  if [ -e "$1.example" ]; then
    echo "    $1.example lists the keys: copy it to $1 in the primary checkout and fill it in"
  fi
}

echo "tree    : $HERE"
echo "primary : $MAIN"

if [ "$HERE" = "$MAIN" ]; then
  echo "  (primary checkout: nothing to link or clone)"
  for f in $LINK_FILES; do
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then note_absent "$f"; fi
  done
else
  # 1. Local secrets and config.
  for f in $LINK_FILES; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      echo "  = $f already present"
    elif [ -e "$MAIN/$f" ]; then
      mkdir -p "$(dirname "$f")"
      ln -s "$MAIN/$f" "$f"
      echo "  + $f linked to the primary checkout's copy"
    else
      note_absent "$f"
    fi
  done

  # 2. node_modules: copy-on-write clone (macOS APFS), near-instant and close
  #    to zero extra disk. Not a symlink: a branch that changes dependencies
  #    must be able to npm ci without touching the primary's install.
  for d in $DEP_DIRS; do
    nm="$(in_dir "$d" node_modules)"
    if [ ! -d "$nm" ] && [ -d "$MAIN/$nm" ]; then
      if cp -c -R "$MAIN/$nm" "$nm" 2>/dev/null; then
        echo "  + $nm cloned from the primary checkout"
      else
        rm -rf "$nm"
        echo "  ! could not clone $nm (not APFS?); installing instead"
      fi
    fi
  done
fi

# 3. A clone is only valid if it holds what THIS tree's lockfile pins. Fix a
#    mismatch rather than warn about it.
for d in $DEP_DIRS; do
  nm="$(in_dir "$d" node_modules)"
  if [ -d "$nm" ] && node scripts/lockfile-matches-install.mjs "$d" $CHECK_FLAGS >/dev/null 2>&1; then
    echo "  = $nm matches $(in_dir "$d" package-lock.json)"
  else
    if [ -d "$nm" ]; then
      node scripts/lockfile-matches-install.mjs "$d" $CHECK_FLAGS 2>&1 | sed 's/^/    /' || true
    fi
    echo "  + npm ci in $d"
    (cd "$d" && npm ci $NPM_CI_FLAGS)
  fi
done

# 4. Pre-push hook, pointed at this tree's own copy.
bash .githooks/install.sh

echo "Ready: git push runs the pre-push checks from this tree."
