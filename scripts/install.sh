#!/usr/bin/env bash
# Job Scout installer — macOS / Linux. Run from inside the job-scout folder:  bash scripts/install.sh
set -euo pipefail

echo "Installing Job Scout…"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is required and was not found."
  echo "Install Node 24+ from https://nodejs.org (or via a version manager), then re-run this."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 24 ]; then
  echo ""
  echo "Found Node $(node -v), but Job Scout needs Node 24 or newer."
  echo "Please upgrade Node (https://nodejs.org) and re-run this."
  exit 1
fi

# Put a `job-scout` command on your PATH (no publish needed — links this folder).
cd "$(dirname "$0")/.."
echo "Installing dependencies…"
npm install --no-audit --no-fund
if ! npm link >/dev/null 2>&1; then
  echo "Could not link globally without elevated permissions; trying with sudo…"
  sudo npm link
fi

cat <<'DONE'

✅ Job Scout installed.

Next:
  1. Start it:          job-scout serve        (then open http://127.0.0.1:7777)
  2. In the app, open   ℹ️ Setup & Help        to connect your job sources.
  3. (Optional) Daily auto-refresh:            job-scout autostart

Your data stays on your computer (~/.job-scout/job-scout.db). Full guide: GETTING-STARTED.md
DONE
