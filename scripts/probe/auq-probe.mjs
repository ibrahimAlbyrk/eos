// One-shot diagnostic probe: discover Claude Code's native AskUserQuestion menu
// keystroke protocol (single/multi/free-text/multi-question). NOT product code.
//
// Usage:
//   node scripts/probe/auq-probe.mjs <scenario> "<step,step,...>"
//   scenario = single | multi | freetext | multiq
//   steps    = comma-separated tokens: up down left right space enter tab esc
//              digits/chars literal, text:Foo for free text. Empty = just snapshot.
//
// Prints: the rendered menu, the post-keystroke render, and the transcript
// tool_result that Claude recorded (the authoritative "what answer landed").

import { spawn } from "/Users/ibrahimalbyrk/Projects/CC/claude-manager/spawner/node_modules/@homebridge/node-pty-prebuilt-multiarch/lib/index.js";
import { mkdtempSync, rmSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const KEYS = {
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  space: " ", enter: "\r", tab: "\t", esc: "\x1b", ctrlc: "\x03",
};
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const strip = (s) => s.replace(ANSI_RE, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encode = (tok) => (tok.startsWith("text:") ? tok.slice(5) : (KEYS[tok] ?? tok));

const SCENARIOS = {
  single: "Call the AskUserQuestion tool RIGHT NOW, exactly once. One question, header 'Fruit', question 'Pick a fruit', single-select, options: Apple, Banana, Cherry. Do NOTHING else — no other tools, no file reads, no prose.",
  multi: "Call the AskUserQuestion tool RIGHT NOW, exactly once. One question, header 'Fruit', question 'Pick fruits', multiSelect TRUE, options: Apple, Banana, Cherry, Date. Do NOTHING else — no other tools, no file reads, no prose.",
  freetext: "Call the AskUserQuestion tool RIGHT NOW, exactly once. One question, header 'Name', question 'Your name?', single-select, options: Alice, Bob. Do NOTHING else — no other tools, no file reads, no prose.",
  multiq: "Call the AskUserQuestion tool RIGHT NOW, exactly once with TWO questions: (1) header 'Fruit' question 'Pick a fruit' options Apple/Banana; (2) header 'Color' question 'Pick a color' options Red/Green. Both single-select. Do NOTHING else.",
  multiq3: "Call the AskUserQuestion tool RIGHT NOW, exactly once with THREE single-select questions: (1) header 'Fruit' question 'Pick a fruit' options Apple/Banana; (2) header 'Color' question 'Pick a color' options Red/Green; (3) header 'Size' question 'Pick a size' options Small/Large. Do NOTHING else.",
  mixq: "Call the AskUserQuestion tool RIGHT NOW, exactly once with TWO questions: (1) header 'Fruit' question 'Pick fruits' multiSelect TRUE options Apple/Banana/Cherry; (2) header 'Color' question 'Pick a color' single-select options Red/Green. Do NOTHING else.",
};

class Pty {
  constructor(cwd) {
    this.tail = "";
    this.full = "";
    this.proc = spawn("claude", ["--model", "claude-sonnet-4-6", "--effort", "low"], {
      name: "xterm-256color", cols: 120, rows: 30, cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    this.proc.onData((d) => { this.tail = (this.tail + d).slice(-30000); this.full += d; });
  }
  send(s) { this.proc.write(s); }
  snapshot() { return strip(this.tail); }
  kill() { try { this.proc.kill(); } catch { /* ignore */ } }
  async waitFor(pred, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred(strip(this.tail))) return true;
      await sleep(150);
    }
    console.error(`[probe] TIMEOUT waiting for: ${label}`);
    return false;
  }
}

async function bootReady(pty) {
  const deadline = Date.now() + 40000;
  let trustHandled = false;
  while (Date.now() < deadline) {
    const out = strip(pty.tail);
    if (!trustHandled && /trust the files|Do you trust|trust this folder/i.test(out)) {
      pty.send("\r");
      trustHandled = true;
      await sleep(800);
      continue;
    }
    if (out.includes("╭")) { await sleep(600); return true; }
    await sleep(200);
  }
  console.error("[probe] boot TIMEOUT — no composer glyph");
  return false;
}

// Find the transcript jsonl by scanning for the project dir whose encoded name
// contains the temp-dir basename — robust to the /var → /private/var realpath.
function findTranscript(cwd) {
  const base = cwd.split("/").filter(Boolean).at(-1);
  const root = join(homedir(), ".claude", "projects");
  let dirs;
  try { dirs = readdirSync(root); } catch { return null; }
  const match = dirs.filter((d) => d.includes(base)).map((d) => join(root, d));
  for (const dir of match) {
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (files.length) return files.map((f) => join(dir, f)).sort().at(-1);
  }
  return null;
}

function parseTranscript(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let use = null;
  const results = [];
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use" && b.name === "AskUserQuestion") use = { id: b.id, input: b.input };
      if (b.type === "tool_result") {
        const txt = Array.isArray(b.content) ? (b.content[0]?.text ?? JSON.stringify(b.content[0])) : b.content;
        results.push({ tool_use_id: b.tool_use_id, text: typeof txt === "string" ? txt.slice(0, 400) : txt });
      }
    }
  }
  return { use, results };
}

