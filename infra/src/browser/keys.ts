// Key-chord parsing for the press verb: "Enter", "Tab", "Control+a",
// "Shift+Tab" → the CDP Input.dispatchKeyEvent fields. windowsVirtualKeyCode
// matters: without it non-text keys never reach many pages' key handlers.

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const MODIFIER_BITS: Record<string, number> = {
  alt: 1, option: 1,
  control: 2, ctrl: 2,
  meta: 4, cmd: 4, command: 4,
  shift: 8,
};

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

export interface KeyChord {
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text: string; // "" for non-printable or modified chords
}

export function parseChord(chord: string): KeyChord {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`empty key chord: ${JSON.stringify(chord)}`);
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier ${JSON.stringify(part)} in ${JSON.stringify(chord)}`);
    modifiers |= bit;
  }
  const last = parts[parts.length - 1];
  const named = NAMED_KEYS[last.toLowerCase()];
  if (named) {
    // Ctrl/Meta chords suppress text insertion.
    const text = modifiers & (2 | 4) ? "" : named.text ?? "";
    return { modifiers, key: named.key, code: named.code, windowsVirtualKeyCode: named.keyCode, text };
  }
  if (last.length !== 1) throw new Error(`unknown key ${JSON.stringify(last)} in ${JSON.stringify(chord)}`);
  const upper = last.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : "";
  return {
    modifiers,
    key: last,
    code,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    text: modifiers & (2 | 4) ? "" : last,
  };
}
