// ============================================================================
// BadCoin HTML Miner — Application code (v0.2)
// Single-file, no external dependencies, runs entirely in your browser.
// Real yescrypt hashing via WASM (compiled from BadCoin's own source).
// WebWorker pool distributes nonce space across CPU threads.
// ============================================================================
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ============================================================================
  // State
  // ============================================================================
  const state = {
    // Stratum / pool state
    socket: null,
    status: 'idle',                        // idle | connecting | connected | authorized | mining | error | disconnected
    msgId: 0,
    subscribeId: null,
    authorizeId: null,
    submitIds: {},                         // id -> { nonceHex, jobId } for routing submit responses
    extranonce1: null,
    extranonce2Size: null,
    extranonce2Counter: 0,
    currentJob: null,
    difficulty: null,
    targetHex: null,                       // 32-byte big-endian hex string derived from difficulty
    sharesAccepted: 0,
    sharesRejected: 0,
    sharesSubmitted: 0,
    startedAt: 0,
    uptimeTimer: null,
    log: [],

    // Worker pool state
    workers: [],                           // array of { worker, ready, rate }
    blobUrls: [],                          // for cleanup on stop
    workersReady: 0,
    pendingJob: null,                      // job waiting to be dispatched once workers ready
  };

  // ============================================================================
  // Constants
  // ============================================================================
  // Bitcoin/Yescrypt difficulty-1 target. Hash <= (TARGET_1 / difficulty) wins a share.
  const TARGET_1_HEX = '00000000ffff0000000000000000000000000000000000000000000000000000';

  // ============================================================================
  // Logging
  // ============================================================================
  function log(kind, text) {
    const t = new Date();
    const time = String(t.getHours()).padStart(2, '0') + ':' +
                 String(t.getMinutes()).padStart(2, '0') + ':' +
                 String(t.getSeconds()).padStart(2, '0');
    state.log.unshift({ time, kind, text });
    if (state.log.length > 200) state.log.length = 200;
    renderLog();
  }

  function renderLog() {
    const el = $('logList');
    if (state.log.length === 0) {
      el.innerHTML = '<div class="log-empty">No events yet. Click Start to begin.</div>';
      return;
    }
    el.innerHTML = state.log.map(e => `
      <div class="log-row">
        <span class="log-time">${e.time}</span>
        <span class="log-kind log-${e.kind}">${e.kind}</span>
        <span class="log-text">${escapeHtml(e.text)}</span>
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  // ============================================================================
  // Stats rendering
  // ============================================================================
  function renderStatus() {
    const el = $('statusPill');
    el.textContent = state.status.toUpperCase();
    el.className = 'status-pill status-' + state.status;
  }

  function renderStats() {
    const totalRate = state.workers.reduce((sum, w) => sum + (w.rate || 0), 0);
    $('hashrate').textContent = formatRate(totalRate);
    if (state.workers.length === 0) {
      $('hashrate-note').textContent = 'idle';
    } else if (state.workersReady < state.workers.length) {
      $('hashrate-note').textContent = `loading WASM (${state.workersReady}/${state.workers.length})`;
    } else if (totalRate === 0) {
      $('hashrate-note').textContent = `${state.workers.length} thread(s), waiting for job`;
    } else {
      $('hashrate-note').textContent = `${state.workers.length} thread(s) @ yescrypt BSTY`;
    }
    $('sharesAccepted').textContent = state.sharesAccepted;
    $('sharesRejected').textContent = state.sharesRejected;
    $('sharesSubmitted').textContent = state.sharesSubmitted;
    $('difficulty').textContent = state.difficulty != null ? formatDifficulty(state.difficulty) : '—';
    $('currentJob').textContent = state.currentJob ? state.currentJob.jobId : '—';
    if (state.startedAt) {
      const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
      $('uptime').textContent = formatUptime(elapsed);
    } else {
      $('uptime').textContent = '—';
    }
  }

  function formatRate(hPerSec) {
    if (hPerSec === 0) return '0 H/s';
    if (hPerSec < 1000) return hPerSec.toFixed(0) + ' H/s';
    if (hPerSec < 1e6) return (hPerSec / 1000).toFixed(2) + ' KH/s';
    return (hPerSec / 1e6).toFixed(2) + ' MH/s';
  }

  function formatDifficulty(d) {
    if (d < 0.01) return d.toExponential(2);
    if (d < 1000) return d.toFixed(4);
    return d.toFixed(0);
  }

  function formatUptime(sec) {
    if (sec < 60) return sec + ' sec';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h + 'h ' + m + 'm';
  }

  // ============================================================================
  // Worker pool — Blob URL plumbing for single-file distribution
  // ============================================================================
  function getEmbeddedSource(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error('Missing embedded source: ' + id);
    // textContent of a <script type="text/plain"> preserves the source verbatim
    return el.textContent;
  }

  function createBlobUrl(source, mime) {
    const blob = new Blob([source], { type: mime || 'application/javascript' });
    const url = URL.createObjectURL(blob);
    state.blobUrls.push(url);
    return url;
  }

  function spawnWorkerPool(threadCount) {
    const yescryptSrc = getEmbeddedSource('src-yescrypt-inline');
    const wrapperSrc  = getEmbeddedSource('src-yescrypt-wrapper');
    const workerSrc   = getEmbeddedSource('src-miner-worker');

    const wasmJsUrl  = createBlobUrl(yescryptSrc);
    const wrapperUrl = createBlobUrl(wrapperSrc);
    const workerUrl  = createBlobUrl(workerSrc);

    for (let i = 0; i < threadCount; i++) {
      const w = new Worker(workerUrl);
      const entry = { worker: w, index: i, ready: false, rate: 0, hashes: 0 };
      state.workers.push(entry);

      w.addEventListener('message', (ev) => onWorkerMessage(entry, ev.data));
      w.addEventListener('error', (ev) => {
        log('error', `Worker ${i} error: ${ev.message || 'unknown'}`);
      });

      w.postMessage({
        type: 'init',
        workerIndex: i,
        wasmJsUrl: wasmJsUrl,
        wrapperUrl: wrapperUrl
      });
    }
    log('info', `Spawned ${threadCount} worker(s). Loading WASM ...`);
  }

  function onWorkerMessage(entry, msg) {
    switch (msg.type) {
      case 'ready':
        entry.ready = true;
        state.workersReady++;
        if (state.workersReady === state.workers.length) {
          log('ok', `All ${state.workers.length} workers ready.`);
          if (state.pendingJob) {
            dispatchJob(state.pendingJob);
            state.pendingJob = null;
          }
        }
        renderStats();
        break;

      case 'stats':
        entry.rate = msg.rate;
        entry.hashes = msg.hashes;
        renderStats();
        break;

      case 'share':
        submitShare(msg);
        break;

      case 'exhausted':
        log('warn', `Worker ${msg.workerIndex} exhausted nonce space for job ${msg.jobId}.`);
        break;

      case 'stopped':
        // Worker acknowledged stop
        break;

      case 'error':
        log('error', `Worker ${msg.workerIndex}: ${msg.error}`);
        break;
    }
  }

  function shutdownWorkers() {
    for (const w of state.workers) {
      try { w.worker.postMessage({ type: 'stop' }); } catch (e) {}
      try { w.worker.terminate(); } catch (e) {}
    }
    state.workers = [];
    state.workersReady = 0;
    for (const url of state.blobUrls) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    state.blobUrls = [];
  }

  // ============================================================================
  // Target derivation
  // ============================================================================
  // Convert a pool difficulty to a 32-byte big-endian target hex string.
  // target = floor(TARGET_1 / difficulty)
  function difficultyToTargetHex(difficulty) {
    if (!difficulty || difficulty <= 0) return TARGET_1_HEX;
    const target1 = BigInt('0x' + TARGET_1_HEX);
    // Scale difficulty into integer math (4 decimal places of resolution)
    const scale = 10000n;
    const diffScaled = BigInt(Math.round(difficulty * 10000));
    const target = (target1 * scale) / diffScaled;
    return target.toString(16).padStart(64, '0');
  }

  // ============================================================================
  // Job dispatch
  // ============================================================================
  function nextExtranonce2Hex() {
    const size = state.extranonce2Size || 4;
    const counter = state.extranonce2Counter++;
    // Hex string, exactly size*2 chars, little-endian counter
    let hex = '';
    for (let i = 0; i < size; i++) {
      hex += ((counter >> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return hex;
  }

  function dispatchJob(job) {
    if (!state.extranonce1) {
      log('warn', 'Cannot dispatch job: missing extranonce1.');
      return;
    }
    if (state.workersReady === 0 || state.workersReady < state.workers.length) {
      state.pendingJob = job;
      return;
    }
    if (state.targetHex == null) {
      // No difficulty yet — pool should send mining.set_difficulty before notify, but be defensive
      state.targetHex = TARGET_1_HEX;
      log('warn', 'No difficulty yet; using difficulty-1 target until pool sends one.');
    }

    const extranonce2Hex = nextExtranonce2Hex();
    log('info', `Dispatching job ${job.jobId} to ${state.workers.length} worker(s) (extranonce2=${extranonce2Hex}).`);

    for (let i = 0; i < state.workers.length; i++) {
      const w = state.workers[i];
      // Reset that worker's reported rate
      w.rate = 0; w.hashes = 0;
      w.worker.postMessage({
        type: 'mine',
        job: {
          jobId:        job.jobId,
          prevhashHex:  job.prevhash,
          coinb1Hex:    job.coinb1,
          coinb2Hex:    job.coinb2,
          merkleBranch: job.merkleBranch,
          versionHex:   job.version,
          nbitsHex:     job.nbits,
          ntimeHex:     job.ntime
        },
        extranonce1Hex: state.extranonce1,
        extranonce2Hex: extranonce2Hex,
        targetHex:      state.targetHex,
        nonceStart:     0,
        workerIndex:    i,
        workerCount:    state.workers.length
      });
    }
    renderStats();
  }

  function abortCurrentJob() {
    for (const w of state.workers) {
      try { w.worker.postMessage({ type: 'stop' }); } catch (e) {}
    }
  }

  // ============================================================================
  // Share submission
  // ============================================================================
  function submitShare(shareMsg) {
    const workerName = ($('workerName').value.trim() || 'browser-1');
    const address = $('walletAddress').value.trim();
    const fullName = address + '.' + workerName;

    const id = nextId();
    state.submitIds[id] = { nonceHex: shareMsg.nonceHex, jobId: shareMsg.jobId, hashHex: shareMsg.hashHex };
    state.sharesSubmitted++;
    log('ok', `Found share! nonce=${shareMsg.nonceHex} hash=${shareMsg.hashHex.substring(0, 16)}... Submitting ...`);

    send({
      id: id,
      method: 'mining.submit',
      params: [
        fullName,
        shareMsg.jobId,
        shareMsg.extranonce2Hex,
        shareMsg.ntimeHex,
        shareMsg.nonceHex
      ]
    });
    renderStats();
  }

  // ============================================================================
  // Stratum WebSocket client
  // ============================================================================
  function connectPool() {
    if (state.socket) {
      log('warn', 'Already connected (or connecting). Stop first.');
      return;
    }

    const url = $('poolUrl').value.trim();
    const address = $('walletAddress').value.trim();
    const worker = $('workerName').value.trim() || 'browser-1';
    const threads = Math.max(1, Math.min(32, parseInt($('threadsInput').value, 10) || 4));

    if (!url) { log('error', 'Pool URL is required.'); return; }
    if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
      log('error', 'Pool URL must start with wss:// (or ws:// for localhost).');
      return;
    }
    if (!address) { log('error', 'Wallet address is required (BAD payout address).'); return; }

    state.startedAt = Date.now();
    state.uptimeTimer = setInterval(renderStats, 1000);
    state.status = 'connecting';
    renderStatus();
    log('info', 'Connecting to ' + url + ' ...');

    // Spawn worker pool in parallel with the WebSocket connect
    try {
      spawnWorkerPool(threads);
    } catch (e) {
      log('error', 'Failed to spawn workers: ' + e.message);
      cleanup();
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      log('error', 'WebSocket construction failed: ' + e.message);
      stop();
      return;
    }
    state.socket = socket;

    socket.addEventListener('open', () => {
      log('ok', 'WebSocket open. Sending mining.subscribe ...');
      state.status = 'connected';
      renderStatus();
      const subId = nextId();
      state.subscribeId = subId;
      send({ id: subId, method: 'mining.subscribe', params: ['BadCoinBrowserMiner/0.2', null] });
    });

    socket.addEventListener('message', (ev) => {
      handleMessage(ev.data, address, worker);
    });

    socket.addEventListener('close', (ev) => {
      log('warn', 'WebSocket closed (code=' + ev.code + ', reason=' + (ev.reason || 'none') + ').');
      cleanup();
    });

    socket.addEventListener('error', () => {
      log('error', 'WebSocket error. Common causes: pool does not serve wss://, wrong URL/port, browser blocked mixed-content (page over https but pool over ws://).');
      state.status = 'error';
      renderStatus();
    });

    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    $('poolUrl').disabled = true;
    $('walletAddress').disabled = true;
    $('workerName').disabled = true;
    $('threadsInput').disabled = true;
  }

  function send(obj) {
    const line = JSON.stringify(obj);
    if (state.socket && state.socket.readyState === 1) {
      state.socket.send(line + '\n');
      log('tx', line.length > 200 ? line.substring(0, 200) + '...' : line);
    } else {
      log('error', 'Cannot send: socket not open. (state=' + (state.socket ? state.socket.readyState : 'null') + ')');
    }
  }

  function nextId() { return ++state.msgId; }

  function handleMessage(data, address, worker) {
    const lines = String(data).split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        log('error', 'Non-JSON line from pool: ' + line.substring(0, 200));
        continue;
      }
      log('rx', line.length > 200 ? line.substring(0, 200) + '...' : line);
      dispatchMessage(msg, address, worker);
    }
  }

  function dispatchMessage(msg, address, worker) {
    // Response to a request we sent
    if (msg.id !== null && msg.id !== undefined) {
      if (msg.id === state.subscribeId) {
        if (msg.error) {
          log('error', 'mining.subscribe rejected: ' + JSON.stringify(msg.error));
          return;
        }
        const r = msg.result;
        if (Array.isArray(r) && r.length >= 3) {
          state.extranonce1 = r[1];
          state.extranonce2Size = r[2];
          log('ok', 'Subscribed. extranonce1=' + state.extranonce1 + ' extranonce2_size=' + state.extranonce2Size);
        }
        const authId = nextId();
        state.authorizeId = authId;
        const username = address + '.' + worker;
        log('info', 'Authorizing as ' + username + ' ...');
        send({ id: authId, method: 'mining.authorize', params: [username, 'x'] });
        return;
      }
      if (msg.id === state.authorizeId) {
        if (msg.result === true) {
          state.status = 'authorized';
          renderStatus();
          log('ok', 'Authorized. Waiting for first job ...');
        } else {
          log('error', 'mining.authorize rejected: ' + JSON.stringify(msg.error || msg.result));
        }
        return;
      }
      // mining.submit response
      if (state.submitIds[msg.id]) {
        const sub = state.submitIds[msg.id];
        delete state.submitIds[msg.id];
        if (msg.result === true) {
          state.sharesAccepted++;
          log('ok', `Share accepted (nonce ${sub.nonceHex}).`);
          animRecordBlock(sub.hashHex || sub.nonceHex);
        } else {
          state.sharesRejected++;
          const errStr = msg.error ? JSON.stringify(msg.error) : 'no detail';
          log('warn', `Share rejected (nonce ${sub.nonceHex}): ${errStr}`);
        }
        renderStats();
        return;
      }
      // Other responses
      if (msg.result === true) {
        log('ok', 'Pool response: ok.');
      } else if (msg.result === false || msg.error) {
        log('warn', 'Pool response: ' + JSON.stringify(msg.error || msg.result));
      }
      return;
    }

    // Notifications
    if (msg.method === 'mining.set_difficulty') {
      state.difficulty = (msg.params && msg.params[0]) || 0;
      state.targetHex = difficultyToTargetHex(state.difficulty);
      log('info', `Difficulty set to ${state.difficulty} (target ${state.targetHex.substring(0, 16)}...)`);
      renderStats();
      return;
    }
    if (msg.method === 'mining.notify') {
      const p = msg.params || [];
      const newJob = {
        jobId:        p[0],
        prevhash:     p[1],
        coinb1:       p[2],
        coinb2:       p[3],
        merkleBranch: p[4],
        version:      p[5],
        nbits:        p[6],
        ntime:        p[7],
        cleanJobs:    p[8]
      };
      const cleanJobs = !!p[8];
      state.currentJob = newJob;
      state.status = 'mining';
      renderStatus();
      log('info', 'New job: ' + p[0] + (cleanJobs ? ' (clean - abort previous)' : ''));

      // If cleanJobs, abort current work first. Either way, dispatch the new job.
      if (cleanJobs) abortCurrentJob();
      dispatchJob(newJob);
      renderStats();
      return;
    }
    if (msg.method === 'mining.set_extranonce') {
      const p = msg.params || [];
      state.extranonce1 = p[0];
      state.extranonce2Size = p[1];
      log('info', 'extranonce updated: ' + p[0] + ' size=' + p[1]);
      return;
    }
    if (msg.method === 'client.show_message') {
      log('info', 'Pool says: ' + (msg.params && msg.params[0]));
      return;
    }
    if (msg.method === 'mining.ping') {
      send({ id: msg.id, result: true });
      return;
    }
    log('warn', 'Unhandled message: ' + (msg.method || JSON.stringify(msg)).substring(0, 100));
  }

  function cleanup() {
    state.socket = null;
    state.status = 'disconnected';
    renderStatus();
    animSetState('idle');
    shutdownWorkers();
    state.pendingJob = null;
    state.submitIds = {};
    $('btnStart').disabled = false;
    $('btnStop').disabled = true;
    $('poolUrl').disabled = false;
    $('walletAddress').disabled = false;
    $('workerName').disabled = false;
    $('threadsInput').disabled = false;
    if (state.uptimeTimer) { clearInterval(state.uptimeTimer); state.uptimeTimer = null; }
    renderStats();
  }

  function stop() {
    if (state.socket) {
      try { state.socket.close(); } catch (e) {}
    }
    cleanup();
    log('info', 'Stopped.');
  }

  // ============================================================================
  // Joel's pixel-art mining animation
  //
  // The animation auto-binds to <canvas id="badcoin-miner-canvas"> on DOM
  // ready. We just nudge it into the right mode on start / stop and trigger
  // the coin-shower celebration when the pool accepts a share.
  // ============================================================================
  function animSetState(mode) {
    if (window.BadcoinMiner && typeof window.BadcoinMiner.setState === 'function') {
      window.BadcoinMiner.setState(mode);
    }
  }
  function animRecordBlock(hashHex) {
    if (window.BadcoinMiner && typeof window.BadcoinMiner.recordBlock === 'function') {
      window.BadcoinMiner.recordBlock(hashHex || null);
    }
  }

  // ============================================================================
  // Start dispatch
  // ============================================================================
  function start() {
    connectPool();
    animSetState('mining');
  }

  // ============================================================================
  // In-browser BadCoin keypair generation
  //
  // Produces a fresh P2SH-wrapped P2WPKH address ("B..." prefix) and matching
  // WIF private key ("C..." prefix). All computation is local; nothing leaves
  // the browser. The generated keypair is held in memory only, never
  // persisted anywhere. Refresh the page and it is gone forever.
  //
  // Crypto stack:
  //   - secp256k1: elliptic.min.js (loaded above)
  //   - SHA-256:   js-sha256       (loaded above)
  //   - RIPEMD-160: implemented inline below
  //   - Base58Check: implemented inline below
  // ============================================================================

  // RIPEMD-160 (RFC, reference implementation). Input + output are Uint8Array.
  const RIPEMD160 = (function () {
    const r1 = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
    const r2 = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
    const s1 = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
    const s2 = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
    function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
    function f(j, x, y, z) {
      if (j < 16) return (x ^ y ^ z) >>> 0;
      if (j < 32) return ((x & y) | ((~x) & z)) >>> 0;
      if (j < 48) return ((x | (~y)) ^ z) >>> 0;
      if (j < 64) return ((x & z) | (y & (~z))) >>> 0;
      return (x ^ (y | (~z))) >>> 0;
    }
    function K(j) {
      if (j < 16) return 0x00000000;
      if (j < 32) return 0x5a827999;
      if (j < 48) return 0x6ed9eba1;
      if (j < 64) return 0x8f1bbcdc;
      return 0xa953fd4e;
    }
    function Kp(j) {
      if (j < 16) return 0x50a28be6;
      if (j < 32) return 0x5c4dd124;
      if (j < 48) return 0x6d703ef3;
      if (j < 64) return 0x7a6d76e9;
      return 0x00000000;
    }
    return function (input) {
      const msgLen = input.length;
      const bitLen = msgLen * 8;
      const paddedLen = (((msgLen + 8) >>> 6) + 1) << 6;
      const padded = new Uint8Array(paddedLen);
      padded.set(input);
      padded[msgLen] = 0x80;
      const view = new DataView(padded.buffer);
      view.setUint32(paddedLen - 8, bitLen >>> 0, true);
      view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);
      let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
      for (let block = 0; block < paddedLen; block += 64) {
        const X = new Uint32Array(16);
        for (let i = 0; i < 16; i++) X[i] = view.getUint32(block + i * 4, true);
        let A = h0, B = h1, C = h2, D = h3, E = h4;
        let Ap = h0, Bp = h1, Cp = h2, Dp = h3, Ep = h4;
        for (let j = 0; j < 80; j++) {
          let T = ((A + f(j, B, C, D)) >>> 0) + X[r1[j]] + K(j);
          T = (rotl(T >>> 0, s1[j]) + E) >>> 0;
          A = E; E = D; D = rotl(C, 10); C = B; B = T;
          T = ((Ap + f(79 - j, Bp, Cp, Dp)) >>> 0) + X[r2[j]] + Kp(j);
          T = (rotl(T >>> 0, s2[j]) + Ep) >>> 0;
          Ap = Ep; Ep = Dp; Dp = rotl(Cp, 10); Cp = Bp; Bp = T;
        }
        const T = ((h1 + C) >>> 0) + Dp;
        h1 = (((h2 + D) >>> 0) + Ep) >>> 0;
        h2 = (((h3 + E) >>> 0) + Ap) >>> 0;
        h3 = (((h4 + A) >>> 0) + Bp) >>> 0;
        h4 = (((h0 + B) >>> 0) + Cp) >>> 0;
        h0 = T >>> 0;
      }
      const output = new Uint8Array(20);
      const outView = new DataView(output.buffer);
      outView.setUint32(0, h0, true);
      outView.setUint32(4, h1, true);
      outView.setUint32(8, h2, true);
      outView.setUint32(12, h3, true);
      outView.setUint32(16, h4, true);
      return output;
    };
  })();

  // Base58 + Base58Check
  const BASE58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58encode(bytes) {
    let n = 0n;
    for (let i = 0; i < bytes.length; i++) n = n * 256n + BigInt(bytes[i]);
    let result = '';
    while (n > 0n) {
      result = BASE58_ALPHA[Number(n % 58n)] + result;
      n = n / 58n;
    }
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0) break;
      result = '1' + result;
    }
    return result;
  }
  function sha256Bytes(bytes) {
    // js-sha256 exposes sha256.array() returning a plain array of bytes.
    return new Uint8Array(sha256.array(bytes));
  }
  function base58check(bytes) {
    const sha1 = sha256Bytes(bytes);
    const sha2 = sha256Bytes(sha1);
    const out = new Uint8Array(bytes.length + 4);
    out.set(bytes);
    out.set(sha2.subarray(0, 4), bytes.length);
    return base58encode(out);
  }
  function bytesToHexStr(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  // BadCoin version bytes
  const BADCOIN_SCRIPT_ADDRESS = 0x19; // 25 — produces "B..." P2SH addresses
  const BADCOIN_WIF_VERSION    = 0x50; // 80 — produces "C..." WIFs

  // In-memory store for the last keypair generated this session.
  // Never persisted. Refresh = gone.
  const wallet = { addr: null, wif: null, pubHex: null };

  function generateKeypair() {
    // 32-byte CSPRNG private key, reject the (impossibly unlikely) all-zero case
    let priv;
    while (true) {
      priv = new Uint8Array(32);
      crypto.getRandomValues(priv);
      let nonzero = false;
      for (let i = 0; i < 32; i++) if (priv[i] !== 0) { nonzero = true; break; }
      if (nonzero) break;
    }
    const ec = new elliptic.ec('secp256k1');
    const pair = ec.keyFromPrivate(priv);
    const pubKey = new Uint8Array(pair.getPublic(true, 'array')); // 33 bytes compressed
    const pubH160 = RIPEMD160(sha256Bytes(pubKey));
    // P2WPKH redeem script: OP_0 OP_PUSHBYTES_20 <hash160(pubkey)>
    const redeem = new Uint8Array(22);
    redeem[0] = 0x00;
    redeem[1] = 0x14;
    redeem.set(pubH160, 2);
    const redeemH160 = RIPEMD160(sha256Bytes(redeem));
    const versioned = new Uint8Array(21);
    versioned[0] = BADCOIN_SCRIPT_ADDRESS;
    versioned.set(redeemH160, 1);
    const address = base58check(versioned);
    // WIF = version + priv + 0x01 (compressed flag) + checksum
    const wifBuf = new Uint8Array(34);
    wifBuf[0] = BADCOIN_WIF_VERSION;
    wifBuf.set(priv, 1);
    wifBuf[33] = 0x01;
    const wif = base58check(wifBuf);
    return { address, wif, pubHex: bytesToHexStr(pubKey) };
  }

  function showWallet(kp) {
    wallet.addr = kp.address;
    wallet.wif = kp.wif;
    wallet.pubHex = kp.pubHex;
    $('walletAddrOut').textContent = kp.address;
    $('walletWifOut').textContent  = kp.wif;
    $('walletPubOut').textContent  = kp.pubHex;
    $('walletKeys').classList.remove('hidden');
    // Auto-fill the payout address field so the user can start mining immediately
    $('walletAddress').value = kp.address;
    // Update the deep-link button to target this address on the explorer
    const link = $('explorerLinkAddr');
    if (link) link.href = 'https://explorer.badcoin.dev/address/' + encodeURIComponent(kp.address);
    log('info', 'Generated a fresh BadCoin keypair. Save the private key now — we do not store it.');
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for older / restricted contexts
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (err) { reject(err); }
    });
  }

  function flashCopied(button) {
    const prev = button.textContent;
    button.textContent = 'Copied';
    button.disabled = true;
    setTimeout(() => { button.textContent = prev; button.disabled = false; }, 1200);
  }

  function qrDataUrl(text, cellSize, margin) {
    // qrcode-generator: auto type number (0), 'M' error correction
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(cellSize || 4, margin == null ? 4 : margin);
  }

  function downloadWalletPdf() {
    if (!wallet.addr) return;
    if (!window.jspdf || !window.jspdf.jsPDF) {
      log('error', 'PDF library not loaded. Cannot create paper wallet.');
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    // Title
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text('BadCoin Paper Wallet', 105, 22, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text('Generated by the BadCoin HTML Miner', 105, 30, { align: 'center' });
    doc.setTextColor(0);

    // Address section
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Public Address (share freely)', 20, 50);
    doc.setFont('courier', 'normal');
    doc.setFontSize(11);
    doc.text(wallet.addr, 20, 60);
    try {
      const addrQR = qrDataUrl(wallet.addr, 4, 4);
      doc.addImage(addrQR, 'GIF', 140, 45, 50, 50);
    } catch (e) { /* QR optional */ }

    // Private key section
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(178, 34, 34);
    doc.text('Private Key (WIF). KEEP SECRET.', 20, 110);
    doc.setFont('courier', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.text(wallet.wif, 20, 120);
    try {
      const wifQR = qrDataUrl(wallet.wif, 4, 4);
      doc.addImage(wifQR, 'GIF', 140, 105, 50, 50);
    } catch (e) { /* QR optional */ }

    // Public key
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Public Key (compressed hex)', 20, 165);
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    const pub1 = wallet.pubHex.substring(0, 33);
    const pub2 = wallet.pubHex.substring(33);
    doc.text(pub1, 20, 172);
    doc.text(pub2, 20, 177);

    // Load onto iPhone wallet
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Load this wallet onto your BadCoin iPhone wallet', 20, 190);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    let y = 197;
    const iphoneSteps = [
      '1. Open the BadCoin iPhone wallet on your phone.',
      '2. Choose Import wallet, then Scan QR code.',
      '3. Point the phone camera at the Private Key QR code above.',
      '4. The wallet imports this address. Mining payouts to this address now',
      '   show up in your phone wallet.'
    ];
    iphoneSteps.forEach(line => { doc.text(line, 20, y); y += 5; });

    // Check your balance
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Check your balance from any browser', 20, 232);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Open https://explorer.badcoin.dev/ and paste the address above into', 20, 239);
    doc.text('the search box. The explorer shows your current balance and full', 20, 244);
    doc.text('transaction history.', 20, 249);

    // Warnings
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(178, 34, 34);
    doc.text('Keep this safe', 20, 261);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(0);
    const warnings = [
      'Anyone with the private key can spend the coins. Treat this file like cash.',
      'Store at least two copies (printed, USB drive, encrypted archive).',
      'If you lose every copy of the private key, the BAD at this address is gone forever. No one can recover it.',
      'This file was generated entirely inside your browser. No keys were transmitted anywhere.'
    ];
    y = 267;
    warnings.forEach(line => {
      const wrapped = doc.splitTextToSize(line, 165);
      // First line gets the bullet, continuation lines are indented under it.
      wrapped.forEach((seg, i) => {
        doc.text(i === 0 ? ('•  ' + seg) : ('   ' + seg), 20, y);
        y += 4.2;
      });
      y += 0.8; // small gap between bullets
    });

    const date = new Date().toISOString().split('T')[0];
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('Generated ' + date + ' by the BadCoin HTML Miner', 105, 290, { align: 'center' });

    doc.save('badcoin-wallet-' + wallet.addr.substring(0, 10) + '.pdf');
    log('info', 'Paper wallet PDF downloaded. Scan the WIF QR with your iPhone wallet to import.');
  }

  function downloadWalletBackup() {
    if (!wallet.addr) return;
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const txt =
      'BadCoin wallet backup\n' +
      '=====================\n' +
      'Generated: ' + now.toISOString() + '\n' +
      'Source: BAD_Coin_Miner.html (offline, 100% client-side keypair generation)\n' +
      '\n' +
      'Address (share freely, send funds here):\n' +
      '  ' + wallet.addr + '\n' +
      '\n' +
      'Private key (WIF) - KEEP SECRET. Anyone with this can spend the coins:\n' +
      '  ' + wallet.wif + '\n' +
      '\n' +
      'Public key (compressed hex):\n' +
      '  ' + wallet.pubHex + '\n' +
      '\n' +
      'How to keep this safe\n' +
      '---------------------\n' +
      '  1. Save this file in at least two separate places (USB drive, encrypted\n' +
      '     archive, printed paper kept somewhere safe). If you lose all copies of\n' +
      '     the private key, the BAD sent to this address is gone forever. No one\n' +
      '     can recover it for you. Too bad, so sad.\n' +
      '  2. Do not paste the private key into any website. Legitimate tools never\n' +
      '     ask for it.\n' +
      '  3. To check your balance later, open the BadCoin block explorer at\n' +
      '     https://explorer.badcoin.dev/ and paste your address (the B... line\n' +
      '     above) into its search box.\n' +
      '  4. To import this address into a desktop BadCoin Core wallet, use the\n' +
      '     debug console: importprivkey "' + wallet.wif + '" "miner" false\n' +
      '\n' +
      'This file was generated 100% inside your browser. No keys were transmitted\n' +
      'anywhere on the network. Treat this file like cash.\n';
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'badcoin-wallet-' + wallet.addr.substring(0, 10) + '-' + stamp + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    log('info', 'Wallet backup downloaded. Keep that file somewhere safe.');
  }

  function wireWalletUI() {
    const genBtn = $('btnGenerateAddress');
    if (genBtn) {
      genBtn.addEventListener('click', () => {
        try {
          const existing = ($('walletAddress').value || '').trim();
          if (wallet.addr || existing) {
            const ok = confirm(
              'Generate a new address?\n\n' +
              'The current address in the payout field will be replaced. ' +
              'If you have not already saved the private key for the previous ' +
              'generated address, do that first (Copy or Download wallet backup).'
            );
            if (!ok) return;
          }
          const kp = generateKeypair();
          showWallet(kp);
        } catch (err) {
          log('error', 'Address generation failed: ' + (err.message || err));
        }
      });
    }

    // Per-row Copy buttons (Address, WIF, Public key)
    document.querySelectorAll('button[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = $(btn.getAttribute('data-copy'));
        if (!target) return;
        const text = (target.textContent || '').trim();
        if (!text || text === '—') return;
        copyTextToClipboard(text).then(() => flashCopied(btn))
          .catch(() => log('warn', 'Copy to clipboard blocked. Select the text manually instead.'));
      });
    });

    const dl = $('btnDownloadWallet');
    if (dl) dl.addEventListener('click', downloadWalletBackup);

    const pdf = $('btnDownloadPdf');
    if (pdf) pdf.addEventListener('click', downloadWalletPdf);
  }

  // ============================================================================
  // Wire up DOM
  // ============================================================================
  function init() {
    // Default threads = half of logical cores (sensible for memory-hard yescrypt)
    const cores = navigator.hardwareConcurrency || 4;
    const defaultThreads = Math.max(1, Math.floor(cores / 2));
    const ti = $('threadsInput');
    if (ti) ti.value = defaultThreads;

    $('btnStart').addEventListener('click', start);
    $('btnStop').addEventListener('click', stop);
    $('btnClearLog').addEventListener('click', () => { state.log = []; renderLog(); });

    wireWalletUI();

    renderStatus();
    renderStats();
    renderLog();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
