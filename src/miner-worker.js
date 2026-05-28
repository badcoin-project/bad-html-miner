// ============================================================================
// miner-worker.js
//
// WebWorker harness for the BadCoin browser miner. Runs in a Worker context,
// loads the yescrypt WASM module via blob URLs passed from the main thread,
// builds 80-byte block headers from stratum mining.notify parameters,
// iterates nonces, hashes via yescrypt, and posts found shares back.
//
// MESSAGES IN  (from main thread):
//   { type: 'init', wasmJsUrl, wrapperUrl, workerIndex }
//   { type: 'bench', iterations }
//   { type: 'mine', job, extranonce1Hex, extranonce2Hex, targetHex,
//                   nonceStart, nonceStep, workerIndex, workerCount }
//   { type: 'stop' }
//
// MESSAGES OUT (to main thread):
//   { type: 'ready', workerIndex }
//   { type: 'bench-result', hashes, ms, rate, lastHashHex }
//   { type: 'stats', workerIndex, hashes, rate, elapsed }    (~1s cadence)
//   { type: 'share', jobId, nonceHex, extranonce2Hex, ntimeHex, hashHex, workerIndex }
//   { type: 'exhausted', jobId, workerIndex }
//   { type: 'stopped', workerIndex }
//   { type: 'error', error, workerIndex }
//
// Byte-order notes (the classic stratum gotchas, applied in buildHeader):
//   - prevhash from stratum is in DISPLAY order; we reverse each 4-byte word
//   - version, ntime, nbits hex strings are BIG-ENDIAN; header stores LE
//   - merkle root from sha256d is used AS-IS (no reversal)
//   - nonce is little-endian in the header
//   - mining.submit sends nonce as big-endian hex (display order)
// ============================================================================

'use strict';

let _wasmLoaded = false;
let _workerIndex = 0;
let _running = false;
let _stats = { hashes: 0, startMs: 0, lastReportMs: 0 };

self.onmessage = async function (e) {
  const msg = e.data || {};
  try {
    switch (msg.type) {
      case 'init':   await handleInit(msg); break;
      case 'bench':  await handleBench(msg); break;
      case 'mine':   await handleMine(msg); break;
      case 'stop':   handleStop(); break;
      default: self.postMessage({ type: 'error', error: 'Unknown message: ' + msg.type, workerIndex: _workerIndex });
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message || String(err), workerIndex: _workerIndex });
  }
};

async function handleInit(msg) {
  _workerIndex = msg.workerIndex || 0;
  importScripts(msg.wasmJsUrl);     // defines createYescryptModule
  importScripts(msg.wrapperUrl);    // defines initYescrypt, yescryptHash
  await self.initYescrypt();
  _wasmLoaded = true;
  self.postMessage({ type: 'ready', workerIndex: _workerIndex });
}

async function handleBench(msg) {
  if (!_wasmLoaded) throw new Error('Worker not initialized.');
  const iterations = msg.iterations || 100;
  const result = self.yescryptBenchmark(iterations);
  self.postMessage({
    type: 'bench-result',
    workerIndex: _workerIndex,
    hashes: result.hashes,
    ms: result.ms,
    rate: result.rate,
    lastHashHex: result.lastHashHex
  });
}

