import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptFile } from "../pty/transcriptFile.ts";
import { transcriptView, type TranscriptView } from "../pty/transcriptRows.ts";

// A transcript in Claude Code's JSONL shape with everything transcriptView
// reads: dialogs, results with patches, turn ends, harness chatter, a torn line,
// a CRLF line, a line longer than the reader's guard, a rewind and a compaction.
function fixture(sidechain: boolean): string[] {
  let n = 0;
  const entry = (e: Record<string, unknown>) => ({ uuid: `u${++n}`, timestamp: new Date(Date.UTC(2026, 8, 27, 10, 0, n)).toISOString(), isSidechain: sidechain, ...e });
  const user = (parentUuid: string | null, content: unknown, extra = {}) => entry({ type: "user", parentUuid, message: { role: "user", content }, ...extra });
  const assistant = (parentUuid: string, content: unknown[], stop: string | null, extra = {}) =>
    entry({ type: "assistant", parentUuid, message: { role: "assistant", content, stop_reason: stop }, ...extra });
  const turnEnd = (parentUuid: string) => entry({ type: "system", subtype: "turn_duration", parentUuid });
  const ask = { questions: [{ header: "Renk", question: "Hangisi?", multiSelect: false, options: [{ label: "Kırmızı" }, { label: "Mavi" }] }] };

  const p1 = user(null, "Merhaba — şu dosyayı düzelt 🙂");
  const a1 = assistant(p1.uuid, [{ type: "thinking", thinking: "bakalım" }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/a.ts" } }], "tool_use");
  const r1 = user(a1.uuid, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], { toolUseResult: { structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["-a", "+b"] }] } });
  const a2 = assistant(r1.uuid, [{ type: "text", text: "Düzelttim." }], null);
  const a3 = assistant(a2.uuid, [{ type: "text", text: "Bitti." }], "end_turn");
  const p2 = user(a3.uuid, "<command-name>/model</command-name>\n<command-args>opus</command-args>");
  const out = user(p2.uuid, "<local-command-stdout>Set model</local-command-stdout>");
  const meta = user(out.uuid, "caveat", { isMeta: true });
  const p3 = user(meta.uuid, [{ type: "text", text: "sor bana" }, { type: "image" }]);
  const a4 = assistant(p3.uuid, [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: ask }], "tool_use");
  const r2 = user(a4.uuid, [{ type: "tool_result", tool_use_id: "q1", content: [{ type: "text", text: "x".repeat(10_000) }] }]);
  const a5 = assistant(r2.uuid, [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "plan" } }], "tool_use");
  const stop = user(a5.uuid, [{ type: "text", text: "[Request interrupted by user]" }]);
  const err = assistant(stop.uuid, [{ type: "text", text: "API Error" }], "stop_sequence", { isApiErrorMessage: true });
  // Rewound to before the slash command: a new branch from a3.
  const retry = user(a3.uuid, '\n<pasted_content id="a8cd">\nyeniden dene\n</pasted_content id="a8cd">\n');
  const a6 = assistant(retry.uuid, [{ type: "tool_use", id: "q2", name: "AskUserQuestion", input: ask }], "tool_use");
  const boundary = entry({ type: "system", subtype: "compact_boundary", parentUuid: null, logicalParentUuid: a6.uuid });
  const summary = user(boundary.uuid, "This session is being continued…", { isCompactSummary: true });
  const p4 = user(summary.uuid, "devam");
  const a7 = assistant(p4.uuid, [{ type: "text", text: "Tamam ✅" }], "end_turn");
  const other = { ...user(null, "a subagent of another chain"), isSidechain: !sidechain };

  const lines = (...es: object[]) => es.map((e) => JSON.stringify(e));
  return [
    ...lines({ type: "permission-mode", permissionMode: "default" }, p1, a1, r1),
    `${JSON.stringify(a2)}\r`,
    ...lines(a3, turnEnd(a3.uuid), { type: "last-prompt", leafUuid: a3.uuid }),
    '{"type":"user","uuid":"torn"',
    ...lines(p2, out, meta, p3, a4, r2, a5, stop, err, other, retry, a6, boundary, summary, p4, a7, turnEnd(a7.uuid)),
  ];
}

// Appends a line in pieces: across a multi-byte character, then all of it but
// the newline, then the newline.
function* growBy(path: string, line: string): Generator<void> {
  const bytes = Buffer.from(`${line}\n`);
  const wide = bytes.findIndex((b) => b >= 0x80);
  const cuts = [...new Set([wide > 0 ? wide + 1 : 0, bytes.length - 1, bytes.length])].filter((c) => c > 0).sort((a, b) => a - b);
  let at = 0;
  for (const cut of cuts) {
    appendFileSync(path, bytes.subarray(at, cut));
    at = cut;
    yield;
  }
}

function harness(opts: { sidechain?: boolean } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "transcript-file-")), "t.jsonl");
  const file = new TranscriptFile(path, opts);
  const same = (): TranscriptView => {
    const view = file.read()!;
    assert.deepEqual(view, transcriptView(readFileSync(path, "utf8"), opts));
    return view;
  };
  return { path, file, same };
}

describe("TranscriptFile", () => {
  for (const sidechain of [false, true]) {
    it(`reads a growing transcript as a fresh parse of the whole file would${sidechain ? " (sidechain)" : ""}`, () => {
      const { path, file, same } = harness({ sidechain });
      assert.equal(file.read(), null);
      writeFileSync(path, "");
      same();
      const seen = new Set<string>();
      for (const line of fixture(sidechain)) {
        for (const _ of growBy(path, line)) {
          const v = same();
          seen.add(`${v.running}:${v.pending?.name ?? "-"}:${v.rows.length}`);
        }
      }
      assert.ok([...seen].some((k) => k.includes("AskUserQuestion")) && [...seen].some((k) => k.includes("ExitPlanMode")));
      // The compaction leaves only what came after it on the branch.
      assert.deepEqual(file.read()!.rows.map((r) => r.type), ["user_message", "agent_event"]);
    });
  }

  it("parses each line once while the file only grows", () => {
    const { path, same } = harness();
    const lines = fixture(false);
    writeFileSync(path, `${lines.slice(0, 3).join("\n")}\n`);
    const first = same().rows[0];
    appendFileSync(path, `${lines.slice(3, 8).join("\n")}\n`);
    assert.equal(same().rows[0], first);
  });

  it("starts over when the file is replaced, goes back in time, is rewritten or truncated", () => {
    const { path, same } = harness();
    const lines = fixture(false);
    const text = `${lines.join("\n")}\n`;
    writeFileSync(path, text);
    const first = same().rows[0];

    // Each of these keeps the bytes before the read offset as they were.
    writeFileSync(`${path}.new`, `${text.replace("Merhaba", "Selam!!")}${lines[1]}\n`);
    renameSync(`${path}.new`, path);
    assert.notEqual(same().rows[0], first);
    writeFileSync(path, `${text.replace("Merhaba", "Hey!!!!")}${lines[1]}\n`);
    utimesSync(path, new Date(2020, 0, 1), new Date(2020, 0, 1));
    same();

    // Rewritten in place and bigger: its size and time alone look like an append.
    writeFileSync(path, `${text.replace("Merhaba", "Selam")}${lines[1]}${lines[2]}\n`);
    same();

    truncateSync(path, Math.floor(text.length / 2));
    same();
    for (const line of lines.slice(-6)) for (const _ of growBy(path, line)) same();
  });
});
