// ============================================================================
// yescrypt-wrapper.js
//
// Thin JS wrapper around the Emscripten-compiled yescrypt WASM module.
// Exposes a clean API:
//
//   await initYescrypt(wasmJsUrl)    // load + initialize the module once
//   yescryptHash(uint8Array80)       // synchronous; returns Uint8Array(32)
//   destroy()                        // free WASM-side buffers (optional)
//
// Two ways to use this:
//
// A) Split build (yescrypt.js + yescrypt.wasm):
//      In your HTML / worker:
//        importScripts('yescrypt.js');                    // defines createYescryptModule
//        importScripts('yescrypt-wrapper.js');
//        await initYescrypt();                            // uses yescrypt.wasm at default URL
//
// B) Inline build (yescrypt-inline.js, WASM base64'd in):
//      importScripts('yescrypt-inline.js');               // defines createYescryptModule
//      importScripts('yescrypt-wrapper.js');
//      await initYescrypt();                              // no separate WASM file needed
//
// This file is environment-agnostic: works in main thread, Worker, ServiceWorker.
// It does NOT use ES module syntax, so it can be loaded via importScripts() in
// classic WebWorkers.
// ============================================================================

let _module = null;
let _hashFn = null;
let _inputPtr = null;
let _outputPtr = null;

/**
 * Initialize the yescrypt module. Must be called exactly once before any
 * yescryptHash() calls. Subsequent calls are no-ops.
 *
 * @param {string} [wasmJsUrl] - optional URL to override where yescrypt.wasm is
 *   loaded from. Only relevant for the split-file build. Inline build ignores it.
 * @returns {Promise<void>}
 */
async function initYescrypt(wasmJsUrl) {
  if (_module) return;  // already initialized

  if (typeof createYescryptModule !== 'function') {
    throw new Error(
      'createYescryptModule is not defined. ' +
      'Did you load yescrypt.js (or yescrypt-inline.js) before yescrypt-wrapper.js?'
    );
  }

  const opts = {};
  if (wasmJsUrl) {
    opts.locateFile = (path) => {
      if (path.endsWith('.wasm')) return wasmJsUrl;
      return path;
    };
  }

  _module = await createYescryptModule(opts);

  // Allocate persistent input + output buffers in WASM memory.
  // 80 bytes for the block header, 32 bytes for the hash output.
  _inputPtr  = _module._malloc(80);
  _outputPtr = _module._malloc(32);

  // Bind the hash function. Signature: void yescrypt_hash_sp(const char *in, char *out).
  // Both args are pointers (numbers in JS land).
  _hashFn = _module.cwrap('yescrypt_hash_sp', null, ['number', 'number']);
}

/**
 * Hash an 80-byte block header. BadCoin uses BSTY yescrypt with N=2048, r=8, p=1.
 * The input is used as both password and salt (BSTY pattern).
 *
 * @param {Uint8Array} input80 - exactly 80 bytes
 * @returns {Uint8Array} 32-byte hash (a fresh copy, safe to keep)
 */
function yescryptHash(input80) {
  if (!_module) {
    throw new Error('yescrypt module not initialized. Call initYescrypt() first.');
  }
  if (!(input80 instanceof Uint8Array) || input80.length !== 80) {
    throw new Error('yescryptHash input must be a Uint8Array of exactly 80 bytes.');
  }

  // Copy input into WASM memory
  _module.HEAPU8.set(input80, _inputPtr);

  // Call the hash function (writes 32 bytes to _outputPtr)
  _hashFn(_inputPtr, _outputPtr);

  // Copy output OUT of WASM memory before returning
  // (slice creates a fresh copy detached from the WASM heap)
  return _module.HEAPU8.slice(_outputPtr, _outputPtr + 32);
}

/**
 * Free the WASM-side buffers. Optional; usually you keep the module alive for
 * the lifetime of the worker / page.
 */
function destroy() {
  if (_module && _inputPtr)  { _module._free(_inputPtr);  _inputPtr  = null; }
  if (_module && _outputPtr) { _module._free(_outputPtr); _outputPtr = null; }
  _hashFn = null;
}

/**
 * Quick self-test: hash a fixed input N times and report the rate.
 * Useful for the bench page and for debugging WASM load issues.
 *
 * @param {number} iterations - default 100
 * @returns {{hashes: number, ms: number, rate: number, lastHashHex: string}}
 */
function benchmark(iterations) {
  iterations = iterations || 100;
  const input = new Uint8Array(80);
  // Use a non-zero input so it's not the trivial case
  for (let i = 0; i < 80; i++) input[i] = (i * 7 + 13) & 0xff;

  let lastHash;
  const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  for (let i = 0; i < iterations; i++) {
    // Vary one byte so we exercise different inputs
    input[0] = i & 0xff;
    lastHash = yescryptHash(input);
  }
  const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const ms = end - start;
  const rate = (iterations * 1000) / ms;

  let hex = '';
  for (let i = 0; i < lastHash.length; i++) hex += lastHash[i].toString(16).padStart(2, '0');

  return { hashes: iterations, ms, rate, lastHashHex: hex };
}

// Browser global exposure (no module system; works with importScripts in workers
// and with plain <script> tags in HTML).
if (typeof self !== 'undefined') {
  self.initYescrypt = initYescrypt;
  self.yescryptHash = yescryptHash;
  self.yescryptDestroy = destroy;
  self.yescryptBenchmark = benchmark;
}