// ============================================================================
// Mining loop
// ============================================================================
async function handleMine(msg) {
  if (!_wasmLoaded) throw new Error('Worker not initialized.');

  const job             = msg.job;
  const extranonce1Hex  = msg.extranonce1Hex;
  const extranonce2Hex  = msg.extranonce2Hex;
  const targetBytes     = hexToBytes(msg.targetHex);   // 32 bytes big-endian
  const nonceStart      = (msg.nonceStart  >>> 0) || 0;
  const workerCount     = (msg.workerCount >>> 0) || 1;

  // Build the static parts of the header (everything except nonce)
  const header = await buildHeader(job, extranonce1Hex, extranonce2Hex);

  _running = true;
  _stats.hashes = 0;
  _stats.startMs = nowMs();
  _stats.lastReportMs = _stats.startMs;

  // Each worker walks its own slice of the nonce space, striding by workerCount
  // so workers cover disjoint nonces and together exhaust the full space.
  let nonce = (nonceStart + _workerIndex) >>> 0;

  const BATCH = 100;  // hashes between setTimeout yields

  function chunk() {
    if (!_running) {
      self.postMessage({ type: 'stopped', workerIndex: _workerIndex });
      return;
    }

    for (let i = 0; i < BATCH; i++) {
      // Patch nonce into header at offset 76 (little-endian)
      header[76] = (nonce >>> 0)  & 0xff;
      header[77] = (nonce >>> 8)  & 0xff;
      header[78] = (nonce >>> 16) & 0xff;
      header[79] = (nonce >>> 24) & 0xff;

      const hash = self.yescryptHash(header);
      _stats.hashes++;

      if (hashLEQTarget(hash, targetBytes)) {
        // Submit nonce in big-endian hex (display order)
        const nonceHex = nonce.toString(16).padStart(8, '0');
        self.postMessage({
          type: 'share',
          workerIndex: _workerIndex,
          jobId: job.jobId,
          nonceHex: nonceHex,
          extranonce2Hex: extranonce2Hex,
          ntimeHex: job.ntimeHex,
          hashHex: bytesToHex(hash)
        });
      }

      // Stride by workerCount so workers don't overlap
      const next = nonce + workerCount;
      if (next > 0xffffffff) {
        self.postMessage({ type: 'exhausted', jobId: job.jobId, workerIndex: _workerIndex });
        _running = false;
        return;
      }
      nonce = next >>> 0;
    }

    // Stats roughly every second
    const now = nowMs();
    if (now - _stats.lastReportMs >= 1000) {
      const elapsed = (now - _stats.startMs) / 1000;
      self.postMessage({
        type: 'stats',
        workerIndex: _workerIndex,
        hashes: _stats.hashes,
        rate: _stats.hashes / Math.max(elapsed, 0.001),
        elapsed: elapsed
      });
      _stats.lastReportMs = now;
    }

    setTimeout(chunk, 0);
  }

  chunk();
}

function handleStop() { _running = false; }

// ============================================================================
// Block header construction
// ============================================================================
async function buildHeader(job, extranonce1Hex, extranonce2Hex) {
  // 1. Coinbase tx: coinb1 + extranonce1 + extranonce2 + coinb2
  const coinbaseHex = (job.coinb1Hex || '') + (extranonce1Hex || '') +
                      (extranonce2Hex || '') + (job.coinb2Hex || '');
  const coinbase = hexToBytes(coinbaseHex);

  // 2. Double-SHA256 of coinbase
  const coinbaseHash = await sha256d(coinbase);

  // 3. Walk the merkle branch
  let currentHash = coinbaseHash;
  const branch = job.merkleBranch || [];
  for (let i = 0; i < branch.length; i++) {
    const branchBytes = hexToBytes(branch[i]);
    const combined = new Uint8Array(64);
    combined.set(currentHash, 0);
    combined.set(branchBytes, 32);
    currentHash = await sha256d(combined);
  }
  const merkleRoot = currentHash;

  // 4. Assemble 80-byte header
  const header = new Uint8Array(80);

  // Version (4 bytes, LE from BE hex)
  const versionBytes = hexToBytes(job.versionHex);
  for (let i = 0; i < 4; i++) header[i] = versionBytes[3 - i];

  // Prevhash (32 bytes; reverse each 4-byte word from display order)
  const prevhashBytes = hexToBytes(job.prevhashHex);
  for (let w = 0; w < 8; w++) {
    for (let b = 0; b < 4; b++) {
      header[4 + w * 4 + b] = prevhashBytes[w * 4 + (3 - b)];
    }
  }

  // Merkle root (32 bytes, as-is)
  for (let i = 0; i < 32; i++) header[36 + i] = merkleRoot[i];

  // ntime (4 bytes, LE from BE hex)
  const ntimeBytes = hexToBytes(job.ntimeHex);
  for (let i = 0; i < 4; i++) header[68 + i] = ntimeBytes[3 - i];

  // nbits (4 bytes, LE from BE hex)
  const nbitsBytes = hexToBytes(job.nbitsHex);
  for (let i = 0; i < 4; i++) header[72 + i] = nbitsBytes[3 - i];

  // nonce zero; overwritten in mining loop
  return header;
}

async function sha256d(bytes) {
  const first  = await crypto.subtle.digest('SHA-256', bytes);
  const second = await crypto.subtle.digest('SHA-256', first);
  return new Uint8Array(second);
}

/**
 * hash <= target, both 32-byte big-endian.
 */
function hashLEQTarget(hash, target) {
  for (let i = 0; i < 32; i++) {
    if (hash[i] < target[i]) return true;
    if (hash[i] > target[i]) return false;
  }
  return true;
}

// ============================================================================
// Utilities
// ============================================================================
function hexToBytes(hex) {
  if (!hex) return new Uint8Array(0);
  if (hex.length & 1) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
