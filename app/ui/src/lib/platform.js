// The desktop conventions of the computer the shell runs on: which key is the
// command modifier and how shortcuts are written. The shell's preload sets
// <html data-os="mac|windows"> before the page runs; a plain browser has none
// and reads as mac.

export function hostOS() {
  return globalThis.document?.documentElement?.dataset?.os === "windows" ? "windows" : "mac";
}

const isMac = () => hostOS() === "mac";

// A keyboard event's modifiers in mac terms. mod is the command key: ⌘ on a
// Mac, Ctrl on Windows. ctrl is the second modifier mac bindings use with it
// (⌃ on a Mac, the Windows key on Windows).
export function modifiers(e) {
  const mac = isMac();
  return {
    mod: Boolean(mac ? e.metaKey : e.ctrlKey),
    ctrl: Boolean(mac ? e.ctrlKey : e.metaKey),
    alt: Boolean(e.altKey),
    shift: Boolean(e.shiftKey),
  };
}

/** The command key is down (other modifiers may be too). */
export function modDown(e) {
  return modifiers(e).mod;
}

const MAC_GLYPHS = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const PC_NAMES = { mod: "Ctrl", ctrl: "Win", alt: "Alt", shift: "Shift" };
// enter and return are the same key; hints write it ↩ or ↵ on a Mac.
const KEY_NAMES = { enter: "↩", return: "↵", backspace: "⌫", escape: "Esc", esc: "Esc", space: "Space", tab: "Tab", up: "↑", down: "↓", left: "←", right: "→" };

function keyName(k) {
  const lower = k.toLowerCase();
  if (KEY_NAMES[lower]) return (lower === "enter" || lower === "return") && !isMac() ? "Enter" : KEY_NAMES[lower];
  return k.length === 1 ? k.toUpperCase() : k;
}

const PC_ORDER = Object.keys(PC_NAMES);

/**
 * How a shortcut reads on this computer: "mod+shift+k" → "⌘⇧K" on a Mac,
 * "Ctrl+Shift+K" on Windows. Mac glyphs keep the order given ("shift+mod+t" →
 * "⇧⌘T"); Windows names always read Ctrl, Win, Alt, Shift.
 */
export function shortcutLabel(spec) {
  const parts = spec.split("+");
  const key = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  if (isMac()) return mods.map((m) => MAC_GLYPHS[m] ?? m).join("") + keyName(key);
  const rank = (m) => (PC_ORDER.includes(m) ? PC_ORDER.indexOf(m) : PC_ORDER.length);
  return [...mods.sort((a, b) => rank(a) - rank(b)).map((m) => PC_NAMES[m] ?? m), keyName(key)].join("+");
}

/** The system's file manager, as menus name it: "Finder" or "File Explorer". */
export function fileManagerName() {
  return isMac() ? "Finder" : "File Explorer";
}

/** One modifier alone, as shortcut hints write it: "⌘" or "Ctrl" (mod), "⌥" or "Alt" (alt)… */
export function modLabel(name = "mod") {
  return isMac() ? MAC_GLYPHS[name] : PC_NAMES[name];
}
