# Emscripten setup and first build

How to install Emscripten on macOS, run the yescrypt-WASM build, and verify the result. This is the doc Tom actually follows step by step.

**Estimated time:** 30 to 90 minutes. Most of it is Emscripten's initial SDK download (~500 MB).

**Prerequisites:**
- macOS (Apple Silicon or Intel both work)
- ~2 GB free disk space (Emscripten SDK + caches)
- git, python3, bash (you already have all three on macOS)

---

## Step 1 — Install the Emscripten SDK

Pick a directory to install Emscripten. Convention is `~/emsdk/` but anywhere works.

```bash
cd ~
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
```

This downloads:
- The Emscripten compiler (`emcc`)
- A bundled LLVM toolchain
- Bundled Node.js
- Python helpers

Total ~500 MB.

## Step 2 — Activate the SDK in your shell

Emscripten needs environment variables set. Do this in every new shell where you run the build:

```bash
source ~/emsdk/emsdk_env.sh
```

You can add this to your `~/.zshrc` (or `~/.bash_profile`) if you'll use it often:

```bash
echo 'source ~/emsdk/emsdk_env.sh > /dev/null' >> ~/.zshrc
```

Verify:

```bash
emcc --version
# Should print "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) X.Y.Z"
```

If you see `command not found`, the activate step did not work. Re-run `source ~/emsdk/emsdk_env.sh` in the current shell.

## Step 3 — Verify the BadCoin yescrypt source is in place

The build script reads from `~/Desktop/BadCoin/badcoin/src/crypto/yescrypt/`. Confirm:

```bash
ls ~/Desktop/BadCoin/badcoin/src/crypto/yescrypt/
# Should list: sha256_Y.c, sha256_Y.h, sysendian.h, yescrypt.h,
#              yescrypt-best.c, yescrypt-opt.c, yescrypt-platform.c,
#              yescrypt-simd.c, yescryptcommon.c
```

If the path is different on your machine, edit `BADCOIN_SRC` at the top of `build-yescrypt-wasm.sh`.

## Step 4 — Run the build

```bash
cd ~/Desktop/Bad_HTML_Miner/build
chmod +x build-yescrypt-wasm.sh
./build-yescrypt-wasm.sh
```

The script:
1. Verifies `emcc` is in PATH (fails fast otherwise).
2. Verifies the BadCoin source path exists.
3. Cleans any old build output.
4. Runs `emcc` to compile `sha256_Y.c`, `yescrypt-best.c`, `yescryptcommon.c` (the headers and `-opt.c` / `-platform.c` get included automatically). Produces split output: `yescrypt.js` + `yescrypt.wasm`.
5. Runs `emcc` again with `-s SINGLE_FILE=1` to produce a single-file output: `yescrypt-inline.js` (WASM base64'd into the JS).
6. Reports file sizes.

**Expected output:** two builds, both completing without errors. File sizes roughly:
- `yescrypt.js`: ~20-40 KB (JS shim)
- `yescrypt.wasm`: ~80-150 KB (the actual compiled code)
- `yescrypt-inline.js`: ~120-200 KB (the JS shim + base64 WASM)

## Step 5 — Test the build in a browser

```bash
cd ~/Desktop/Bad_HTML_Miner/build
python3 -m http.server 8000
# In another terminal or just open:
open http://localhost:8000/test-yescrypt.html
```

The test page:
1. Loads the WASM module.
2. Allocates input/output buffers.
3. Hashes a known input 100 times.
4. Reports hashrate.

**Expected result:** the page displays "yescrypt-WASM ready. Bench: ~X H/s" with X > 5. Anything > 5 H/s means the WASM works; the goal is "produces hashes" not "produces hashes fast."

If you want to verify the hash output matches what BadCoin's native code produces, the test page also displays the hex of one hash. Compare it against `badcoind`'s output for the same input:

```bash
# In the BadCoin Core wallet's RPC, you can verify a header hash via:
# badcoin-cli getblockheader <hash> true
# Or via debug commands. (TODO: document specific verification command in Turn 4.)
```

## Common failure modes

### `emcc: command not found`

Cause: the SDK is installed but the env vars are not loaded in this shell.

Fix: `source ~/emsdk/emsdk_env.sh` in the shell where you run the build.

### Build fails with `__x86_64__` intrinsic errors

Cause: `yescrypt-best.c` selects between `yescrypt-simd.c` and `yescrypt-opt.c` based on `#if defined(__x86_64__)`. In WASM compilation, `__x86_64__` is *not* defined, so it should pick `yescrypt-opt.c` automatically. If somehow the SIMD path got included, the SSE/AVX intrinsics will fail.

Fix: add `-U__x86_64__` to the `emcc` flags in the build script. Or directly compile `yescrypt-opt.c` instead of going through `yescrypt-best.c`.

### Build fails with `pthread` or `__rdrand64_step` errors

Cause: yescrypt's reference implementation has some optional code paths for hardware RNG (`RDRAND`) and pthreads that don't exist in WASM.

Fix: add `-DNO_RDRAND -DNO_OMP -DSINGLE_THREADED` to the build flags. (The build script does this preemptively. If the errors still appear, the macro names may differ — read the error message for the actual missing symbol.)

### Build succeeds but `test-yescrypt.html` says "Failed to load WASM"

Cause: browser security: WASM cannot be loaded from a `file://` URL in some browsers.

Fix: serve via `python3 -m http.server 8000` and load via `http://localhost:8000/test-yescrypt.html`, as the test step says.

### Build succeeds, test page loads, but hash output is all zeros

Cause: the hash function is being called but the input/output buffers aren't being written/read correctly through the WASM memory.

Fix: open browser DevTools console, look for JS errors from `yescrypt-wrapper.js`. Most likely cause is `cwrap`/`ccall` argument types are wrong. The wrapper currently uses `cwrap('yescrypt_hash_sp', null, ['number', 'number'])` which means "two pointers in, no return." Verify the C function signature matches.

### Build succeeds, hash works, but hashrate is < 1 H/s

Cause: WASM module is being recompiled on every hash call (you're not reusing the module instance).

Fix: verify `yescrypt-wrapper.js` calls `initYescrypt()` exactly once before any `yescryptHash()` calls. The init step is the slow part (~hundreds of ms); per-hash is fast.

## What to do once the build succeeds

1. Confirm `test-yescrypt.html` displays a non-zero hashrate.
2. Note the hashrate. If it's much lower than ~5 H/s, something is wrong; debug before continuing.
3. **Come back to the AI session and say "WASM build done, hashrate is X H/s, test page works."** That's the entry condition for Turn 3 of `BUILD_PLAN.md`, where the AI wires the WASM into the actual miner.

You do not need to wire anything into `BAD_Coin_Miner.html` yourself. The integration is the next AI turn's job.
