#!/usr/bin/env python3
"""Item 2: fetch, EventSource, Range and request bodies answered in process on the app's
own origin (http://eos.localhost). Run with the app up; everything executes in the page."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from probe import *
OUT = os.environ.get("GATE_RESULTS", "/Users/ibrahimalbyrk/Projects/CC/eos-rs-data/shell-gate-out/results")
os.makedirs(OUT, exist_ok=True)

LAT = """(async () => {
  const stats = (xs) => { xs = xs.slice().sort((a,b)=>a-b); const q = p => xs[Math.min(xs.length-1, Math.floor(p*xs.length))]; return { n: xs.length, mean: +(xs.reduce((a,b)=>a+b,0)/xs.length).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +xs[xs.length-1].toFixed(3) }; };
  const run = async (url, n, init) => { const xs = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); const r = await fetch(url, init); await r.arrayBuffer(); xs.push(performance.now() - t0); } return stats(xs); };
  const H = { headers: { 'x-eos-ui-token': window.__EOS_UI_TOKEN } };
  await run('/_shell/ping', 20);
  const out = {};
  out.inProcessOnly = await run('/_shell/ping', 300);                       // handler alone, no proxy
  out.proxiedHealth = await run('/_core/health', 300);                      // handler + loopback hop to the daemon
  out.staticAsset = await run('/logo.png', 100).catch(e => String(e));
  out.bridgeCall = await run('/_shell/hosts/list', 200, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eos-ui-token': window.__EOS_UI_TOKEN }, body: 'null' });
  out.proxiedSettings = await run('/_core/api/settings', 100, H);
  // 32 at once
  const t0 = performance.now(); await Promise.all(Array.from({length: 32}, () => fetch('/_core/health').then(r => r.text()))); out.parallel32Ms = +(performance.now() - t0).toFixed(2);
  return out;
})()"""

STREAM = """(async () => {
  const out = {};
  out.sse = await new Promise((resolve) => { const t0 = performance.now(); const at = []; const es = new EventSource('/_shell/test/sse'); es.onmessage = () => { at.push(Math.round(performance.now() - t0)); if (at.length === 15) { es.close(); resolve(at); } }; es.onerror = () => { es.close(); resolve({ error: true, at }); }; });
  { const t0 = performance.now(); const r = await fetch('/_shell/test/chunks'); const rd = r.body.getReader(); const at = []; for (;;) { const { done } = await rd.read(); if (done) break; at.push(Math.round(performance.now() - t0)); } out.fetchReader = at; }
  const range = async (url, hdr) => { const r = await fetch(url, { headers: { Range: hdr } }); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, contentRange: r.headers.get('content-range'), len: b.length, first: b[0], last: b[b.length - 1] }; };
  out.range_0_9 = await range('/_shell/test/range.bin', 'bytes=0-9').catch(e => String(e));
  out.range_10_19 = await range('/_shell/test/range.bin', 'bytes=10-19').catch(e => String(e));
  out.range_200_end = await range('/_shell/test/range.bin', 'bytes=200-').catch(e => String(e));
  // request bodies: JSON, 5 MB binary, FormData
  const big = new Uint8Array(5 * 1024 * 1024); for (let i = 0; i < big.length; i += 4096) big[i] = (i >> 12) & 255;
  let sum = 0; for (let i = 0; i < big.length; i += 4096) sum += big[i];
  const t1 = performance.now(); const e1 = await (await fetch('/_shell/test/echo', { method: 'POST', body: big })).json(); out.body5MB = { ...e1, expectedSum: sum, ms: Math.round(performance.now() - t1) };
  const fd = new FormData(); fd.append('a', '1'); fd.append('f', new Blob(['hello'], { type: 'text/plain' }), 'f.txt');
  out.bodyForm = await (await fetch('/_shell/test/echo', { method: 'PUT', body: fd })).json();
  // the daemon's real event stream through the handler: opens at once, and closing it in the
  // page drops the upstream connection (the daemon's open-fd count goes back down)
  const fds = async () => (await (await fetch('/_core/health')).json()).fds.open;
  const before = await fds();
  const es = new EventSource('/_core/stream?clientId=gate-probe');
  const t2 = performance.now();
  const openMs = await new Promise(r => { es.onopen = () => r(Math.round(performance.now() - t2)); es.onerror = () => r(-1); });
  let frames = 0; es.onmessage = () => { frames++; }; ['hello', 'ping', 'change', 'reload'].forEach(n => es.addEventListener(n, () => { frames++; }));
  await new Promise(r => setTimeout(r, 400));
  const during = await fds();
  es.close(); await new Promise(r => setTimeout(r, 600));
  out.realStream = { openMs, frames, daemonFds: { before, during, afterClose: await fds() } };
  // img + range through the raw origin (cross-origin iframe/img use it)
  out.img = await new Promise(r => { const i = new Image(); i.onload = () => r({ ok: true, w: i.naturalWidth }); i.onerror = () => r({ ok: false }); i.src = '/logo.png?' + Date.now(); });
  return out;
})()"""

res = {"latency": ev(LAT), "stream": ev(STREAM)}
print(json.dumps(res, indent=1))
json.dump(res, open(f"{OUT}/transport.json", "w"), indent=1)
