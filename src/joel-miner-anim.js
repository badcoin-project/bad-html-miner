// ============================================================================
// joel-miner-anim.js
//
// Pixel-art mining animation by Joel. A swinging-pickaxe miner sprite breaks
// a gold-ore block (with progressive cracks, sparks, screen shake), and on a
// found share fires a coin shower + "HA HA" speech bubble + gold flash.
//
// Origin: ~/Desktop/BadCoin/badcoin-miner.html (Joel's integration demo).
// Imported verbatim with two trims for embedding into the HTML miner:
//   1. The demo's three Idle/Mining/Trigger buttons and their handlers are
//      removed (the live miner drives state from real start/stop/share events).
//   2. The status-row updater is kept but is a no-op here because we don't
//      include the demo's #status-state / #status-blocks / #status-hash
//      elements (our own Stats panel already shows that information).
//
// Public API (exposed as window.BadcoinMiner):
//   init(canvasId)        — bind to a <canvas id="..."> on the page
//   setState('idle'|'mining') — call on Start / Stop / disconnect
//   recordBlock(hashHex)  — call when a share is accepted by the pool
// ============================================================================

(function() {
  'use strict';

  // PALETTE
  // Earthy cave palette - keeps the wallet's native UI gray theme intact
  // while giving the miner some visual life. No bright primaries.
  const PAL = {
    bgSky:      '#1a1410',
    bgFar:      '#2d2218',
    bgMid:      '#3d2f22',
    bgNear:     '#4d3a28',
    rockDark:   '#5a4030',
    rockMid:    '#7a5840',
    rockLight:  '#9a7858',
    blockBase:  '#c0a060',
    blockShade: '#806638',
    blockHigh:  '#f0d488',
    coinGold:   '#ffcc44',
    coinShade:  '#aa7700',
    skinTone:   '#d8a878',
    skinShade:  '#a07050',
    shirtRed:   '#a83828',
    shirtShade: '#7a2418',
    pantsBlue:  '#3850a0',
    pantsShade: '#283878',
    pickaxeWood:'#6a4830',
    pickaxeHead:'#888888',
    pickaxeShade:'#444444',
    sparkBright:'#fff8c8',
    sparkMid:   '#ffaa44',
    crackDark:  '#1a0808',
    fistPump:   '#ffffff',
    speech:     '#ffffff',
    speechText: '#1a1a1a'
  };

  const state = {
    mode: 'idle',
    frame: 0,
    minerX: 0,
    minerBaseY: 0,
    blockX: 0,
    blockY: 0,
    blockHits: 0,
    blockMaxHits: 8,
    swingPhase: 0,
    swingActive: false,
    sparks: [],
    coins: [],
    screenShake: 0,
    goldFlashAlpha: 0,
    speechTimer: 0,
    laughOpen: false,
    zPositions: [],
    blockFoundCount: 0,
    canvas: null,
    ctx: null,
    width: 900,
    height: 160,
    pixelSize: 4,
    lastTime: 0,
    bgOffset: 0,
    lastHash: null
  };

  function px(ctx, x, y, color, w, h) {
    w = w || 1; h = h || 1;
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(x) * state.pixelSize, Math.floor(y) * state.pixelSize,
                 w * state.pixelSize, h * state.pixelSize);
  }

  function pxAt(ctx, baseX, baseY, x, y, color, w, h) {
    px(ctx, baseX + x, baseY + y, color, w || 1, h || 1);
  }

  function drawBackground(ctx) {
    const W = state.width / state.pixelSize;
    const H = state.height / state.pixelSize;

    ctx.fillStyle = PAL.bgSky;
    ctx.fillRect(0, 0, state.width, state.height);

    const offFar = Math.floor(state.bgOffset * 0.15) % W;
    ctx.fillStyle = PAL.bgFar;
    for (let i = 0; i < W + 4; i++) {
      const xx = ((i - offFar) % W + W) % W;
      const seed = Math.sin(i * 1.7) * 0.5 + 0.5;
      const h = Math.floor(seed * 8 + 4);
      ctx.fillRect(xx * state.pixelSize, (H - h) * state.pixelSize,
                   state.pixelSize, h * state.pixelSize);
    }

    const offMid = Math.floor(state.bgOffset * 0.4) % W;
    ctx.fillStyle = PAL.bgMid;
    for (let i = 0; i < W + 4; i++) {
      const xx = ((i - offMid) % W + W) % W;
      const seed = Math.sin(i * 0.8 + 2.3) * 0.5 + 0.5;
      const h = Math.floor(seed * 12 + 8);
      ctx.fillRect(xx * state.pixelSize, (H - h) * state.pixelSize,
                   state.pixelSize, h * state.pixelSize);
    }

    ctx.fillStyle = PAL.bgNear;
    ctx.fillRect(0, (H - 6) * state.pixelSize, state.width, 6 * state.pixelSize);

    ctx.fillStyle = PAL.rockMid;
    for (let i = 0; i < 8; i++) {
      const seed = Math.sin(i * 12.9) * 0.5 + 0.5;
      const xx = Math.floor(seed * W);
      ctx.fillRect(xx * state.pixelSize, (H - 6) * state.pixelSize,
                   state.pixelSize * 2, state.pixelSize);
    }
  }

  function drawMiner(ctx, baseX, baseY, mode) {
    const X = baseX, Y = baseY - 18;

    let pickaxeAngle = 0;
    let armUp = false;
    let mouthOpen = false;
    let leaning = false;
    let standing = (mode === 'mining' || mode === 'celebrating');

    if (mode === 'mining' && state.swingActive) {
      pickaxeAngle = Math.sin(state.swingPhase * Math.PI) * 1.2 - 0.6;
      armUp = state.swingPhase < 0.4;
    } else if (mode === 'celebrating') {
      armUp = (Math.floor(state.frame / 8) % 2) === 0;
      mouthOpen = state.laughOpen;
    } else {
      leaning = true;
    }

    // Helmet
    pxAt(ctx, X, Y, 3, 0, PAL.shirtRed, 6, 1);
    pxAt(ctx, X, Y, 2, 1, PAL.shirtRed, 8, 2);
    pxAt(ctx, X, Y, 4, 0, PAL.coinGold, 1, 1);

    // Face
    pxAt(ctx, X, Y, 3, 3, PAL.skinTone, 6, 4);
    pxAt(ctx, X, Y, 3, 3, PAL.skinShade, 1, 4);
    if (mode === 'idle' && (state.frame % 240 < 200)) {
      pxAt(ctx, X, Y, 4, 4, PAL.skinShade, 1, 1);
      pxAt(ctx, X, Y, 7, 4, PAL.skinShade, 1, 1);
    } else if (mode === 'celebrating') {
      pxAt(ctx, X, Y, 4, 4, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 7, 4, PAL.crackDark, 1, 1);
    } else {
      pxAt(ctx, X, Y, 4, 4, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 7, 4, PAL.crackDark, 1, 1);
    }
    if (mouthOpen) {
      pxAt(ctx, X, Y, 5, 6, PAL.crackDark, 2, 1);
      pxAt(ctx, X, Y, 5, 5, PAL.shirtRed, 2, 1);
    } else if (mode === 'celebrating') {
      pxAt(ctx, X, Y, 5, 6, PAL.crackDark, 2, 1);
    } else {
      pxAt(ctx, X, Y, 5, 6, PAL.skinShade, 2, 1);
    }
    pxAt(ctx, X, Y, 3, 7, PAL.shirtShade, 6, 1);
    pxAt(ctx, X, Y, 4, 8, PAL.shirtShade, 4, 1);

    // Torso
    if (leaning) {
      pxAt(ctx, X, Y, 3, 9, PAL.shirtRed, 6, 4);
      pxAt(ctx, X, Y, 3, 9, PAL.shirtShade, 1, 4);
    } else {
      pxAt(ctx, X, Y, 3, 9, PAL.shirtRed, 6, 4);
      pxAt(ctx, X, Y, 3, 9, PAL.shirtShade, 1, 4);
    }

    // Right arm
    if (armUp && (mode === 'mining' || mode === 'celebrating')) {
      pxAt(ctx, X, Y, 9, 8, PAL.shirtRed, 1, 1);
      pxAt(ctx, X, Y, 10, 7, PAL.shirtRed, 1, 1);
      pxAt(ctx, X, Y, 11, 6, PAL.skinTone, 1, 1);
    } else if (mode === 'mining') {
      pxAt(ctx, X, Y, 9, 10, PAL.shirtRed, 1, 1);
      pxAt(ctx, X, Y, 10, 11, PAL.shirtRed, 1, 1);
      pxAt(ctx, X, Y, 11, 12, PAL.skinTone, 1, 1);
    } else {
      pxAt(ctx, X, Y, 9, 10, PAL.shirtRed, 1, 3);
      pxAt(ctx, X, Y, 9, 13, PAL.skinTone, 1, 1);
    }
    // Left arm
    pxAt(ctx, X, Y, 2, 10, PAL.shirtRed, 1, 3);
    pxAt(ctx, X, Y, 2, 13, PAL.skinTone, 1, 1);

    // Legs
    if (leaning) {
      pxAt(ctx, X, Y, 3, 13, PAL.pantsBlue, 6, 3);
      pxAt(ctx, X, Y, 3, 16, PAL.crackDark, 3, 2);
      pxAt(ctx, X, Y, 6, 16, PAL.crackDark, 3, 2);
    } else {
      pxAt(ctx, X, Y, 3, 13, PAL.pantsBlue, 3, 4);
      pxAt(ctx, X, Y, 6, 13, PAL.pantsBlue, 3, 4);
      pxAt(ctx, X, Y, 3, 13, PAL.pantsShade, 1, 4);
      pxAt(ctx, X, Y, 6, 13, PAL.pantsShade, 1, 4);
      pxAt(ctx, X, Y, 3, 17, PAL.crackDark, 3, 1);
      pxAt(ctx, X, Y, 6, 17, PAL.crackDark, 3, 1);
    }

    // Pickaxe
    if (mode === 'mining' || (mode === 'celebrating' && armUp)) {
      drawPickaxe(ctx, X, Y, pickaxeAngle, armUp);
    } else if (leaning) {
      pxAt(ctx, X, Y, 11, 13, PAL.pickaxeWood, 1, 5);
      pxAt(ctx, X, Y, 10, 12, PAL.pickaxeHead, 3, 1);
      pxAt(ctx, X, Y, 10, 11, PAL.pickaxeShade, 1, 1);
      pxAt(ctx, X, Y, 12, 11, PAL.pickaxeShade, 1, 1);
    }

    if (mode === 'idle') {
      drawSleepingZs(ctx, X + 8, Y - 2);
    }
  }

  function drawPickaxe(ctx, X, Y, angle, up) {
    const handX = up ? X + 11 : X + 11;
    const handY = up ? Y + 6  : Y + 12;

    if (up) {
      pxAt(ctx, 0, 0, handX, handY - 1, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 1, handY - 2, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 2, handY - 3, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 3, handY - 4, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 2, handY - 5, PAL.pickaxeHead, 3, 1);
      pxAt(ctx, 0, 0, handX + 4, handY - 4, PAL.pickaxeShade, 1, 1);
      pxAt(ctx, 0, 0, handX + 2, handY - 6, PAL.pickaxeShade, 1, 1);
    } else {
      pxAt(ctx, 0, 0, handX, handY, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 1, handY, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 2, handY - 1, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 3, handY - 2, PAL.pickaxeWood, 1, 1);
      pxAt(ctx, 0, 0, handX + 3, handY - 3, PAL.pickaxeHead, 1, 3);
      pxAt(ctx, 0, 0, handX + 4, handY - 3, PAL.pickaxeShade, 1, 1);
      pxAt(ctx, 0, 0, handX + 4, handY - 1, PAL.pickaxeShade, 1, 1);
    }
  }

  function drawSleepingZs(ctx, X, Y) {
    for (let i = 0; i < 3; i++) {
      const phase = ((state.frame * 0.5) + i * 80) % 240 / 240;
      if (phase > 0.85) continue;
      const yOff = -Math.floor(phase * 12);
      const xOff = i + Math.floor(Math.sin(phase * Math.PI) * 2);
      const alpha = phase < 0.7 ? 1 : (1 - (phase - 0.7) / 0.15);
      const sz = 1 + i;
      ctx.globalAlpha = alpha;
      pxAt(ctx, 0, 0, X + xOff, Y + yOff, PAL.skinShade, sz, 1);
      pxAt(ctx, 0, 0, X + xOff + sz - 1, Y + yOff + 1, PAL.skinShade, 1, 1);
      pxAt(ctx, 0, 0, X + xOff, Y + yOff + 2, PAL.skinShade, sz, 1);
      ctx.globalAlpha = 1;
    }
  }

  function drawBlock(ctx, baseX, baseY, hits, maxHits) {
    if (hits >= maxHits) return;
    const X = baseX;
    const Y = baseY - 16;

    pxAt(ctx, X, Y, 0, 0, PAL.blockBase, 16, 16);

    pxAt(ctx, X, Y, 0, 0, PAL.blockHigh, 16, 1);
    pxAt(ctx, X, Y, 0, 1, PAL.blockHigh, 1, 14);

    pxAt(ctx, X, Y, 15, 1, PAL.blockShade, 1, 15);
    pxAt(ctx, X, Y, 0, 15, PAL.blockShade, 16, 1);

    pxAt(ctx, X, Y, 3, 3, PAL.coinGold, 1, 1);
    pxAt(ctx, X, Y, 9, 5, PAL.coinGold, 1, 1);
    pxAt(ctx, X, Y, 5, 8, PAL.coinGold, 1, 1);
    pxAt(ctx, X, Y, 11, 10, PAL.coinGold, 2, 1);
    pxAt(ctx, X, Y, 6, 12, PAL.coinGold, 1, 1);

    const crackProgress = hits / maxHits;
    if (crackProgress > 0.15) {
      pxAt(ctx, X, Y, 8, 4, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 9, 5, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 10, 6, PAL.crackDark, 1, 1);
    }
    if (crackProgress > 0.4) {
      pxAt(ctx, X, Y, 7, 7, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 7, 8, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 7, 9, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 6, 10, PAL.crackDark, 1, 1);
    }
    if (crackProgress > 0.65) {
      pxAt(ctx, X, Y, 11, 7, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 12, 8, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 13, 9, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 4, 11, PAL.crackDark, 1, 1);
      pxAt(ctx, X, Y, 3, 12, PAL.crackDark, 1, 1);
    }
    if (crackProgress > 0.85) {
      pxAt(ctx, X, Y, 5, 5, PAL.crackDark, 2, 1);
      pxAt(ctx, X, Y, 9, 11, PAL.crackDark, 2, 1);
      pxAt(ctx, X, Y, 13, 13, PAL.crackDark, 1, 1);
    }
  }

  function spawnImpactSparks(x, y) {
    for (let i = 0; i < 6; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 0.8 + Math.random() * 1.2;
      state.sparks.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 25, maxLife: 25,
        size: Math.random() < 0.5 ? 1 : 2,
        color: Math.random() < 0.6 ? PAL.sparkBright : PAL.sparkMid
      });
    }
  }

  function spawnCelebrationCoins(x, y) {
    for (let i = 0; i < 18; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
      const speed = 1.5 + Math.random() * 1.8;
      state.coins.push({
        x: x + (Math.random() - 0.5) * 4,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        life: 90, maxLife: 90,
        rotPhase: Math.random() * Math.PI * 2,
        rotSpeed: 0.15 + Math.random() * 0.1,
        size: 2
      });
    }
  }

  function updateParticles() {
    for (let i = state.sparks.length - 1; i >= 0; i--) {
      const s = state.sparks[i];
      s.x += s.vx; s.y += s.vy; s.vy += 0.08;
      s.life--;
      if (s.life <= 0) state.sparks.splice(i, 1);
    }
    for (let i = state.coins.length - 1; i >= 0; i--) {
      const c = state.coins[i];
      c.x += c.vx; c.y += c.vy; c.vy += 0.08;
      c.rotPhase += c.rotSpeed;
      c.life--;
      if (c.life <= 0) state.coins.splice(i, 1);
    }
  }

  function drawParticles(ctx) {
    for (const s of state.sparks) {
      const alpha = s.life / s.maxLife;
      ctx.globalAlpha = alpha;
      pxAt(ctx, 0, 0, Math.floor(s.x), Math.floor(s.y), s.color, s.size, s.size);
    }
    ctx.globalAlpha = 1;

    for (const c of state.coins) {
      const alpha = c.life > 30 ? 1 : c.life / 30;
      ctx.globalAlpha = alpha;
      const rotW = Math.abs(Math.sin(c.rotPhase)) * c.size + 1;
      const x = Math.floor(c.x);
      const y = Math.floor(c.y);
      pxAt(ctx, 0, 0, x, y, PAL.coinShade, Math.ceil(rotW), c.size);
      pxAt(ctx, 0, 0, x, y, PAL.coinGold, Math.max(1, Math.floor(rotW)), c.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawSpeechBubble(ctx, X, Y) {
    if (state.speechTimer <= 0) return;

    const w = 22, h = 8;
    const bx = X, by = Y - 14;

    pxAt(ctx, 0, 0, bx, by, PAL.speech, w, h);
    pxAt(ctx, 0, 0, bx + 1, by - 1, PAL.speech, w - 2, 1);
    pxAt(ctx, 0, 0, bx + 1, by + h, PAL.speech, w - 2, 1);

    pxAt(ctx, 0, 0, bx - 1, by + 1, PAL.crackDark, 1, h - 2);
    pxAt(ctx, 0, 0, bx + w, by + 1, PAL.crackDark, 1, h - 2);

    pxAt(ctx, 0, 0, bx + 2, by + h, PAL.speech, 2, 1);
    pxAt(ctx, 0, 0, bx + 3, by + h + 1, PAL.speech, 1, 1);

    drawPixelText(ctx, bx + 2, by + 2, 'HA HA');
  }

  function drawPixelText(ctx, X, Y, str) {
    const font = {
      'H': [[1,0,1],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
      'A': [[0,1,0],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
      ' ': [[0,0],[0,0],[0,0],[0,0],[0,0]]
    };
    let cx = X;
    for (const ch of str) {
      const glyph = font[ch];
      if (!glyph) { cx += 4; continue; }
      const w = glyph[0].length;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < w; c++) {
          if (glyph[r][c]) {
            pxAt(ctx, 0, 0, cx + c, Y + r, PAL.speechText, 1, 1);
          }
        }
      }
      cx += w + 1;
    }
  }

  function render(t) {
    if (!state.canvas) return;

    const dt = state.lastTime ? Math.min(t - state.lastTime, 100) : 16;
    state.lastTime = t;
    state.frame++;
    state.bgOffset += 0.3;

    const ctx = state.ctx;

    ctx.save();
    if (state.screenShake > 0) {
      const shakeX = (Math.random() - 0.5) * state.screenShake;
      const shakeY = (Math.random() - 0.5) * state.screenShake;
      ctx.translate(shakeX, shakeY);
      state.screenShake *= 0.85;
      if (state.screenShake < 0.3) state.screenShake = 0;
    }

    drawBackground(ctx);

    if (state.mode !== 'celebrating' || state.blockHits < state.blockMaxHits) {
      drawBlock(ctx, state.blockX, state.blockY, state.blockHits, state.blockMaxHits);
    }

    if (state.mode === 'mining') {
      if (!state.swingActive && Math.random() < 0.012) {
        state.swingActive = true;
        state.swingPhase = 0;
      }
      if (state.swingActive) {
        state.swingPhase += 0.04;
        if (state.swingPhase >= 0.5 && state.swingPhase < 0.55) {
          spawnImpactSparks(state.blockX, state.blockY - 8);
          state.screenShake = 3;
          if (state.blockHits < state.blockMaxHits - 1) {
            state.blockHits = Math.min(state.blockHits + 1, state.blockMaxHits - 1);
          }
        }
        if (state.swingPhase >= 1) {
          state.swingActive = false;
          state.swingPhase = 0;
        }
      }
    }

    drawMiner(ctx, state.minerX, state.minerBaseY, state.mode);

    updateParticles();
    drawParticles(ctx);

    if (state.mode === 'celebrating' && state.speechTimer > 0) {
      drawSpeechBubble(ctx, state.minerX + 8, state.minerBaseY - 18);
      state.speechTimer -= dt;
      state.laughOpen = (Math.floor((state.frame / 6)) % 2) === 0;
    }

    ctx.restore();

    if (state.goldFlashAlpha > 0) {
      ctx.globalAlpha = state.goldFlashAlpha;
      ctx.fillStyle = PAL.coinGold;
      ctx.fillRect(0, 0, state.width, state.height);
      ctx.globalAlpha = 1;
      state.goldFlashAlpha *= 0.88;
      if (state.goldFlashAlpha < 0.02) state.goldFlashAlpha = 0;
    }

    if (state.mode === 'celebrating' && state.speechTimer <= 0 &&
        state.coins.length === 0 && state.goldFlashAlpha === 0) {
      state.blockHits = 0;
      state.mode = 'mining';
    }

    requestAnimationFrame(render);
  }

  function init(canvasId) {
    state.canvas = document.getElementById(canvasId);
    if (!state.canvas) {
      console.warn('BadcoinMiner: canvas not found:', canvasId);
      return;
    }
    state.ctx = state.canvas.getContext('2d');
    state.ctx.imageSmoothingEnabled = false;

    state.width = state.canvas.width;
    state.height = state.canvas.height;
    const W = state.width / state.pixelSize;
    const H = state.height / state.pixelSize;

    state.minerX = Math.floor(W * 0.25);
    state.minerBaseY = H - 6;
    state.blockX = Math.floor(W * 0.45);
    state.blockY = H - 6;

    requestAnimationFrame(render);
  }

  function setState(newState) {
    if (newState === 'idle' || newState === 'mining') {
      state.mode = newState;
      if (newState === 'idle') {
        state.swingActive = false;
        state.swingPhase = 0;
      }
    }
  }

  function recordBlock(hash) {
    state.blockHits = state.blockMaxHits;
    state.mode = 'celebrating';
    state.swingActive = false;
    state.blockFoundCount++;
    spawnCelebrationCoins(state.blockX + 8, state.blockY - 8);
    state.screenShake = 6;
    state.goldFlashAlpha = 0.45;
    state.speechTimer = 1400;
    state.lastHash = hash || null;
  }

  // Auto-init when DOM is ready, binding to a canvas with id="badcoin-miner-canvas".
  window.BadcoinMiner = { init: init, setState: setState, recordBlock: recordBlock };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { init('badcoin-miner-canvas'); });
  } else {
    init('badcoin-miner-canvas');
  }
})();
