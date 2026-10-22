#!/usr/bin/env bash
# qa/run.sh — full quality gate for ReadOn · Compress
#
#   ./qa/run.sh              # engine + browser + validators + benchmark
#   ./qa/run.sh --quick      # engine + one preset only
#
# Requirements: node, python3, qpdf, poppler-utils, Pillow, pypdf,
#               reportlab/python-docx/python-pptx/openpyxl (fixtures), playwright
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
FAILED=0

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; FAILED=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

command -v node >/dev/null || { echo "node is required"; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }
if [ ! -d qa/node_modules/playwright ]; then
  echo "!! installing playwright (dev-only, needed for the browser tests)"
  (cd qa && npm install --no-audit --no-fund playwright@1.47.0 >/dev/null 2>&1 && npx playwright install chromium >/dev/null 2>&1) || fail "playwright install"
fi
if ! command -v qpdf >/dev/null || ! command -v pdftoppm >/dev/null; then
  echo "!! installing qpdf + poppler-utils (needed by the validators)"
  sudo apt-get install -y -qq qpdf poppler-utils >/dev/null 2>&1 || true
fi

step "1/10 · build"
node compress/build.js || fail "build failed"

step "2/10 · fixtures"
if [ ! -d qa/fixtures ] || [ -z "$(ls -A qa/fixtures 2>/dev/null)" ]; then
  python3 qa/make_fixtures.py || fail "fixture generation failed"
else
  echo "fixtures present ($(ls qa/fixtures | wc -l) files)"
fi

step "3/10 · engine tests"
node qa/pdf_engine_test.js || fail "engine tests"

step "4/10 · browser end-to-end"
if [ "${1:-}" = "--quick" ]; then PRESETS="p50"; else PRESETS="lossless p10 p25 p50 p75 p90 extreme"; fi
NODE_PATH="$ROOT/qa/node_modules" node qa/browser_test.js $PRESETS || fail "browser tests"

step "5/10 · interaction & race tests"
NODE_PATH="$ROOT/qa/node_modules" node qa/ui_test.js || fail "UI tests"
NODE_PATH="$ROOT/qa/node_modules" node qa/ux_test.js || fail "UX / friendliness tests"

step "6/10 · device, fallback & offline matrix"
NODE_PATH="$ROOT/qa/node_modules" node qa/compat_test.js || fail "compatibility tests"
NODE_PATH="$ROOT/qa/node_modules" node qa/pwa_test.js || fail "PWA / offline tests"
NODE_PATH="$ROOT/qa/node_modules" node qa/root_test.js || fail "GitHub Pages root layout"

step "7/10 · every tool, end to end"
NODE_PATH="$ROOT/qa/node_modules" node qa/tools_test.js || fail "tool tests"

step "7b/10 · image tools at pixel level"
NODE_PATH="$ROOT/qa/node_modules" node qa/image_test.js || fail "image tool quality tests"

step "8/10 · lossless preset proof"
NODE_PATH="$ROOT/qa/node_modules" node qa/lossless_check.js || fail "lossless preset run"
python3 qa/lossless_verify.py || fail "lossless pixel proof"

step "9/10 · independent validation"
python3 qa/validate.py ${PRESETS} || fail "artifact validation"

if [ "${1:-}" != "--quick" ]; then
  step "extra · benchmark"
  NODE_PATH="$ROOT/qa/node_modules" node qa/bench.js || fail "benchmark"
  step "extra · speed (worker vs main thread)"
  NODE_PATH="$ROOT/qa/node_modules" node qa/perf_test.js || fail "perf test"
fi

printf '\n──────────────────────────────────────────────\n'
if [ "$FAILED" -eq 0 ]; then ok "ALL CHECKS PASSED"; else fail "SOME CHECKS FAILED"; fi
exit "$FAILED"
