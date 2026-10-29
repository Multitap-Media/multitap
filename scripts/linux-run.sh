#!/usr/bin/env bash
# Runs a root package script in a native Linux copy of this repo, inside WSL.
#
# The node_modules in a Windows checkout belong to Windows (CONTRIBUTING.md,
# "Install on Windows only"), so Linux checks never run from /mnt/c. This copies the
# working tree, including uncommitted and untracked (not ignored) files, into $WORK,
# installs there with the lockfile, and runs `pnpm run <script>`.
#
# Usage (from WSL):  scripts/linux-run.sh <script> [args...]    e.g. contract, ci
# From Windows:      pnpm run contract   (calls this through `wsl -e bash -lc`)
#
# better-sqlite3 needs no build: its package ships prebuilds for linux-x64 (glibc),
# linuxmusl-x64 and the other targets, so `allowBuilds: false` is fine here too.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$HOME/multitap-ci}
script=${1:?usage: linux-run.sh <script> [args...]}
shift

export NVM_DIR=${NVM_DIR:-$HOME/.nvm}
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null
nvm use --silent "$(cat "$here/.nvmrc")" >/dev/null
export PATH=$PATH:$HOME/.local/bin:$HOME/go/bin

# Tracked files plus untracked ones that aren't ignored, as they are on disk now.
# (safe.directory: the Windows checkout is owned by another uid as seen from WSL.)
list=$(mktemp)
trap 'rm -f "$list"' EXIT
git -c safe.directory='*' -C "$here" ls-files -z -co --exclude-standard |
  while IFS= read -r -d '' f; do [ -e "$here/$f" ] && printf '%s\0' "$f"; done >"$list"

mkdir -p "$WORK"
rsync -a --from0 --files-from="$list" "$here/" "$WORK/"
# Drop files that no longer exist in the source (but keep installs and build output).
(cd "$WORK" && find . -type f -not -path './node_modules/*' -not -path '*/node_modules/*' \
  -not -path '*/dist/*' -not -path './.pnpm-store/*' -print0 | sed -z 's|^\./||') |
  sort -z | comm -z -23 - <(sort -z "$list") |
  (cd "$WORK" && xargs -0 -r rm -f --)

cd "$WORK"
echo "linux-run: $(node -v), pnpm $(pnpm -v), in $WORK"
pnpm install --frozen-lockfile --reporter=append-only >/dev/null
exec pnpm run "$script" "$@"
