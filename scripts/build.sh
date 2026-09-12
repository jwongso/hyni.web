#!/usr/bin/env bash
# Build the full stack: frontend (Vite) -> public/app, then backend (CMake).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

jobs() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
  elif command -v sysctl >/dev/null 2>&1; then
    sysctl -n hw.ncpu
  elif command -v getconf >/dev/null 2>&1; then
    getconf _NPROCESSORS_ONLN
  else
    echo 2
  fi
}

echo "[hyni] building frontend..."
(
  cd frontend
  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  npm run build
)

echo "[hyni] building backend..."
cmake -S backend -B backend/build -DCMAKE_BUILD_TYPE=Release
cmake --build backend/build --parallel "$(jobs)"

echo "[hyni] done. binary: backend/build/hyni_web_server"
