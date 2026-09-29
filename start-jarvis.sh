#!/usr/bin/env bash
# Starts the apifreellm shim (port 1234) and the OpenJarvis API server (port 8000).
# Put your key in jarvis/.env as:  APIFREELLM_API_KEY=your-key
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
[ -f .env ] && set -a && . ./.env && set +a
: "${APIFREELLM_API_KEY:?Add APIFREELLM_API_KEY=... to $(pwd)/.env}"

python3 apifreellm-shim/shim.py --port 1234 &
SHIM_PID=$!
trap 'kill $SHIM_PID 2>/dev/null' EXIT

cd OpenJarvis
# "simple" agent = one upstream call per message (free tier is 50 requests/day)
uv run jarvis serve --host 127.0.0.1 --port 8000 -e lmstudio -m apifreellm -a simple
