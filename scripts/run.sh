#!/usr/bin/env bash
# Run the Drogon backend. Reads LLM keys from .env if present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
    # shellcheck disable=SC1091
    set -a; source "$ROOT/.env"; set +a
fi

if [[ ! -x backend/build/hyni_web_server ]]; then
    echo "[hyni] binary not built yet; run scripts/build.sh" >&2
    exit 1
fi

exec backend/build/hyni_web_server
