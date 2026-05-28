#!/usr/bin/env bash
# ============================================================================
# build-yescrypt-wasm.sh
# Compile BadCoin's own yescrypt source to WebAssembly via Emscripten.
# Produces two builds:
#   1. Split:  yescrypt.js + yescrypt.wasm (for development, faster load)
#   2. Inline: yescrypt-inline.js (single file with WASM base64'd; for distribution)
# ============================================================================

set -euo pipefail

# --- Config ---------------------------------------------------------------
# Path to BadCoin's yescrypt source. Edit this if your BadCoin checkout is
# somewhere else.
BADCOIN_SRC="${BADCOIN_SRC:-$HOME/Desktop/BadCoin/badcoin/src/crypto/yescrypt}"

# Output directory (where this script lives)
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Output filenames
OUT_SPLIT_JS="$OUT_DIR/yescrypt.js"
OUT_SPLIT_WASM="$OUT_DIR/yescrypt.wasm"
OUT_INLINE_JS="$OUT_DIR/yescrypt-inline.js"

# --- Sanity checks --------------------------------------------------------
echo "[build] BadCoin source: $BADCOIN_SRC"
echo "[build] Output dir:     $OUT_DIR"
echo ""

if ! command -v emcc >/dev/null 2>&1; then
  echo "ERROR: emcc not found in PATH."
  echo ""
  echo "Did you activate the Emscripten SDK in this shell?"
  echo "  source ~/emsdk/emsdk_env.sh"
  echo ""
  echo "If you haven't installed Emscripten yet, see EMSCRIPTEN_SETUP.md."
  exit 1
fi

echo "[build] emcc: $(emcc --version | head -1)"

REQUIRED_FILES=(
  "$BADCOIN_SRC/sha256_Y.c"
  "$BADCOIN_SRC/sha256_Y.h"
  "$BADCOIN_SRC/sysendian.h"
  "$BADCOIN_SRC/yescrypt.h"
  "$BADCOIN_SRC/yescrypt-best.c"
  "$BADCOIN_SRC/yescrypt-opt.c"
  "$BADCOIN_SRC/yescrypt-platform.c"
  "$BADCOIN_SRC/yescryptcommon.c"
)

for f in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: required source file missing: $f"
    echo ""
    echo "Either the BadCoin source isn't checked out at the expected location,"
    echo "or this build script's BADCOIN_SRC needs updating."
    exit 1
  fi
done

echo "[build] All required source files present."
echo ""

# --- Clean old output -----------------------------------------------------
echo "[build] Cleaning old output..."
rm -f "$OUT_SPLIT_JS" "$OUT_SPLIT_WASM" "$OUT_INLINE_JS"

# --- Shared Emscripten flags ----------------------------------------------
# -O3                              Maximum optimization
# -s WASM=1                        Output WebAssembly (default but explicit)
# -s MODULARIZE=1                  Wrap output in a factory function
# -s EXPORT_NAME='createYescryptModule'  Name of the factory
# -s ENVIRONMENT='web,worker'      Don't pull in Node.js shims (smaller output)
# -s EXPORTED_FUNCTIONS='[...]'    Which C functions to expose
# -s EXPORTED_RUNTIME_METHODS='[...]'  Which runtime helpers to expose
# -s ALLOW_MEMORY_GROWTH=1         Let WASM heap grow if needed
# -s INITIAL_MEMORY=33554432       Start with 32 MB (plenty for yescrypt N=2048,r=8)
# -DNO_RDRAND -DNO_OMP             Disable hardware RNG + OpenMP code paths
# -U__x86_64__                     Defensive: force opt.c over simd.c path
COMMON_FLAGS=(
  -O3
  -s WASM=1
  -s MODULARIZE=1
  -s "EXPORT_NAME=createYescryptModule"
  -s "ENVIRONMENT=web,worker"
  -s "EXPORTED_FUNCTIONS=['_yescrypt_hash_sp','_yescrypt_hash','_malloc','_free']"
  -s "EXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8','HEAP32']"
  -s ALLOW_MEMORY_GROWTH=1
  -s INITIAL_MEMORY=33554432
  -DNO_RDRAND
  -DNO_OMP
  -U__x86_64__
  -I"$BADCOIN_SRC"
)

# Source files to compile (yescrypt-opt.c and yescrypt-platform.c get
# included via #include from yescrypt-best.c → yescrypt-opt.c).
SRC_FILES=(
  "$BADCOIN_SRC/sha256_Y.c"
  "$BADCOIN_SRC/yescrypt-best.c"
  "$BADCOIN_SRC/yescryptcommon.c"
)

# --- Build 1: split output ------------------------------------------------
echo "[build] Building split output (yescrypt.js + yescrypt.wasm)..."
emcc "${COMMON_FLAGS[@]}" "${SRC_FILES[@]}" -o "$OUT_SPLIT_JS"

if [[ ! -f "$OUT_SPLIT_JS" || ! -f "$OUT_SPLIT_WASM" ]]; then
  echo "ERROR: split build did not produce expected files."
  exit 1
fi

echo "[build]   $OUT_SPLIT_JS   ($(wc -c < "$OUT_SPLIT_JS") bytes)"
echo "[build]   $OUT_SPLIT_WASM ($(wc -c < "$OUT_SPLIT_WASM") bytes)"
echo ""

# --- Build 2: single-file (WASM inlined as base64) ------------------------
echo "[build] Building single-file output (yescrypt-inline.js)..."
emcc "${COMMON_FLAGS[@]}" -s SINGLE_FILE=1 "${SRC_FILES[@]}" -o "$OUT_INLINE_JS"

if [[ ! -f "$OUT_INLINE_JS" ]]; then
  echo "ERROR: inline build did not produce expected file."
  exit 1
fi

echo "[build]   $OUT_INLINE_JS ($(wc -c < "$OUT_INLINE_JS") bytes)"
echo ""

# --- Summary --------------------------------------------------------------
echo "[build] DONE."
echo ""
echo "Next: open test-yescrypt.html in a browser to verify the build."
echo "      cd $OUT_DIR"
echo "      python3 -m http.server 8000"
echo "      open http://localhost:8000/test-yescrypt.html"
echo ""
echo "Expected: page displays 'yescrypt-WASM ready. Bench: ~X H/s' with X > 5."
