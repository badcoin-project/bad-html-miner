# Bad_HTML_Miner v0.2 — Multi-Turn Build Plan

Going from the stubbed v0.1 miner to a real working browser miner takes more than one session because compiling C to WASM has to happen on Tom's Mac (not in the AI chat), and verifying network compatibility requires a live pool with wss:// support.

This document is the plan. Each turn has explicit entry conditions, work, and exit conditions, so anyone reading it knows where we are.

---

## Turn 1 — Scaffold (DONE, this session)

**Entry condition:** v0.1 miner shipped; stubbed hashing identified as the next blocker.

**Work:**
- Investigate pre-built yescrypt libraries. Conclusion: none are production-ready (`yescrypt-js` is 1-star unmaintained, `defuse/yescrypt` is GSoC 2015 experimental).
- Verify BadCoin's own yescrypt source layout and exact parameters (BSTY variant, N=2048, r=8, p=1).
- Create this scaffold (`build/` folder) with build script, JS wrapper, WebWorker, test page, setup guide.

**Exit condition:** Tom has everything needed to run the Emscripten build locally without further input from this session.

**Artifacts produced:** the `build/` folder contents.

---

## Turn 2 — Emscripten install + first build (Tom does this; no AI needed)

**Entry condition:** Turn 1 complete.

**Work (Tom, on his Mac):**
- Follow `EMSCRIPTEN_SETUP.md`:
  1. Install Emscripten SDK (~500 MB download, one-time).
  2. Activate the SDK in the current shell.
  3. Run `./build-yescrypt-wasm.sh`.
  4. Open `test-yescrypt.html` in a browser and verify the bench runs.

**Expected duration:** 30 to 90 minutes. Most of it is the Emscripten SDK download.

**Likely failure modes** (each one has a fix in EMSCRIPTEN_SETUP.md):
- `emcc: command not found` → SDK not activated; run `source emsdk_env.sh`.
- C compile errors in `yescrypt-opt.c` → likely a `__x86_64__` intrinsic that slipped through; documented fix in setup guide.
- Test page shows H/s = 0 → WASM loaded but hash function didn't export correctly; check export list in build script.

**Exit condition:** `test-yescrypt.html` displays a non-zero hashrate (anything > 5 H/s is fine; the goal is "WASM works," not "WASM is fast").

**Artifacts produced:** `yescrypt.js`, `yescrypt.wasm`, `yescrypt-inline.js` in the build/ folder.

---

## Turn 3 — Wire WASM into the miner (AI session)

**Entry condition:** Turn 2 complete; WASM files exist in `build/`.

**Work (AI):**
- Read `INTEGRATION_NOTES.md` and implement the integration.
- Inline `yescrypt-inline.js` and the WebWorker source into `BAD_Coin_Miner.html` (via the same `build.py` pattern used today, plus a worker-as-blob-URL pattern so single-file distribution holds).
- Implement block header construction from stratum `mining.notify` parameters: combine extranonce, build coinbase tx, compute merkle root, assemble 80-byte header.
- Implement nonce iteration in the worker; on found share, post message to main thread which sends `mining.submit`.
- Implement hashrate display from worker stats messages.
- Update README and BACKLOG.

**Exit condition:** Miner connects to a real wss:// pool, receives a job, hashes it (real H/s shown), submits shares. Whether the pool ACCEPTS the shares depends on the next turn.

**Artifacts produced:** updated `BAD_Coin_Miner.html` with real hashing.

---

## Turn 4 — End-to-end test against a real pool (Tom + AI)

**Entry condition:** Turn 3 complete; a wss:// pool endpoint exists (either Joel added wss:// or Tom set up his own pool per `POOL_SETUP.md`).

**Work:**
- **Tom:** put a small amount of test BAD into a fresh wallet, point the miner at the pool, run it for a few minutes.
- **AI:** watch the event log; diagnose any rejected shares.
- **First success criterion:** pool accepts at least one share.
- **Second success criterion:** the miner accumulates enough shares to trigger a payout, and the payout lands in the test wallet.

**Likely issues:**
- All shares rejected → hash format mismatch; verify byte-order in header construction.
- All shares rejected with specific error → check what the pool says (low difficulty share, duplicate share, etc.) and adjust.
- Hashrate is much lower than expected → check that WebWorkers are actually parallel and not blocked by main thread.

**Exit condition:** test wallet receives a real payout from the pool. **This is when the miner is officially v0.2 done.**

---

## Turn 5+ — Polish toward v0.3

Once the miner actually mines, focus shifts to:
- Threads picker UI (1..navigator.hardwareConcurrency)
- Reconnect with exponential backoff
- Stale-share filtering (drop shares for old jobs)
- Light/dark theme matching the vanity generator
- Hashrate rolling average + small chart

These are independent and can be done in any order.

---

## Parallel tracks (don't have to be sequential)

- **`WSS_GATEWAY_REQUEST.md` to Joel.** Can happen any time. Independent of the Emscripten work.
- **`POOL_SETUP.md` (run your own pool).** Only needed if Joel declines wss://. Can be staged in parallel as insurance.

---

## What I am explicitly not doing in this plan

- **Not writing a yescrypt implementation from scratch.** BadCoin's own source is the canonical hash; we're just compiling it to a different target.
- **Not vendoring an unaudited JS library.** `yescrypt-js` and `defuse/yescrypt` are both off the table; the variant compatibility risk is too high.
- **Not promising browser miner profitability.** ~50-200 H/s per thread will never be competitive with native CPU miners, let alone GPUs (BadCoin uses Yescrypt which is GPU-resistant, but native CPU still beats browser). Community / learning / onboarding tool, not a profit center.
- **Not trying to support the other four BadCoin algos** (Scrypt, Groestl, Skein, SHA-256d). Yescrypt only. Adding more is a separate project.
