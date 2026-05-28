#!/usr/bin/env python3
"""
Assemble BAD_Coin_Miner.html from template + app code + assets.

Run from anywhere:
    python3 ~/Desktop/Bad_HTML_Miner/src/build.py

Outputs: ~/Desktop/Bad_HTML_Miner/BAD_Coin_Miner.html

Inlined assets:
  - coin.b64               -> {{COIN_B64}}              (base64 PNG logo)
  - ../build/yescrypt-inline.js -> {{YESCRYPT_INLINE_JS}} (Emscripten WASM module + base64 .wasm)
  - yescrypt-wrapper.js    -> {{YESCRYPT_WRAPPER_JS}}   (initYescrypt / yescryptHash bindings)
  - miner-worker.js        -> {{MINER_WORKER_JS}}       (WebWorker harness)
  - sha256.min.js          -> {{SHA256_MIN_JS}}         (js-sha256 for keypair gen)
  - elliptic.min.js        -> {{ELLIPTIC_MIN_JS}}       (secp256k1 for keypair gen)
  - qrcode.min.js          -> {{QRCODE_MIN_JS}}         (QR codes for paper wallet)
  - jspdf.umd.min.js       -> {{JSPDF_MIN_JS}}          (PDF generation)
  - joel-miner-anim.js     -> {{JOEL_MINER_ANIM_JS}}    (Joel's pixel-art mining animation)
  - app.js                 -> {{APP_JS}}                (main-thread app logic)
"""
import os, sys, re

SRC   = os.path.dirname(os.path.abspath(__file__))
ROOT  = os.path.dirname(SRC)
BUILD = os.path.join(ROOT, 'build')
OUT   = os.path.join(ROOT, 'BAD_Coin_Miner.html')

def read_src(name):
    with open(os.path.join(SRC, name)) as f:
        return f.read()

def read_build(name):
    with open(os.path.join(BUILD, name)) as f:
        return f.read()

# Required build artifact: must run build/build-yescrypt-wasm.sh first.
yescrypt_inline_path = os.path.join(BUILD, 'yescrypt-inline.js')
if not os.path.exists(yescrypt_inline_path):
    print(f'ERROR: {yescrypt_inline_path} not found.', file=sys.stderr)
    print('Run build/build-yescrypt-wasm.sh first to produce yescrypt-inline.js.', file=sys.stderr)
    sys.exit(1)

tpl = read_src('template.html')
tpl = tpl.replace('{{COIN_B64}}',            read_src('coin.b64').strip())
tpl = tpl.replace('{{YESCRYPT_INLINE_JS}}',  read_build('yescrypt-inline.js'))
tpl = tpl.replace('{{YESCRYPT_WRAPPER_JS}}', read_src('yescrypt-wrapper.js'))
tpl = tpl.replace('{{MINER_WORKER_JS}}',     read_src('miner-worker.js'))
tpl = tpl.replace('{{SHA256_MIN_JS}}',       read_src('sha256.min.js'))
tpl = tpl.replace('{{ELLIPTIC_MIN_JS}}',     read_src('elliptic.min.js'))
tpl = tpl.replace('{{QRCODE_MIN_JS}}',       read_src('qrcode.min.js'))
tpl = tpl.replace('{{JSPDF_MIN_JS}}',        read_src('jspdf.umd.min.js'))
tpl = tpl.replace('{{JOEL_MINER_ANIM_JS}}',  read_src('joel-miner-anim.js'))
tpl = tpl.replace('{{APP_JS}}',              read_src('app.js'))

# Sanity check: no unsubstituted placeholders left
remaining = re.findall(r'\{\{[A-Z0-9_]+\}\}', tpl)
if remaining:
    print(f'WARN: unsubstituted placeholders: {sorted(set(remaining))}', file=sys.stderr)

with open(OUT, 'w') as f:
    f.write(tpl)

size = os.path.getsize(OUT)
print(f'Wrote {OUT}')
print(f'Size: {size:,} bytes ({size/1024:.1f} KB)')
