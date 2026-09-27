import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claudeLaunch, createOscScanner } from "../pty/claudeLaunch.ts";
import { CLAUDE_COMMAND } from "../../../contracts/src/http.ts";

const SID = "123e4567-e89b-42d3-a456-426614174000";

describe("claudeLaunch", () => {
  it("pins a fresh conversation id and reports it through the session hook", () => {
    const { command, claudeSessionId } = claudeLaunch();
    assert.match(claudeSessionId, /^[0-9a-f-]{36}$/);
    assert.ok(command.startsWith(`EOS_TTY=$(tty) ${CLAUDE_COMMAND} --session-id ${claudeSessionId} --settings '`));
    assert.ok(command.includes("SessionStart"));
    assert.ok(command.includes('"matcher":"AskUserQuestion|ExitPlanMode"'));
    assert.ok(!command.includes("--resume"));
  });

  it("resumes a conversation, falling back to a fresh one under the same id", () => {
    const { command, claudeSessionId } = claudeLaunch(SID);
    assert.equal(claudeSessionId, SID);
    const [resume, fresh] = command.split("' || EOS_TTY");
    assert.ok(resume.includes(`--resume ${SID}`));
    assert.ok(fresh.includes(`--session-id ${SID}`));
  });
});

describe("createOscScanner", () => {
  it("reads titles (status glyphs stripped) and session reports", () => {
    const scan = createOscScanner();
    assert.deepEqual(scan(`hi\x1b]0;✳ Fix login\x07 \x1b]7777;eos-claude-session=${SID}\x07`), [
      { kind: "title", title: "Fix login" },
      { kind: "claudeSession", id: SID },
    ]);
    assert.deepEqual(scan("\x1b]2;~/proj\x1b\\"), [{ kind: "title", title: "proj" }]);
  });

  it("carries a sequence split across chunks", () => {
    const scan = createOscScanner();
    assert.deepEqual(scan("out\x1b"), []);
    assert.deepEqual(scan("]0;Refac"), []);
    assert.deepEqual(scan("tor auth\x07 more"), [{ kind: "title", title: "Refactor auth" }]);
  });

  it("reads a dialog tool call reported by the PreToolUse hook", () => {
    const hook = { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_1", tool_input: { questions: [] } };
    const b64 = Buffer.from(JSON.stringify(hook)).toString("base64");
    assert.deepEqual(createOscScanner()(`\x1b]7777;eos-claude-tool=${b64}\x07`), [
      { kind: "dialogTool", call: { toolUseId: "toolu_1", name: "AskUserQuestion", input: { questions: [] } } },
    ]);
    const other = Buffer.from(JSON.stringify({ ...hook, tool_name: "Bash" })).toString("base64");
    assert.deepEqual(createOscScanner()(`\x1b]7777;eos-claude-tool=${other}\x07`), []);
  });

  it("ignores foreign OSC codes and malformed session ids", () => {
    const scan = createOscScanner();
    assert.deepEqual(scan("\x1b]8;;https://x\x07link\x1b]8;;\x07\x1b]7777;eos-claude-session=nope\x07"), []);
  });
});
