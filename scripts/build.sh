#!/usr/bin/env bash
# Build the full stack: frontend (Vite) -> public/app, then backend (CMake).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[hyni] building frontend..."
( cd frontend && npm install --no-audit --no-fund && npm run build )

echo "[hyni] building backend..."
cmake -S backend -B backend/build -DCMAKE_BUILD_TYPE=Release
cmake --build backend/build -j"$(nproc)"

echo "[hyni] done. binary: backend/build/hyni_web_server"
