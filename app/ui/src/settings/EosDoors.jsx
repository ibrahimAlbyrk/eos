// Settings › Eos › Doors (09 §4.5): the shortcut that opens the quick panel
// and which one holds, Accessibility for reading the selection, and Eos's
// `eos` command on the PATH. Each row reads the
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

// One setting on a hairline: its name, what it does (in its `tone` when it
// waits on the user or just happened), then its control at the right.
export function Row({ label, description, tone, children }) {
  return (
    <div className="stg-row">
      <div className="stg-row__text">
        <div className="stg-row__label">{label}</div>
        {description && <div className={tone ? `stg-row__desc eos-stg__desc--${tone}` : "stg-row__desc"}>{description}</div>}
      </div>
      {children}
    </div>
  );
}

// A few choices side by side (Eos's segmented choice), one checked; arrows
// move between them as in any radio group.
export function Choice({ label, options, value, onChange }) {
  const at = options.findIndex((o) => o.value === value);
  const keys = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = options[(Math.max(at, 0) + step + options.length) % options.length];
    onChange(next.value);
    e.currentTarget.querySelectorAll("[role=radio]")[options.indexOf(next)]?.focus();
  };
  return (
    <div className="eos-seg eos-stg__choice" role="radiogroup" aria-label={label} onKeyDown={keys}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === (at < 0 ? 0 : at) ? 0 : -1}
          title={o.line}
          className="eos-seg__opt"
          onClick={() => { if (o.value !== value) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
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
    <Row label="Quick input shortcut" tone={shortcut.problem || !shortcut.held ? "warn" : undefined} description={shortcutLine(shortcut)}>
      <Choice label="Quick input shortcut" options={offered.map((a) => ({ value: a, label: shortcutWords(a) }))} value={shortcut.accelerator} onChange={(a) => void choose(a)} />
    </Row>
  );
}

export const accessLine = (trusted) =>
  trusted
    ? "Allowed: the quick panel arrives holding what is selected in the app in front."
    : "Not allowed: the quick panel arrives empty. Allow Eos in Privacy & Security › Accessibility.";

export function AccessibilityRow({ doors }) {
  const [access, setAccess] = useState(null);
  useEffect(() => { doors.accessibility?.().then(setAccess, () => {}); }, [doors]);
  if (!access?.available) return null;
  return (
    <Row label="Read the selection" tone={access.trusted ? undefined : "warn"} description={accessLine(access.trusted)}>
      {!access.trusted && <button type="button" className="eos-btn" onClick={() => void doors.openAccessibilitySettings().catch(() => {})}>Open Settings</button>}
    </Row>
  );
}

export function CommandRow({ doors }) {
  const [command, setCommand] = useState(null);
  useEffect(() => { doors.command?.().then(setCommand, () => {}); }, [doors]);
  if (!command?.available) return null;
  const install = async () => setCommand(await doors.installCommand().catch(() => command));
  return (
    <Row label="The eos command" tone={command.problem ? "warn" : undefined} description={commandLine(command)}>
      {!command.installed && <button type="button" className="eos-btn" onClick={() => void install()}>Add to PATH</button>}
    </Row>
  );
}
