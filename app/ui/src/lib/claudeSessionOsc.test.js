import { describe, it, expect } from "vitest";
import { parseClaudeSessionOsc, withSessionHook, CLAUDE_SESSION_OSC } from "./claudeSessionOsc.js";

const ID = "a397859a-2a03-4c69-9f99-aa1a314e15d6";

describe("claudeSessionOsc", () => {
  it("parses our payload into the session id", () => {
    expect(parseClaudeSessionOsc(`eos-claude-session=${ID}`)).toBe(ID);
  });

  it("ignores foreign or malformed payloads", () => {
    expect(parseClaudeSessionOsc(`other=${ID}`)).toBeNull();
    expect(parseClaudeSessionOsc("eos-claude-session=")).toBeNull();
    expect(parseClaudeSessionOsc("eos-claude-session=not-a-uuid; rm -rf")).toBeNull();
  });

  it("wraps the command with the tty export and a single-quoted inline hook", () => {
    const cmd = withSessionHook("claude --resume x");
    expect(cmd.startsWith("EOS_TTY=$(tty) claude --resume x --settings '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    expect(cmd).toContain(`${CLAUDE_SESSION_OSC};eos-claude-session=`);
  });
});