async function waitForToolUse(cwd, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = findTranscript(cwd);
    if (f) { const { use } = parseTranscript(f); if (use) return true; }
    await sleep(400);
  }
  return false;
}

function readResult(cwd) {
  const newest = findTranscript(cwd);
  if (!newest) return { error: "no transcript for " + cwd };
  const lines = readFileSync(newest, "utf8").split("\n").filter(Boolean);
  let use = null;
  const results = [];
  for (const ln of lines) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use" && b.name === "AskUserQuestion") use = { id: b.id, input: b.input };
      if (b.type === "tool_result") {
        const txt = Array.isArray(b.content) ? (b.content[0]?.text ?? JSON.stringify(b.content[0])) : b.content;
        results.push({ tool_use_id: b.tool_use_id, text: typeof txt === "string" ? txt.slice(0, 400) : txt });
      }
    }
  }
  const matched = use ? results.find((r) => r.tool_use_id === use.id) : null;
  return { file: newest, useId: use?.id, result: matched ?? "(no tool_result for AUQ — menu still open or no answer)" };
}

async function main() {
  const scenario = process.argv[2] || "multi";
  const steps = (process.argv[3] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const prompt = SCENARIOS[scenario];
  if (!prompt) { console.error("unknown scenario", scenario); process.exit(1); }

  const cwd = mkdtempSync(join(tmpdir(), "auq-probe-"));
  const pty = new Pty(cwd);
  console.log(`[probe] scenario=${scenario} steps=[${steps.join(" ")}] cwd=${cwd}`);

  try {
    if (!(await bootReady(pty))) throw new Error("boot failed");
    pty.send(PASTE_START + prompt + PASTE_END);
    await sleep(500);
    pty.send("\r");

    // Menu-open signal from the PTY: the AUQ menu footer / auto-appended options
    // are unique to the rendered menu and never appear in the prompt echo. (The
    // transcript tool_use line is flushed late — only at turn end — so it can't
    // gate key-sending while the menu is still open.)
    const gotMenu = await pty.waitFor(
      (o) => /Esc to cancel|to navigate|Chat about this/i.test(o),
      60000, "AUQ menu footer",
    );
    if (!gotMenu) console.error("[probe] no AUQ menu footer detected");
    const SETTLE = Number(process.env.PROBE_SETTLE ?? 3000);
    const GAP = Number(process.env.PROBE_GAP ?? 800);
    console.log(`[probe] timing: settle=${SETTLE} gap=${GAP}`);
    await sleep(SETTLE);
    const menuSnap = menuRegion(pty.snapshot());
    console.log("\n========== MENU SNAPSHOT ==========\n" + menuSnap);
    writeFileSync(join(cwd, "..", `auq-${scenario}.menu.txt`), pty.snapshot());

    if (gotMenu && steps.length) {
      for (const st of steps) { pty.send(encode(st)); await sleep(GAP); }
      await sleep(1500);
      console.log("\n========== AFTER-KEYS SNAPSHOT ==========\n" + menuRegion(pty.snapshot()));
      writeFileSync(join(cwd, "..", `auq-${scenario}.afterkeys.txt`), pty.snapshot());
    }

    await sleep(4000);
    console.log("\n========== TRANSCRIPT RESULT ==========\n" + JSON.stringify(readResult(cwd), null, 2));
    // Dump full raw output for byte-level inspection if needed.
    writeFileSync(join(cwd, "..", `auq-probe-${scenario}.raw.log`), pty.full);
    console.log(`\n[probe] raw log: ${join(cwd, "..", `auq-probe-${scenario}.raw.log`)}`);
  } catch (e) {
    console.error("[probe] ERROR", e instanceof Error ? e.message : String(e));
  } finally {
    pty.send("\x03"); pty.send("\x03");
    await sleep(300);
    pty.kill();
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(0);
}

function tailLines(s, n) {
  return s.split("\n").filter((l) => l.trim() !== "").slice(-n).join("\n");
}

// The TUI redraws the menu via cursor moves (no newlines), so after stripping
// ANSI everything collapses. Return the trailing slice where the menu lives.
function menuRegion(s) {
  return s.slice(-900);
}

main();
