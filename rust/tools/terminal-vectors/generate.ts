// Writes the vectors of the terminal feature's pure rules: what today's
// TypeScript answers, for the Rust ports to equal.
//
//   (cd ../../../contracts && npm ci)        # the contracts package needs zod
//   node generate.ts
//
//   claude-transcript-vectors.json  (eos-domain)        a Claude transcript as conversation rows
//   terminal-vectors.json           (eos-mod-terminals) the launch command, what a pane reports
//                                                       through OSC, the keys that drive Claude's
//                                                       dialogs, escape stripping for `!` output
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeLaunch, createOscScanner } from "../../../manager/services/pty/claudeLaunch.ts";
import { AnswerShapeError, answerSteps, approvePlanSteps, isShellProcess, promptSteps, stepGapMs } from "../../../manager/services/pty/claudeKeys.ts";
import { TranscriptRows } from "../../../manager/services/pty/transcriptRows.ts";

const here = dirname(fileURLToPath(import.meta.url));
const write = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1) + "\n");
  console.log(file);
};

// ---- a Claude transcript as rows -------------------------------------------

let n = 0;
const T = "2026-09-27T10:00:00.000Z";
type E = Record<string, unknown>;
const line = (e: E): E => ({ uuid: `u${++n}`, timestamp: T, isSidechain: false, ...e });
const user = (parent: string | null, content: unknown, extra: E = {}): E =>
  line({ type: "user", parentUuid: parent, message: { role: "user", content }, ...extra });
const assistant = (parent: string | null, content: unknown[], stop: string | null, extra: E = {}): E =>
  line({ type: "assistant", parentUuid: parent, message: { role: "assistant", content, stop_reason: stop }, ...extra });
