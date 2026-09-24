import { describe, it, expect } from "vitest";
import { macEditBytes, shellEscapePath } from "./terminalKeys.js";

const key = (k, mods = {}) => ({ key: k, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods });

describe("macEditBytes", () => {
  it("maps ⌘ line motions", () => {
    expect(macEditBytes(key("ArrowLeft", { metaKey: true }))).toBe("\x01");
    expect(macEditBytes(key("ArrowRight", { metaKey: true }))).toBe("\x05");
    expect(macEditBytes(key("Backspace", { metaKey: true }))).toBe("\x15");
  });
  it("maps ⌥ word motions", () => {
    expect(macEditBytes(key("ArrowLeft", { altKey: true }))).toBe("\x1bb");
    expect(macEditBytes(key("ArrowRight", { altKey: true }))).toBe("\x1bf");
  });
  it("leaves other combos to xterm", () => {
    expect(macEditBytes(key("ArrowLeft"))).toBeNull();
    expect(macEditBytes(key("ArrowLeft", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(macEditBytes(key("ArrowLeft", { metaKey: true, altKey: true }))).toBeNull();
    expect(macEditBytes(key("Backspace", { altKey: true }))).toBeNull();
    expect(macEditBytes(key("c", { metaKey: true }))).toBeNull();
  });
});

describe("shellEscapePath", () => {
  it("escapes spaces and metacharacters", () => {
    expect(shellEscapePath("/Users/me/My Shot (1).png")).toBe("/Users/me/My\\ Shot\\ \\(1\\).png");
  });
  it("keeps plain and non-ASCII paths intact", () => {
    expect(shellEscapePath("/tmp/görsel-ş.png")).toBe("/tmp/görsel-ş.png");
  });
});
