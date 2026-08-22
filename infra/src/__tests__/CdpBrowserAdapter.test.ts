import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBrowserAdapter, jpegSize, chromeLaunchArgs, streamGeometry } from "../browser/CdpBrowserAdapter.ts";
import { StaleRefError } from "../../../core/src/ports/BrowserEngine.ts";
import type { BrowserFrame } from "../../../core/src/ports/BrowserEngine.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("jpegSize reads SOF dimensions", () => {
  // Minimal synthetic JPEG: SOI, APP0 (skippable), SOF0 with 640x1024.
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 len=4
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x80, 0x04, 0x00, 0x03, 0x00, 0x00, 0x00, // SOF0: h=640 w=1024
  ]);
  assert.deepEqual(jpegSize(jpeg), { width: 1024, height: 640 });
  assert.equal(jpegSize(Buffer.from([0x00, 0x01])), null);
});

test("launch flags carry the mandatory screencast prerequisites and never mute audio", () => {
  const args = chromeLaunchArgs("/tmp/p");
  // Frames arrive 1x without forced dsf=2 (spike §0a) — mandatory.
  assert.ok(args.includes("--force-device-scale-factor=2"));
  assert.ok(args.includes("--remote-debugging-pipe"));
  // Headless audio is confirmed on macOS (audio spike) — headless stays.
  assert.ok(args.includes("--headless=new"));
  // AUDIO IS IN SCOPE: Chrome plays to the system output device, and without
  // the autoplay flag play() rejects with NotAllowedError (audio spike).
  assert.ok(!args.some((a) => a.includes("mute-audio")));
  assert.ok(args.includes("--autoplay-policy=no-user-gesture-required"));
});

test("streamGeometry: Responsive streams native device px at q85 (capped 2560); Mobile/Tablet keep the P2 params", () => {
  // RESPONSIVE: maxWidth = cssWidth*dpr (native, 1:1 — no upscale blur), q85.
  assert.deepEqual(streamGeometry("responsive", { cssWidth: 800, cssHeight: 600, dpr: 2 }), { quality: 85, maxWidth: 1600, maxHeight: 1200 });
  // Non-retina still native (dpr 1).
  assert.deepEqual(streamGeometry("responsive", { cssWidth: 1000, cssHeight: 700, dpr: 1 }), { quality: 85, maxWidth: 1000, maxHeight: 700 });
  // An enormous panel clamps to 2560 on both axes so the encoder can't runaway.
  assert.deepEqual(streamGeometry("responsive", { cssWidth: 2000, cssHeight: 1600, dpr: 2 }), { quality: 85, maxWidth: 2560, maxHeight: 2560 });
  // Mobile/Tablet: unchanged P2 params, regardless of the panel size/dpr.
  assert.deepEqual(streamGeometry("mobile", { cssWidth: 1900, cssHeight: 1200, dpr: 3 }), { quality: 60, maxWidth: 1024, maxHeight: 4096 });
  assert.deepEqual(streamGeometry("tablet", { cssWidth: 1900, cssHeight: 1200, dpr: 2 }), { quality: 60, maxWidth: 1024, maxHeight: 4096 });
});