const id = (e: E): string => e.uuid as string;
const jsonl = (entries: E[]): string => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
const ask = { questions: [{ header: "Color", question: "Which?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }] };

function sessions(): { name: string; lines: string; tail?: string; sidechain?: boolean }[] {
  const out: { name: string; lines: string; tail?: string; sidechain?: boolean }[] = [];
  {
    const u = user(null, "hello");
    const a1 = assistant(id(u), [{ type: "thinking", thinking: "hmm" }, { type: "thinking", thinking: "  " }], "tool_use");
    const a2 = assistant(id(a1), [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }], "tool_use");
    const r = user(id(a2), [{ type: "tool_result", tool_use_id: "t1", content: "file body" }]);
    const a3 = assistant(id(r), [{ type: "text", text: "done" }], "end_turn");
    out.push({ name: "prompt, thinking, tool call, result, answer", lines: jsonl([{ type: "mode" }, u, a1, a2, r, a3]) });
    out.push({ name: "turn ended by its marker", lines: jsonl([u, a1, a2, r, a3, line({ type: "system", subtype: "turn_duration", parentUuid: id(a3) })]) });
  }
  {
    const u = user(null, "go");
    const a = assistant(id(u), [{ type: "text", text: "partial" }], null);
    out.push({ name: "running: a prompt alone", lines: jsonl([u]) });
    out.push({ name: "running: blocks before the stop reason", lines: jsonl([u, a]) });
    out.push({ name: "an unfinished last line counts while it parses", lines: jsonl([u]), tail: JSON.stringify(a) });
    out.push({ name: "a torn last line is ignored", lines: jsonl([u]), tail: JSON.stringify(a).slice(0, 40) });
  }
  {
    const u = user(null, "ask me");
    const a = assistant(id(u), [{ type: "text", text: "one question" }, { type: "tool_use", id: "q1", name: "AskUserQuestion", input: ask }], "tool_use");
    const r = user(id(a), [{ type: "tool_result", tool_use_id: "q1", content: [{ type: "text", text: "answered" }, { type: "image" }, { type: "text", text: "!" }] }]);
    out.push({ name: "an open question", lines: jsonl([u, a]) });
    out.push({ name: "a question answered", lines: jsonl([u, a, r]) });
  }
  {
    const u = user(null, "plan it");
    const a = assistant(id(u), [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "x" } }], "tool_use");
    const i = user(id(a), [{ type: "text", text: "[Request interrupted by user]" }]);
    out.push({ name: "an open plan", lines: jsonl([u, a]) });
    out.push({ name: "an interrupt drops the dialog and aborts the turn", lines: jsonl([u, a, i]) });
    const again = user(id(a), "never mind");
    out.push({ name: "a new prompt drops the dialog", lines: jsonl([u, a, again]) });
  }
  {
    const c = user(null, "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>");
    const o = user(id(c), "<local-command-stdout>Set model</local-command-stdout>");
    const meta = user(id(o), "caveat", { isMeta: true });
    const bare = user(id(meta), "<command-name>/clear</command-name>\n<command-args></command-args>");
    const bash = user(id(bare), "<bash-stdout>ls</bash-stdout>");
    const task = user(id(bash), "<task-notification>done</task-notification>");
    const empty = user(id(task), "   ");
    const summary = user(id(empty), "the summary", { isCompactSummary: true });
    out.push({ name: "slash commands as typed, harness chatter hidden", lines: jsonl([c, o, meta, bare, bash, task, empty, summary]) });
  }
  {
    const pasted = user(null, '\n\n<pasted_content id="a8cd">\nline one\nline two\n</pasted_content id="a8cd">\n');
    const mixed = user(id(pasted), [{ type: "text", text: "look" }, { type: "image", source: {} }, { type: "text", text: "" }, { type: "other" }]);
    out.push({ name: "a pasted prompt, and one with an image", lines: jsonl([pasted, mixed]) });
  }
  {
    const u = user(null, "first");
    const old = assistant(id(u), [{ type: "text", text: "abandoned" }], "end_turn");
    const retry = user(null, "second");
    out.push({ name: "only the active branch after a rewind", lines: jsonl([u, old, retry]) });
  }
  {
    const u = user(null, "edit");
    const a = assistant(id(u), [
      { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/a", old_string: "x", new_string: "y" } },
      { type: "tool_use", id: "g1", name: "Agent", input: { prompt: "look around" } },
      { type: "tool_use" },
    ], "tool_use");
    const r = user(id(a), [
      { type: "tool_result", tool_use_id: "e1", content: "ok" },
      { type: "tool_result", content: "nameless", is_error: true },
    ], { toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }, { oldStart: "bad" }] } });
    const apiError = assistant(id(r), [{ type: "text", text: "API Error: overloaded" }], null, { isApiErrorMessage: true });
    out.push({ name: "an edit with its patch, a subagent call, an API error", lines: jsonl([u, a, r, apiError]) });
  }
  {
    const side = (parent: string | null, e: E): E => ({ ...e, isSidechain: true, parentUuid: parent });
    const u = side(null, user(null, "sub task"));
    const a = side(id(u), assistant(null, [{ type: "text", text: "sub answer" }], "end_turn"));
    out.push({ name: "a subagent's own transcript", lines: jsonl([u, a]), sidechain: true });
    out.push({ name: "sidechain entries are not the conversation", lines: jsonl([u, a]) });
  }
  out.push({
    name: "odd entries",
    lines: [
      JSON.stringify({ type: "user", message: { role: "user", content: "no uuid" } }),
      "not json at all",
      JSON.stringify(line({ type: "user", parentUuid: null, message: { role: "user", content: "bad time" }, timestamp: "yesterday" })),
      JSON.stringify(line({ type: "user", parentUuid: `u${n}`, message: { role: "user", content: 42 } })),
      JSON.stringify(line({ type: "assistant", parentUuid: `u${n}`, message: { role: "assistant", content: "a string, not blocks" } })),
      JSON.stringify(line({ type: "assistant", parentUuid: `u${n}`, message: { role: "assistant", content: [], stop_reason: "end_turn" } })),
      "",
    ].join("\n") + "\n",
  });
  return out;
}

write(
  join(here, "../../crates/eos-domain/tests/fixtures/claude-transcript-vectors.json"),
  {
    source: "manager/services/pty/transcriptRows.ts",
    vectors: sessions().map((s) => {
      const rows = new TranscriptRows({ sidechain: s.sidechain });
      rows.add(s.lines);
      return { ...s, view: rows.view(s.tail ?? "") };
    }),
  },
);

// ---- the terminal feature ---------------------------------------------------

