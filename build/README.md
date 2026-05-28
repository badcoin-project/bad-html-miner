# build/ — Yescrypt-WASM Build Scaffold

Files for compiling BadCoin's own yescrypt source to WebAssembly and integrating it into the browser miner.

## What's in this folder

| File | Purpose |
|---|---|
| `BUILD_PLAN.md` | The multi-turn plan: what happens in each session, what depends on what, what unblocks what. **Read this first.** |
| `EMSCRIPTEN_SETUP.md` | Step-by-step Emscripten install on macOS, plus how to run the build. **Tom: this is the doc you actually follow.** |
| `build-yescrypt-wasm.sh` | The build script. Reads BadCoin's yescrypt source, runs `emcc`, produces `yescrypt.js` + `yescrypt.wasm` (split) and `yescrypt-inline.js` (single file with WASM base64-inlined). |
| `yescrypt-wrapper.js` | Small JS API on top of the raw Emscripten output. Exposes a clean `yescryptHash(uint8Array80) → Uint8Array32` function. |
| `miner-worker.js` | WebWorker harness. Loads the WASM, accepts a job, iterates nonces, hashes, posts found shares back to the main thread. Two modes: `bench` (just hashes a fixed input N times, reports rate) and `mine` (full mining loop — currently sketched, needs the byte-order work documented in INTEGRATION_NOTES.md). |
| `test-yescrypt.html` | Standalone page that loads the WASM, runs a benchmark, displays hashrate. **Use this to verify the build worked.** |
| `INTEGRATION_NOTES.md` | How to wire the WASM module into the real `BAD_Coin_Miner.html`. Covers block header construction (the tricky byte-order parts), share submission, threads, single-file vs split distribution. |

## Quick start (after Emscripten is installed)

```bash
cd ~/Desktop/Bad_HTML_Miner/build
./build-yescrypt-wasm.sh
# Produces: yescrypt.js, yescrypt.wasm, yescrypt-inline.js

# Test it:
python3 -m http.server 8000 &
open http://localhost:8000/test-yescrypt.html
# Should display: "yescrypt-WASM ready. Bench: ~X H/s"
```

Then come back to me in a follow-up session and we wire the WASM into the miner.

## What we're NOT trying to do here

- Replace BadCoin's network implementation. We're using BadCoin's own source unchanged, just compiling it for a different target (WASM instead of native).
- Outrun GPU/CPU miners. A browser at ~50–200 H/s per thread is not competitive. Community / learning / onboarding tool.
- Implement the full miner end-to-end in this scaffold. The WASM module is the hard part; the rest (stratum, share submission, byte-order plumbing) is documented in INTEGRATION_NOTES.md and gets wired in a follow-up session.
