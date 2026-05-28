# INTEGRATION_NOTES.md

How to wire the yescrypt-WASM module into `BAD_Coin_Miner.html` once the build is verified working.

This is the to-do list for **Turn 3 of `BUILD_PLAN.md`** (the AI session that follows Tom's local Emscripten build).

---

## What the integration adds

Currently `BAD_Coin_Miner.html` has the stratum WebSocket client real and hashing stubbed. The integration converts the miner from a "scaffold" to a real working miner by:

1. Loading the yescrypt WASM module on Start.
2. Spawning one WebWorker per CPU thread.
3. On each `mining.notify` from the pool, building the block header template and distributing nonce ranges across the workers.
4. When a worker finds a hash ≤ target, calling `mining.submit` with the share.
5. Reporting real hashrate in the Stats panel (aggregated across workers).

---

## Architecture after integration

```
Main thread (BAD_Coin_Miner.html)
├── Stratum WebSocket client (existing, real)
├── UI (existing)
├── Worker pool manager (NEW)
│   ├── Worker 1 (miner-worker.js + yescrypt-WASM)
│   ├── Worker 2
│   ├── ... up to navigator.hardwareConcurrency
└── Share submitter (NEW)
    └── Calls mining.submit when any worker reports a share
```

---

## Single-file vs split-file decision

The miner's distribution model is single-file HTML. So the WASM should be inlined.

**Recommended approach for integration:**

1. Use the `yescrypt-inline.js` output (WASM base64'd into the JS).
2. Embed `yescrypt-inline.js`, `yescrypt-wrapper.js`, and `miner-worker.js` into `BAD_Coin_Miner.html` as inline `<script>` blocks (plus the worker as a blob URL).
3. Result: still one HTML file, ~400-500 KB total (up from 186 KB).

The build pipeline becomes:

```
template.html ──┐
app.js ─────────┤
coin.b64 ───────┤───►  build.py  ──►  BAD_Coin_Miner.html (single file)
yescrypt-inline.js ──┤
yescrypt-wrapper.js ─┤
miner-worker.js ─────┘
```

`build.py` (the assembler) gets two new substitution points: `{{YESCRYPT_INLINE}}` and `{{MINER_WORKER}}`.

---

## The WebWorker trick for single-file distribution

WebWorkers normally require a separate `.js` file. To keep the whole miner in one HTML file, use the **Blob URL** pattern:

```javascript
// In main thread, with workerSource being a string containing the worker JS:
const blob = new Blob([workerSource], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));
```

For the worker to be able to `importScripts()` the WASM module, EITHER:

**Option A:** the WASM module is also a blob URL. Pass it to the worker via init message.

```javascript
const wasmBlob = new Blob([yescryptInlineSource], { type: 'application/javascript' });
const wasmUrl  = URL.createObjectURL(wasmBlob);
worker.postMessage({ type: 'init', wasmJsUrl: wasmUrl, wrapperUrl: wrapperUrl });
```

**Option B:** the worker source itself contains the WASM module inline (eval / Function constructor). More complex; A is cleaner.

Recommend Option A.

---

## Block header construction (the hard part)

When `mining.notify` arrives from the pool, the parameters are (per stratum protocol):

```
params: [jobId, prevhash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs]
```

To produce the 80-byte block header that gets hashed, the miner has to:

### Step 1: Build the coinbase transaction

```
coinbaseTx = coinb1 (hex) + extranonce1 (hex) + extranonce2 (hex) + coinb2 (hex)
```

- `extranonce1` came from the pool's `mining.subscribe` response.
- `extranonce2` is chosen by the miner. Length is fixed by the pool (also from subscribe response). Typically 4 bytes. The miner can iterate `extranonce2` to get more search space if needed.

Convert the resulting hex string to a `Uint8Array`.

### Step 2: Double-SHA256 the coinbase tx → coinbase hash

```
coinbaseHash = sha256(sha256(coinbaseTx))
```

32 bytes.

### Step 3: Apply the merkle branch to compute the merkle root

```
currentHash = coinbaseHash
for each branchHash in merkleBranch:
  combined = currentHash || hex_to_bytes(branchHash)   // concat 32+32 bytes
  currentHash = sha256(sha256(combined))
merkleRoot = currentHash
```

32 bytes.

### Step 4: Assemble the 80-byte header

| Offset | Length | Field | Source | Byte order |
|---|---|---|---|---|
| 0 | 4 | version | `versionHex` | **little-endian** (reverse hex byte pairs) |
| 4 | 32 | prevhash | `prevhashHex` | **little-endian** word-reversed (see note) |
| 36 | 32 | merkleRoot | computed above | **little-endian** word-reversed |
| 68 | 4 | ntime | `ntimeHex` | **little-endian** |
| 72 | 4 | nbits | `nbitsHex` | **little-endian** |
| 76 | 4 | nonce | (iterated by miner) | **little-endian** |

**The prevhash byte-order gotcha:** `prevhashHex` from the pool is in display order (the order you'd paste into a block explorer). For hashing, it needs to be byte-reversed in 4-byte chunks. So `abcdef01 23456789 ...` becomes `01efcdab 89674523 ...`. This is the cause of most "all shares rejected" bugs in DIY miners.

**The merkle root byte-order gotcha:** the merkle root is computed in natural byte order, but the header expects it in the same word-reversed format as prevhash. Apply the same 4-byte-chunk reversal.

### Step 5: Iterate nonce + hash

For each `nonce` in `[0, 2^32)`:

1. Patch the nonce field (offset 76..79) with little-endian 4-byte encoding.
2. Compute `hash = yescryptHash(header)` (32 bytes).
3. Test if `hash ≤ target`.
4. If yes, submit share.

**Target byte-order gotcha:** `mining.set_difficulty` from the pool gives a single-number difficulty. Convert to a 32-byte target: `target = TARGET_1 / difficulty`, where `TARGET_1` is the maximum target. For yescrypt-based coins, `TARGET_1` is typically `0x00000000ffff0000000000000000000000000000000000000000000000000000` (Bitcoin convention). The target bytes are big-endian for comparison.

To compare `hash ≤ target`, the hash returned by `yescryptHash` should also be treated as big-endian, but yescrypt outputs 32 bytes that may need byte-reversal depending on the implementation. Test this in step 7.

### Step 6: Submit the share

```javascript
send({
  id: nextId(),
  method: 'mining.submit',
  params: [
    fullWorkerName,   // "BAD_address.worker_name", same as in mining.authorize
    job.jobId,
    extranonce2Hex,
    job.ntimeHex,     // pool may accept rolled ntime; safer to send original
    nonceHex          // "01020304" lowercase 8-char hex
  ]
});
```

The pool will respond with `{"id":N, "result":true}` on accept or `{"id":N, "error":[code, message]}` on reject. Wire this into the existing share counter in app.js.

### Step 7: Verify correctness against the network

After integration, the first thing to verify is hash compatibility. The way:

1. Connect to the pool. Get a job.
2. Hash one header. Submit the share.
3. If accepted: hash construction is correct, byte orders are right.
4. If rejected with "stale share": correct except too slow (latency); reduce per-batch hash count and retry.
5. If rejected with "low difficulty share": correct except the target check is off; verify big/little endian in comparison.
6. If rejected with "invalid share": header construction is wrong somewhere; usually prevhash byte-order.

This is exactly why Turn 4 of BUILD_PLAN.md is "end-to-end test against a real pool" — there is no offline way to verify hash correctness for a particular pool without trying it.

---

## SHA-256 in the browser

Step 2 + 3 above both need SHA-256. The browser provides it via `crypto.subtle.digest('SHA-256', data)` which is **async**. Since these are tiny inputs (32-128 bytes) and called only on `mining.notify` (not in the hashing inner loop), the async cost is negligible. Use WebCrypto.

```javascript
async function sha256d(data) {
  const first = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', first));
}
```

Note: SHA-256 here is **standard** SHA-256, NOT the `sha256_Y` variant. The Y variant is only used internally by yescrypt; the merkle / coinbase hashing uses regular SHA-256 like Bitcoin.

---

## Worker pool sizing

```javascript
const NUM_WORKERS = Math.max(1, navigator.hardwareConcurrency || 1);
```

`navigator.hardwareConcurrency` returns logical CPU count (with hyperthreading). For yescrypt, hyperthreaded siblings don't help much because the algorithm saturates the L1/L2 cache. Realistic optimum is usually `physical_cores`, not `logical_cores`. But getting physical core count is hard from JS, so just use `hardwareConcurrency` and accept the diminishing return.

Add a UI control for the user to override (1..N).

---

## Nonce space distribution

The 32-bit nonce space has 2^32 = ~4 billion values. At 200 H/s per thread × 4 threads = 800 H/s, exhausting the full nonce space takes ~62 days per job. Pool jobs change every few seconds. So in practice, you'll never exhaust the nonce space for a single job.

Simple strategy: each worker gets the full nonce space starting from a different offset:

```
Worker 0: [0, 2^32)
Worker 1: [2^32 / N, 2^32)  // start at 1/N
Worker 2: [2*2^32 / N, 2^32)
...
```

When `mining.notify` with `cleanJobs=true` arrives, abort current work and restart with the new job. (Workers should listen for `stop` messages and exit their current loop within ~milliseconds.)

For extra search space, the miner can also iterate `extranonce2` (rebuild merkle root, restart nonce loop). For a browser miner mining at this rate, you'll never need to.

---

## Hashrate aggregation

Each worker reports its own rate via `{ type: 'stats', rate: X }` messages every few hundred ms. The main thread sums them:

```javascript
const totalRate = workers.reduce((sum, w) => sum + (w.lastRate || 0), 0);
$('hashrate').textContent = formatRate(totalRate);
$('hashrate-note').textContent = NUM_WORKERS + ' worker(s) @ yescrypt';
```

Remove the existing "hashing stub" note when the WASM is active.

---

## Share counting + rejection reasons

When a share is submitted via `mining.submit`, the pool responds. Wire this into the existing `state.sharesAccepted` / `state.sharesRejected` counters in app.js. The current dispatcher already handles `result: true → accepted` and `result: false → rejected`. Just need to make sure `mining.submit` responses get routed to that handler with the right `id` tracking.

Add rejection reason text to the log when a share is rejected. Common reasons:
- "Stale share" — job was already replaced before our submission landed
- "Low difficulty share" — hash is valid but below pool's accepted difficulty (usually means our target math is off)
- "Duplicate share" — already submitted this exact share
- "Invalid share" — header construction is wrong somewhere

These reasons help debug Turn 4.

---

## Stop / clean-up behavior

When the user clicks Stop:

1. Send `{ type: 'stop' }` to every worker. Workers exit their hash loop within milliseconds.
2. Wait for `{ type: 'stopped' }` ack from each (or timeout 1 second).
3. Terminate workers (`worker.terminate()`).
4. Revoke blob URLs (`URL.revokeObjectURL(workerUrl)`).
5. Close the stratum WebSocket (already implemented).
6. Reset UI state.

The current `stop()` already does (5) and (6). Need to add (1)–(4) when workers exist.

---

## What this does NOT change

- The stratum WebSocket client is already correct. No changes.
- The UI structure is correct. Just need to remove the "hashing stub" notes and add a threads picker.
- The security model is unchanged: still no network calls except the pool WebSocket, still no browser storage, still no private key required.
- The pool-only design is unchanged.

---

## Estimated integration effort

For the AI in Turn 3:

| Task | Estimate |
|---|---|
| Update `build.py` to inline yescrypt-inline.js, yescrypt-wrapper.js, miner-worker.js | 30 min |
| Add worker pool manager to app.js | 60 min |
| Add block header construction (with full byte-order care) | 90 min |
| Add share submission wiring | 30 min |
| Add hashrate aggregation + remove stub notes | 30 min |
| Add threads picker UI | 30 min |
| Local testing (without real pool) | 30 min |

**Total: ~5 hours.** Doable in one focused session if the WASM build worked cleanly in Turn 2.

For Turn 4 (Tom testing with a real pool): 30 min to a few hours depending on whether share format is right on first try.

---

## Reference: full stratum-v1 protocol

If you need to debug stratum framing or message shapes beyond what's in app.js:

- [Stratum v1 mining protocol — Bitcoin Wiki](https://en.bitcoin.it/wiki/Stratum_mining_protocol)
- [BTCC's stratum v1 spec mirror](https://braiins.com/stratum-v1/docs)

For yescrypt-specific quirks (BSTY variant), the canonical source is BadCoin's own `src/crypto/yescrypt/yescryptcommon.c`, which has the exact parameters the network expects.
