# BadCoin HTML Miner

Mine BAD from your browser. Yescrypt only. Pool mining. Single self-contained HTML file. 100% client-side.

## Open it

```
open BAD_Coin_Miner.html
```

That is the whole installation. Double-click the file. Works in any modern browser. For maximum safety: download once, then open from disk.

## Status (v0.1, MVP)

| Piece | Status |
|---|---|
| BadCoin-branded UI | Real |
| Stratum-over-WebSocket client (subscribe, authorize, notify, set_difficulty) | Real |
| Pool URL, wallet, worker form | Real |
| Stats panel (status, difficulty, current job, shares, uptime) | Real |
| Color-coded event log | Real |
| Yescrypt hashing | **Stub** — WASM module is the next build |
| Share submission | **Stub** — depends on hashing |

You can connect to a real pool, get a real job, and watch difficulty updates land in the log. The miner just will not submit shares yet. That changes in the next build when yescrypt-WASM lands.

## Why no solo mode

Two reasons, both load-bearing:

1. **Browser hashrate against full network difficulty is hopeless.** Even with yescrypt-WASM, a browser does ~50–200 H/s per thread. The BadCoin network's full difficulty would mean expected time to find a block solo in a browser is years to never. Pool mining at least produces visible shares (and small but real BAD earnings) within seconds.
2. **Solo adds operational complexity for zero practical benefit.** It needs CORS-enabled `badcoind` RPC (most users will not set this up), block construction in JavaScript (coinbase tx, merkle root, header serialization), and a `submitblock` path. All that work to support a use case where the user will never see a block.

For real solo mining, run the BadCoin Core wallet's Mining tab. Native code, full CPU hashrate, connects directly to your own `badcoind`, no browser constraints. The desktop wallet is the right tool for solo; this browser miner is the right tool for community pool mining.

## Pool mode

Defaults:

- **Pool URL:** `wss://pool.badcoin.dev`
- **Worker name:** `browser-1`
- **Algorithm:** Yescrypt (only one supported in this miner)

You provide:

- **BAD payout address** (a "B..." address from any BadCoin wallet: Core, mobile, or the vanity generator)
- **Worker name** (any short string; becomes `address.worker` in the stratum username)

### If the default URL does not work

`wss://pool.badcoin.dev` is the placeholder for the canonical BadCoin pool's WebSocket endpoint. At the time this miner shipped, that endpoint may or may not be live: most NOMP/yiimp pools serve raw TCP stratum by default and need a separate `websockify` gateway to expose stratum over WebSocket.

If the default URL fails, you have three paths:

1. **Ask the pool operator to add a wss:// gateway** (recommended). See [`WSS_GATEWAY_REQUEST.md`](WSS_GATEWAY_REQUEST.md) for a full, sendable technical request explaining what is needed, why it matters, and how to set it up in 30 minutes.
2. **Stand up your own pool with wss:// support built in.** See [`POOL_SETUP.md`](POOL_SETUP.md) for a complete setup guide.
3. **Try common endpoint variants** in the Pool URL field directly:
   - `wss://pool.badcoin.dev:8443`
   - `wss://pool.badcoin.dev:3334`
   - `wss://pool.badcoin.dev/stratum`

The event log will show exactly what happened on each attempt (DNS, connection, handshake). The most common failure mode is WebSocket close code 1006, which means the pool is not serving wss:// at that URL.

## Performance expectations (once WASM lands)

Yescrypt is a CPU-bound, memory-hard PoW algorithm. It is designed to resist GPUs.

- **Native CPU miner:** few hundred to ~1,000 H/s per core
- **WASM in a browser:** ~50–200 H/s per thread (~3-5x slower than native)
- **Pure JS:** ~5–20 H/s per thread (the slowest baseline)

What this means: at the BadCoin network's current difficulty, a browser tab will find a pool share occasionally, not constantly. Expected earnings are small. **This is a community / learning / onboarding tool, not a profit center.** The point is the experience: "I mined BAD from my browser."

For real mining, run the BadCoin Core wallet's Mining tab or a dedicated CPU miner.

## Security

- **Zero analytics. Zero network calls** other than the stratum WebSocket to the pool you choose.
- **No browser storage.** No `localStorage`, no `sessionStorage`, no cookies. Your wallet address is in memory only; closing the tab clears it.
- **WebSocket only.** The pool sees your IP because you connect to it; it does not see your local network, your other tabs, or anything outside the stratum protocol.
- **No private key required.** Mining only needs a **public** BAD payout address. Never paste a WIF / private key into this page.
- **Verify the build.** Open DevTools → Network. Reload. Confirm only the WebSocket makes connections.

## What's MVP vs follow-up

**Today (v0.1 MVP):**
- UI + branding
- Real stratum-over-WebSocket client
- Pool URL, wallet, worker fields with validation
- Stats panel + color-coded event log
- Honest error handling for unreachable endpoints

**Follow-up (v0.2):**
- **Yescrypt WASM module** — actual hashing
- WebWorker thread pool (one per CPU, configurable)
- Real share submission (`mining.submit`)
- Hashrate gauge with rolling average
- Light/dark theme toggle (matching the vanity generator)

**Future (v0.3+):**
- Persistent saved configurations (with user opt-in, encrypted in IndexedDB)
- Pool failover (try secondary if primary stalls)
- Mobile-responsive layout

## How to host on GitHub

Same pattern as the vanity generator:

1. **GitHub Pages.** Push `BAD_Coin_Miner.html` (renamed to `index.html` at the repo root, or kept as-is and linked directly) to a repo (e.g. `badcoin-project/web-miner`), enable Pages on `main`, share the URL.
2. **Downloadable release.** Attach the single `BAD_Coin_Miner.html` to a GitHub Release. Users download and run offline.

The downloadable path is more security-conscious; the user can verify the file's hash, then run it forever without depending on any remote server.

## Related docs in this folder

- [`WSS_GATEWAY_REQUEST.md`](WSS_GATEWAY_REQUEST.md) — Technical request to the pool operator to add wss:// support. Send this to Joel.
- [`POOL_SETUP.md`](POOL_SETUP.md) — Full guide to standing up a BadCoin pool with wss:// built in, if the canonical pool does not add support.

## Provenance

Built for the BadCoin community by Tom Friend. Companion to the BadCoin Vanity Address Generator (`~/Desktop/Bad_HTML_Vanity/`), the BadCoin Core wallet (`badcoin-project/badcoin`), and the iOS wallet (`badcoin-project/badcoin-mobile-wallet`).

Single-file HTML so you can save it, audit it, and run it forever even if the source repo disappears.
