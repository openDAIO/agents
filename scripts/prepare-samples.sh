#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PDF="${ROOT}/contracts/BRAIN.pdf"
OUT="${ROOT}/samples/paper-001.md"
VENV="${ROOT}/.venv-markitdown"

if [ ! -f "$PDF" ]; then
  echo "missing $PDF — make sure contracts submodule is initialized" >&2
  exit 1
fi

if [ -s "$OUT" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "skip: $OUT already exists ($(wc -c < "$OUT" | tr -d ' ') bytes). Set FORCE=1 to regenerate."
  exit 0
fi

git submodule update --init --recursive tools/markitdown >/dev/null

if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet "${ROOT}/tools/markitdown/packages/markitdown[pdf]"

mkdir -p "${ROOT}/samples"
markitdown "$PDF" > "$OUT"

deactivate

bytes=$(wc -c < "$OUT" | tr -d ' ')
echo "wrote $OUT ($bytes bytes)"
