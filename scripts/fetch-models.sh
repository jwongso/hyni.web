#!/usr/bin/env bash
# Download Whisper model weights into public/wstream/models/ so the wstream
# STT adapter loads them from your own origin instead of huggingface.co.
#
# This is OPTIONAL. The adapter falls back to the HuggingFace CDN if the
# local copy is missing, so existing deployments work unchanged.
#
# Usage:
#   scripts/fetch-models.sh                # downloads base.en (default, 57 MB)
#   scripts/fetch-models.sh tiny.en        # 31 MB — fastest
#   scripts/fetch-models.sh base.en        # 57 MB — recommended balance
#   scripts/fetch-models.sh small.en       # 182 MB — best on noisy mics
#   scripts/fetch-models.sh all            # download all three

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/public/wstream/models"
BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

mkdir -p "$DEST"

fetch_one() {
    local model="$1"
    local fname="ggml-${model}-q5_1.bin"
    local dst="$DEST/$fname"
    if [[ -f "$dst" ]]; then
        local sz; sz=$(du -h "$dst" | cut -f1)
        echo "[fetch-models] $fname already present ($sz)"
        return
    fi
    echo "[fetch-models] downloading $fname ..."
    curl -fL --progress-bar -o "$dst.tmp" "$BASE_URL/$fname"
    mv "$dst.tmp" "$dst"
    local sz; sz=$(du -h "$dst" | cut -f1)
    echo "[fetch-models] $fname OK ($sz)"
}

choice="${1:-base.en}"
case "$choice" in
    tiny.en|base.en|small.en) fetch_one "$choice" ;;
    all)
        fetch_one tiny.en
        fetch_one base.en
        fetch_one small.en
        ;;
    *)
        echo "Unknown model: $choice"
        echo "Try: tiny.en | base.en | small.en | all"
        exit 1
        ;;
esac

echo "[fetch-models] done. Models in: $DEST"
