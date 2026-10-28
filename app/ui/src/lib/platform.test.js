import { afterEach, describe, expect, it } from "vitest";
import { hostOS, modDown, modifiers, modLabel, shortcutLabel } from "./platform.js";

// The suite runs without a DOM: only <html data-os> is read.
const setOS = (os) => {
  globalThis.document = os ? { documentElement: { dataset: { os } } } : undefined;
};

afterEach(() => setOS(null));

describe("platform conventions", () => {
  it("reads as mac without a shell", () => {
    expect(hostOS()).toBe("mac");
    expect(modDown({ metaKey: true })).toBe(true);
    expect(modDown({ ctrlKey: true })).toBe(false);
  });

  it("uses ⌘ as the command key on a Mac", () => {
    setOS("mac");
    expect(modifiers({ metaKey: true, ctrlKey: true })).toEqual({ mod: true, ctrl: true, alt: false, shift: false });
    expect(shortcutLabel("mod+shift+k")).toBe("⌘⇧K");
    expect(shortcutLabel("mod+enter")).toBe("⌘↩");
    expect(shortcutLabel("mod+return")).toBe("⌘↵");
    expect(shortcutLabel("shift+mod+t")).toBe("⇧⌘T");
    expect(shortcutLabel("ctrl+`")).toBe("⌃`");
    expect(modLabel()).toBe("⌘");
    expect(modLabel("alt")).toBe("⌥");
  });

  it("uses Ctrl as the command key on Windows", () => {
    setOS("windows");
    expect(modifiers({ ctrlKey: true })).toEqual({ mod: true, ctrl: false, alt: false, shift: false });
    expect(modDown({ metaKey: true })).toBe(false);
    expect(shortcutLabel("mod+shift+k")).toBe("Ctrl+Shift+K");
    expect(shortcutLabel("mod+enter")).toBe("Ctrl+Enter");
    expect(shortcutLabel("return")).toBe("Enter");
    expect(shortcutLabel("shift+mod+t")).toBe("Ctrl+Shift+T");
    expect(modLabel()).toBe("Ctrl");
    expect(modLabel("alt")).toBe("Alt");
  });
});
