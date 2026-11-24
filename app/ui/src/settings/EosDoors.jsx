// Settings › Eos › Doors (09 §4.5): the shortcut that opens the quick panel
// and which one holds, and Eos's `eos` command on the PATH. Each row reads the
// shell's door (window.eosDoors); a browser tab and a build that owns no door
// show none.

import { useEffect, useState } from "react";

// The shortcuts offered: ⌥Space first, then the fallback Eos takes when it is taken.
export const SHORTCUTS = ["alt+space", "ctrl+alt+space", "cmd+shift+space"];

const KEYS = { alt: "⌥", option: "⌥", ctrl: "⌃", control: "⌃", shift: "⇧", cmd: "⌘", super: "⌘" };

// `alt+space` → `⌥Space`, as the Mac writes it.
export const shortcutWords = (accelerator) =>
  accelerator.split("+").map((part) => KEYS[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1)).join("");

// What the shortcut row says under its name.
export function shortcutLine(shortcut) {
  if (shortcut.problem) return shortcut.problem;
  if (!shortcut.held) return `${shortcutWords(shortcut.accelerator)} is not held.`;
  return "Opens the quick panel over any app, holding what is selected there.";
}

// What the command row says under its name.
export function commandLine(command) {
  if (command.problem) return command.problem;
  if (!command.installed) return "Start routines from a terminal: eos run, eos once, eos halt.";
  if (!command.onPath) return `Linked at ${command.path}. Add its folder to your PATH to type eos anywhere.`;
  return `eos is on your PATH, at ${command.path}.`;
}

function Row({ label, description, children }) {
  return (
    <div className="stg-row">
      <div className="stg-row__text">
        <div className="stg-row__label">{label}</div>
        {description && <div className="stg-row__desc">{description}</div>}
      </div>
      {children}
    </div>
  );
}

export function ShortcutRow({ doors }) {
  const [shortcut, setShortcut] = useState(null);
  useEffect(() => { doors.shortcut?.().then(setShortcut, () => {}); }, [doors]);
  if (!shortcut?.available) return null;
  const choose = async (accelerator) => setShortcut(await doors.setShortcut(accelerator).catch(() => shortcut));
  const offered = SHORTCUTS.includes(shortcut.accelerator) ? SHORTCUTS : [shortcut.accelerator, ...SHORTCUTS];
  return (
    <Row label="Quick input shortcut" description={shortcutLine(shortcut)}>
      <select aria-label="Quick input shortcut" value={shortcut.accelerator} onChange={(e) => void choose(e.target.value)}>
        {offered.map((a) => <option key={a} value={a}>{shortcutWords(a)}</option>)}
      </select>
    </Row>
  );
}

export function CommandRow({ doors }) {
  const [command, setCommand] = useState(null);
  useEffect(() => { doors.command?.().then(setCommand, () => {}); }, [doors]);
  if (!command?.available) return null;
  const install = async () => setCommand(await doors.installCommand().catch(() => command));
  return (
    <Row label="The eos command" description={commandLine(command)}>
      {!command.installed && <button type="button" className="m-btn" onClick={() => void install()}>Add to PATH</button>}
    </Row>
  );
}
