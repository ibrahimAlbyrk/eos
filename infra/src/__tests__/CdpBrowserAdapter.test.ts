import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBrowserAdapter, chromeLaunchArgs } from "../browser/CdpBrowserAdapter.ts";
import { StaleRefError } from "../../../core/src/ports/BrowserEngine.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A valid JPEG starts with the SOI marker; captures are real screenshots.
function isJpeg(b: Uint8Array): boolean {
  return b.length > 100 && b[0] === 0xff && b[1] === 0xd8;
}

test("launch flags: dsf=2, pipe, headless, autoplay; never mute audio", () => {
  const args = chromeLaunchArgs("/tmp/p");
  assert.ok(args.includes("--force-device-scale-factor=2"));
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.ok(args.includes("--headless=new"));
  // AUDIO IS IN SCOPE: Chrome plays to the system output device, and without
  // the autoplay flag play() rejects with NotAllowedError (audio spike).
  assert.ok(!args.some((a) => a.includes("mute-audio")));
  assert.ok(args.includes("--autoplay-policy=no-user-gesture-required"));
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
// gradient page's, so which page a capture shows is identifiable by byte size.
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

// Real-Chrome integration for the HEADLESS FALLBACK: pipe CDP session, snapshot
// shape, ref lifecycle, trusted act, capture, mute-under-fire. Screencast/frame
// streaming is gone (the human sees the native embedded view, not this lane).
// Skipped when no Chrome binary is installed.
test("CDP adapter (headless fallback) against real Chrome", { timeout: 120_000 }, async (t) => {
  const profileDir = mkdtempSync(join(tmpdir(), "eos-browser-test-"));
  const adapter = new CdpBrowserAdapter({ chromePath: null, profileDir });
  if (!adapter.binaryPath()) {
    t.skip("no Chrome binary installed");
    return;
  }
  try {
    await adapter.launch();
    assert.equal(adapter.isRunning(), true);

    // ---- basic tab facts --------------------------------------------------
    const tabId = await adapter.openTab(pageDataUrl());
    await sleep(500);
    const tabs = await adapter.listTabs();
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].tabId, tabId);
    assert.equal(tabs[0].canGoBack, false);
    assert.equal(tabs[0].muted, false);
    assert.equal(adapter.activeTabId(), tabId, "the open tab is the omitted-tabId default");

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
    // typeText replaces, not appends — re-resolve the ref (afterCheck superseded it).
    const emailNow = afterCheck.snapshot.match(/textbox "Email" (@e\d+)/)![1];
    await adapter.typeText(tabId, emailNow, "new@eos.dev", false);
    assert.equal(await adapter.get(tabId, "value", emailNow), "new@eos.dev");

    // ---- find + textPresent ----------------------------------------------
    const found = await adapter.find(tabId, "Help");
    assert.ok(found.length >= 1);
    assert.equal(found[0].role, "link");
    assert.ok(found[0].box[2] > 0, "match carries a real box");
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

    // ---- capture: viewport + full-page (clamp/tiling) ---------------------
    const viewportShot = await adapter.capture(tabId, false);
    assert.ok(isJpeg(viewportShot), "viewport capture is a JPEG");
    const fullShot = await adapter.capture(tabId, true);
    assert.ok(isJpeg(fullShot), "full-page capture is a JPEG");
    assert.ok(fullShot.length > viewportShot.length, "the 12000px page's full capture is larger than one viewport");

    // ---- multi-tab: open foregrounds; background capture flips-and-restores -
    const tabB = await adapter.openTab(noisePageDataUrl());
    assert.equal(adapter.activeTabId(), tabB, "opening a tab foregrounds it (the omitted-tabId default)");
    await sleep(700); // let the noise paint
    const shotB = await adapter.capture(tabB, false);
    const shotA = await adapter.capture(tabId, false);
    assert.ok(isJpeg(shotB) && isJpeg(shotA));
    assert.ok(shotB.length > shotA.length * 1.5, `background capture returned the noise page (B ${shotB.length}B vs A ${shotA.length}B)`);

    // ---- device emulation reloads without error --------------------------
    await adapter.setDevice(tabId, "mobile");
    await sleep(400);
    assert.equal(adapter.isRunning(), true, "device switch does not tear down the engine");

    await adapter.closeTab(tabB);
    await adapter.closeTab(tabId);

    // ---- audio: the mute guard holds under a page that fights back --------
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