const SID = "0f9a1c2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64");
const hook = { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_1", tool_input: ask };

const oscSessions: string[][] = [
  [`hi\x1b]0;✳ Fix login\x07 \x1b]7777;eos-claude-session=${SID}\x07`, "\x1b]2;~/proj\x1b\\"],
  ["out\x1b", "]0;Refac", "tor auth\x07 more"],
  [`\x1b]7777;eos-claude-tool=${b64(hook)}\x07`],
  [`\x1b]7777;eos-claude-tool=${b64({ ...hook, tool_name: "Bash" })}\x07`, `\x1b]7777;eos-claude-tool=${b64({ ...hook, tool_name: "ExitPlanMode", tool_input: { plan: "do it" } })}\x1b\\`],
  ["\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b]7777;eos-claude-session=nope\x07"],
  [`\x1b]7777;eos-claude-tool=!!!\x07\x1b]7777;eos-claude-tool=${b64({ tool_name: "AskUserQuestion", tool_use_id: 7, tool_input: {} })}\x07\x1b]7777;eos-claude-tool=${b64({ tool_name: "AskUserQuestion", tool_use_id: "x", tool_input: null })}\x07`],
  ["\x1b]0;\x07", "\x1b]0;⠋ ✳  \x07", "\x1b]1;icon only\x07", "\x1b]0;İstanbul 2 ✓\x07", "\x1b]nosemicolon\x07", "\x1b]0;a\x07\x1b]2;b\x1b\\\x1b]0;c\x07"],
  [`\x1b]7777;eos-claude-session=${SID.toUpperCase()}\x07`, `\x1b]7777;other=${SID}\x07`, "\x1b]0;one\x1b", "\\\x1b]0;two\x07"],
  ["\x1b]0;never terminated", " still going", "\x07done"],
];

const single = (optionCount = 3) => ({ multiSelect: false, optionCount });
const multi = (optionCount = 3) => ({ multiSelect: true, optionCount });
const answerCases: [ReturnType<typeof single>[], Parameters<typeof answerSteps>[1]][] = [
  [[single()], [{ options: [1] }]],
  [[single(3)], [{ text: "Purple\nhaze " }]],
  [[multi()], [{ options: [0, 2, 0] }]],
  [[single(), multi()], [{ text: "Teal" }, { options: [1] }]],
  [[single(), single()], [{ options: [2] }, { options: [0] }]],
  [[single(8)], [{ text: "ninth key" }]],
  [[multi(1)], [{ options: [0] }]],
  [[], []],
  [[single()], []],
  [[single()], [{ options: [0, 1] }]],
  [[single(2)], [{ options: [2] }]],
  [[multi()], [{ text: "x" }]],
  [[single()], [{ text: "\n" }]],
  [[single(9)], [{ options: [0] }]],
  [[single(), single(9)], [{ options: [0] }, { text: "late" }]],
  [[multi()], [{ options: [5] }]],
];

// The pattern TerminalRunService strips from `!` output, read from its source
// (it is not exported).
const service = readFileSync(join(here, "../../../manager/services/TerminalRunService.ts"), "utf8");
const ansiSource = /^const ANSI_RE = \/(.+)\/g;$/m.exec(service)?.[1];
if (!ansiSource) throw new Error("TerminalRunService.ts no longer declares ANSI_RE as expected");
const ANSI_RE = new RegExp(ansiSource, "g");
const ansiInputs = [
  "plain", "\x1b[31mred\x1b[0m", "\x1b[?25l\x1b[1;2Hat", "\x1b]0;title\x07after", "\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\", "\x1b]unterminated",
  "cut \x1b[3", "\x1b(B kept", "tab\tand\r\nnewline", "\x1b[38;2;1;2;3mtruecolor\x1b[m \x1b[2 qcursor", "\x1b]0;a\x1bnot st",
];

write(join(here, "../../crates/eos-mod-terminals/tests/fixtures/terminal-vectors.json"), {
  source: "manager/services/pty/claudeLaunch.ts, claudeKeys.ts; manager/services/TerminalRunService.ts",
  launch: [
    { resume: null, ...((l) => ({ id: l.claudeSessionId, command: l.command }))(claudeLaunch()) },
    { resume: SID, id: SID, command: claudeLaunch(SID).command },
  ],
  osc: oscSessions.map((chunks) => {
    const scan = createOscScanner();
    return { chunks, events: chunks.map((c) => scan(c)) };
  }),
  keys: {
    prompts: ["line one\nline two", "", "é 漢"].map((text) => ({ text, steps: promptSteps(text) })),
    approvePlan: approvePlanSteps(),
    gaps: ["\x1b[200~x\x1b[201~", "\r", "1", "\x1b[C", "text"].map((step) => ({ step, ms: stepGapMs(step) })),
    shells: ["zsh", "-bash", "/bin/zsh", "2.1.283", "claude", "fish", "-zsh", "node", "/usr/local/bin/nu", "login", "", "bash5", "-"].map((name) => ({ name, shell: isShellProcess(name) })),
    answers: answerCases.map(([questions, answers]) => {
      try {
        return { questions, answers, steps: answerSteps(questions, answers) };
      } catch (e) {
        if (!(e instanceof AnswerShapeError)) throw e;
        return { questions, answers, error: e.message };
      }
    }),
  },
  ansi: ansiInputs.map((input) => ({ input, output: input.replace(ANSI_RE, "") })),
});
