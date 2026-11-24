import { describe, it, expect } from "vitest";
import { commandLine, shortcutLine, shortcutWords } from "./EosDoors.jsx";

describe("Settings › Eos › Doors", () => {
  it("writes shortcuts as the Mac does", () => {
    expect(shortcutWords("alt+space")).toBe("⌥Space");
    expect(shortcutWords("ctrl+alt+space")).toBe("⌃⌥Space");
    expect(shortcutWords("cmd+shift+k")).toBe("⌘⇧K");
  });

  it("says which shortcut holds, and why the one asked for does not", () => {
    expect(shortcutLine({ accelerator: "alt+space", held: true })).toMatch(/^Opens the quick panel/);
    const fallback = { accelerator: "ctrl+alt+space", held: true, problem: "⌥Space is taken by another app, so ⌃⌥Space opens Eos." };
    expect(shortcutLine(fallback)).toBe(fallback.problem);
    expect(shortcutLine({ accelerator: "cmd+k", held: false })).toBe("⌘K is not held.");
  });

  it("says where the eos command is, and what is left to do", () => {
    expect(commandLine({ installed: false })).toMatch(/^Start routines from a terminal/);
    expect(commandLine({ installed: true, onPath: false, path: "/Users/me/.local/bin/eos" })).toMatch(/Add its folder to your PATH/);
    expect(commandLine({ installed: true, onPath: true, path: "/Users/me/.local/bin/eos" })).toBe("eos is on your PATH, at /Users/me/.local/bin/eos.");
    expect(commandLine({ installed: false, problem: "/Users/me/.local/bin/eos runs /usr/bin/x, not Eos" })).toMatch(/not Eos$/);
  });
});