function pageDataUrl(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Fixture</title>
<h1>Sign in</h1>
<p>Use your account to continue.</p>
<nav><a href="#help">Help center</a></nav>
<form>
  <label>Email <input id="email" type="text" value="old@x.y"></label>
  <label>Password <input id="pw" type="password" value="hunter2"></label>
  <label><input id="remember" type="checkbox"> Remember me</label>
  <button id="go" type="button" onclick="document.title='clicked'">Continue</button>
</form>`;
  return "data:text/html," + encodeURIComponent(html);
}

function tallPageDataUrl(): string {
  return "data:text/html," + encodeURIComponent(
    `<!doctype html><body style="margin:0"><div style="height:12000px;background:linear-gradient(red,blue)"></div></body>`,
  );
}

// Dense deterministic colour noise: its JPEG is several times larger than the
// gradient page's, so which page a capture shows is identifiable by byte size
// alone (the spike's frame-size method).
function noisePageDataUrl(): string {
  const html = `<!doctype html><body style="margin:0"><canvas id="c" width="1280" height="800"></canvas>
<script>const x=document.getElementById("c").getContext("2d");let s=7;const r=()=>(s=(s*1664525+1013904223)>>>0)/2**32;
for(let y=0;y<800;y+=4)for(let i=0;i<1280;i+=4){x.fillStyle="rgb("+(r()*255|0)+","+(r()*255|0)+","+(r()*255|0)+")";x.fillRect(i,y,4,4);}</script>`;
  return "data:text/html," + encodeURIComponent(html);
}

// 0.2s of 8-bit PCM square wave — a real, loopable sound source for the
// audible probe and the mute fight.
function wavDataUri(): string {
  const sampleRate = 8000;
  const n = 1600;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = (i >> 4) & 1 ? 200 : 56;
  return "data:audio/wav;base64," + b.toString("base64");
}

// The fighting page: hammers muted=false; volume=1; play() every 100ms — the
// exact hostile pattern the audio spike proved the guard survives.
function fightingAudioDataUrl(): string {
  const html = `<!doctype html><audio id="a" loop autoplay src="${wavDataUri()}"></audio>
<script>setInterval(() => { const a = document.getElementById("a"); a.muted = false; a.volume = 1; a.play(); }, 100);</script>`;
  return "data:text/html," + encodeURIComponent(html);
}

// Real-Chrome integration: pipe CDP session, snapshot shape, ref lifecycle,
// trusted act, capture clamp+tiling, mute-under-fire. Skipped when no Chrome
// binary is installed.
test("CDP adapter against real Chrome", { timeout: 120_000 }, async (t) => {
  const profileDir = mkdtempSync(join(tmpdir(), "eos-browser-test-"));
  const adapter = new CdpBrowserAdapter({ chromePath: null, profileDir });
  if (!adapter.binaryPath()) {
    t.skip("no Chrome binary installed");
    return;
  }
  try {
    await adapter.launch();
    assert.equal(adapter.isRunning(), true);

    // ---- screencast + basic tab facts (the P2 slice) ----------------------
    const tabId = await adapter.openTab(pageDataUrl());
    await sleep(500);
    const tabs = await adapter.listTabs();
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].tabId, tabId);
    assert.equal(tabs[0].canGoBack, false);
    assert.equal(tabs[0].muted, false);

    const first = new Promise<BrowserFrame>((resolve) => {
      void adapter.startScreencast(tabId, { cssWidth: 1280, cssHeight: 800, dpr: 2 }, resolve);
    });
    const frame = await first;
    assert.ok(frame.data.length > 100, "frame carries JPEG bytes");
    assert.equal(frame.data[0], 0xff); // JPEG SOI
    assert.equal(frame.data[1], 0xd8);
    // RESPONSIVE now streams 1:1 at native device px: 1280 CSS × dsf2 = 2560,
    // within the 2560 cap — no upscale blur (was capped to 1024 before the fix).
    assert.equal(frame.width, 2560);
    assert.ok(frame.height > 0);
    await adapter.stopScreencast(tabId);

    // ---- snapshot shape ---------------------------------------------------
    const snap = await adapter.snapshot(tabId, { interactiveOnly: true });
    assert.match(snap.snapshot, /heading "Sign in"/);
    assert.match(snap.snapshot, /link "Help center" @e\d+/);
    assert.match(snap.snapshot, /textbox "Email" @e\d+/);
    assert.match(snap.snapshot, /checkbox "Remember me" @e\d+/);
    assert.match(snap.snapshot, /button "Continue" @e\d+/);
    assert.ok(!snap.snapshot.includes("Use your account"), "StaticText dropped in interactiveOnly");
    assert.ok(!/<[a-z]/i.test(snap.snapshot), "never markup");
    const full = await adapter.snapshot(tabId, { interactiveOnly: false });
    assert.match(full.snapshot, /text "Use your account/);

    // Each snapshot supersedes the previous one's refs — mint the working set
    // from the LATEST snapshot (using snap's refs here would rightly throw).
    const live = await adapter.snapshot(tabId, { interactiveOnly: true });
    const refOf = (re: RegExp): string => {
      const m = live.snapshot.match(re);
      assert.ok(m, `no ref for ${re}`);
      return m![1];
    };
    const emailRef = refOf(/textbox "Email" (@e\d+)/);
    const checkboxRef = refOf(/checkbox "Remember me" (@e\d+)/);
    const buttonRef = refOf(/button "Continue" (@e\d+)/);
    const pwRef = refOf(/textbox "Password" (@e\d+)/);

    // ---- get + password redaction ----------------------------------------
    assert.equal(await adapter.get(tabId, "title"), "Fixture");
    assert.equal(await adapter.get(tabId, "value", emailRef), "old@x.y");
    assert.equal(await adapter.get(tabId, "value", pwRef), "[redacted]");
    // A superseded ref fails loudly instead of acting on a recycled node.
    const staleFromFirstSnap = snap.snapshot.match(/textbox "Email" (@e\d+)/)![1];
    await assert.rejects(() => adapter.get(tabId, "value", staleFromFirstSnap), StaleRefError);

    // ---- act: trusted click + check + type -------------------------------
    await adapter.act(tabId, buttonRef, "click");
    await sleep(200);
    assert.equal(await adapter.get(tabId, "title"), "clicked", "trusted click ran the page handler");
    await adapter.act(tabId, checkboxRef, "check");
    const afterCheck = await adapter.snapshot(tabId, { interactiveOnly: true });
    assert.match(afterCheck.snapshot, /checkbox "Remember me" @e\d+ \[checked\]/);
    // typeText replaces, not appends — but freshEmail went stale when
    // afterCheck superseded it, so re-resolve first (the ref contract).
    const emailNow = afterCheck.snapshot.match(/textbox "Email" (@e\d+)/)![1];
    await adapter.typeText(tabId, emailNow, "new@eos.dev", false);
    assert.equal(await adapter.get(tabId, "value", emailNow), "new@eos.dev");

    // ---- find + textPresent ----------------------------------------------
    const found = await adapter.find(tabId, "Help");
    assert.ok(found.length >= 1);
    assert.equal(found[0].role, "link");
    assert.ok(found[0].box[2] > 0, "match carries a real box");
    assert.ok(!("value" in found[0]) || typeof found[0].value === "string");
    assert.equal(await adapter.textPresent(tabId, "sign in"), true);
    assert.equal(await adapter.textPresent(tabId, "definitely absent text"), false);

    // ---- ref invalidation on navigation + stale-ref error -----------------
    const preNavRef = emailNow;
    await adapter.navigate(tabId, "url", tallPageDataUrl());
    await sleep(600);
    await assert.rejects(
      () => adapter.act(tabId, preNavRef, "click"),
      (e: unknown) => e instanceof StaleRefError && /stale|snapshot/.test((e as Error).message),
      "a pre-navigation ref must fail loudly, never click a recycled node",
    );

    // ---- capture: viewport + full-page clamp/tiling -----------------------
    const viewportShot = await adapter.capture(tabId, false);
    const vDims = jpegSize(viewportShot);
    assert.deepEqual(vDims, { width: 2560, height: 1600 }, "viewport capture at dsf2");
    const fullShot = await adapter.capture(tabId, true);
    const fDims = jpegSize(fullShot);
    assert.ok(fDims, "full-page capture decodes");
    // Content width = viewport minus the scrollbar (~15 css px), times dsf2.
    assert.ok(fDims!.width >= 2500 && fDims!.width <= 2560, `stitched width ${fDims!.width}`);
    // 12000 css px * dsf2 = 24000 device px — three <=8192-device-px tiles
    // stitched; a small rounding margin from tile borders is acceptable.
    assert.ok(Math.abs(fDims!.height - 24000) < 64, `stitched height ${fDims!.height}`);

    // ---- multi-tab foreground rules ---------------------------------------
    // A background target emits ZERO screencast frames and cannot be captured
    // (audio spike), so: subscribing brings the tab to front, and capturing a
    // background tab flips-shoots-restores without the watcher noticing.
    const tabB = await adapter.openTab(noisePageDataUrl()); // B is now foreground
    assert.equal(adapter.activeTabId(), tabB, "opening a tab foregrounds it (the omitted-tabId default)");
    await sleep(700); // let the noise paint
    // Subscribe A again: the initial frame only arrives if the switch put A
    // back in the foreground (a background target would emit nothing).
    const framesA: BrowserFrame[] = [];
    await adapter.startScreencast(tabId, { cssWidth: 1280, cssHeight: 800, dpr: 2 }, (f) => framesA.push(f));
    for (let i = 0; i < 20 && framesA.length === 0; i++) await sleep(250);
    assert.ok(framesA.length >= 1, "frames arrive after switching the subscription back to A");
    assert.equal(adapter.activeTabId(), tabId, "subscribing brings A back to the foreground — human view == agent default");

    // Capture BACKGROUND tab B while A is being watched.
    const beforeCount = framesA.length;
    const shotB = await adapter.capture(tabB, false);
    assert.deepEqual(jpegSize(shotB), { width: 2560, height: 1600 });
    const shotA = await adapter.capture(tabId, false); // A is foreground — no flip
    assert.ok(
      shotB.length > shotA.length * 1.5,
      `background capture returned the noise page (B ${shotB.length}B vs A ${shotA.length}B)`,
    );
    // Foreground restored + screencast kicked: a fresh frame from A proves the
    // stream (and the human's picture) came back after the flip. A damage
    // nudge halfway keeps an idle page from starving the check — a BACKGROUND
    // target paints nothing even with damage, so a frame still proves the
    // foreground is A's.
    let restored = false;
    for (let i = 0; i < 20 && !restored; i++) {
      if (i === 8) {
        await adapter.dispatchInput(tabId, { kind: "mouse", type: "mouseWheel", x: 640, y: 400, button: "none", deltaX: 0, deltaY: 200 });
      }
      await sleep(250);
      restored = framesA.length > beforeCount;
    }
    assert.ok(restored, "frame stream returned to A after capturing background B");

    // ---- regression: a new tab must NOT steal the watched tab's stream ------
    // The white-screen bug: a plain createTarget foregrounds the new target,
    // and a background target emits ZERO frames — the watched panel froze the
    // moment any tab opened. While a screencast is live, openTab creates in
    // the background and the foreground (and the stream) stays put.
    const beforeOpen = framesA.length;
    const tabC = await adapter.openTab("about:blank");
    assert.equal(adapter.activeTabId(), tabId, "a watched tab keeps the foreground when a new tab opens");
    let flowing = false;
    for (let i = 0; i < 20 && !flowing; i++) {
      // the tall page is idle — nudge damage so a healthy stream shows a frame
      await adapter.dispatchInput(tabId, { kind: "mouse", type: "mouseWheel", x: 640, y: 400, button: "none", deltaX: 0, deltaY: i % 2 ? 120 : -120 });
      await sleep(250);
      flowing = framesA.length > beforeOpen;
    }
    assert.ok(flowing, "the watched tab keeps streaming after a new tab opens");
    await adapter.closeTab(tabC);

    // ---- regression: device switch mid-stream resumes at the new geometry ---
    // The squish bug: setDevice's reload left the stream running on the old
    // params and the panel painting transitional aspects. The stream must
    // resume by itself and carry the mobile viewport's aspect.
    const beforeDevice = framesA.length;
    await adapter.setDevice(tabId, "mobile");
    let mobileFrame: BrowserFrame | null = null;
    for (let i = 0; i < 30 && !mobileFrame; i++) {
      await sleep(250);
      const f = framesA[framesA.length - 1];
      if (framesA.length > beforeDevice && f && f.width > 0 && Math.abs(f.width / f.height - 375 / 812) < 0.02) mobileFrame = f;
    }
    assert.ok(mobileFrame, "frames resume after a device switch and carry the mobile aspect");

    await adapter.stopScreencast(tabId);
    await adapter.closeTab(tabB);

    await adapter.closeTab(tabId);

    // ---- audio: the guard holds under a page that fights back -------------
    const audioTab = await adapter.openTab(fightingAudioDataUrl());
    await sleep(900); // let autoplay + a few fight ticks run
    let info = (await adapter.listTabs()).find((x) => x.tabId === audioTab)!;
    assert.equal(info.audible, true, "fixture is audibly playing before mute");
    await adapter.setMuted(audioTab, true);
    await sleep(600); // ≥5 more fight ticks trying muted=false; play()
    info = (await adapter.listTabs()).find((x) => x.tabId === audioTab)!;
    assert.equal(info.muted, true);
    assert.equal(info.audible, false, "mute holds while the page hammers muted=false/play()");
    await adapter.setMuted(audioTab, false);
    await sleep(400);
    info = (await adapter.listTabs()).find((x) => x.tabId === audioTab)!;
    assert.equal(info.audible, true, "unmute restores the page's own (unmuted) state");
    // silence (system-level) mutes too, independent of the user flag
    await adapter.setSilenced(audioTab, true);
    await sleep(400);
    info = (await adapter.listTabs()).find((x) => x.tabId === audioTab)!;
    assert.equal(info.audible, false);
    assert.equal(info.muted, false, "user-level muted flag untouched by silence");
    await adapter.closeTab(audioTab);

    // ---- keep-alive: browser survives the last tab closing ----------------
    await sleep(750);
    assert.equal(adapter.isRunning(), true, "browser must survive closing the last tab");
    assert.equal((await adapter.listTabs()).length, 0); // keep-alive is invisible
    assert.equal(adapter.activeTabId(), null, "no real tab ⇒ no active tab (the keep-alive target never counts)");

    // ---- blank new tab: opens about:blank and does NOT auto-navigate -------
    const blankTab = await adapter.openTab("about:blank");
    assert.equal(adapter.activeTabId(), blankTab, "a fresh tab is the foreground");
    await sleep(300);
    const blankInfo = (await adapter.listTabs()).find((x) => x.tabId === blankTab)!;
    assert.equal(blankInfo.url, "about:blank", "a blank tab stays at about:blank");
    assert.equal(blankInfo.canGoBack, false, "no second navigate ⇒ single history entry, Back stays disabled");
    await adapter.closeTab(blankTab);
    assert.equal(adapter.activeTabId(), null, "closing the foreground clears it");
  } finally {
    adapter.dispose();
    // SIGKILL'd Chrome may still be releasing profile files for a moment —
    // retry the scratch-dir removal instead of failing the test on ENOTEMPTY.
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
});
