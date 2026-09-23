import { useState } from "react";
import { basename } from "../../lib/path.js";
import { CLAUDE_COMMAND, KINDS, launch, setCwd } from "../../state/codeWorkspaceStore.js";
import { FolderMenu } from "./FolderMenu.jsx";
import { ClaudeGlyph, TerminalGlyph, FolderGlyph, ChevronGlyph } from "./icons.jsx";

const SHELL_NAME = "login shell";

// An empty pane: pick the folder, then start Claude Code (the `cc` command) or a
// plain shell in it. Shown for the very first pane and whenever the last
// session is closed.
export function TermLauncher({ live, leafId, cwd, error, compact }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const start = (kind) => launch(leafId, kind, cwd);

  return (
    <div className={"cw-launch" + (compact ? " is-compact" : "")}>
      <div className="cw-launch__inner">
        <div className="cw-launch__mark" aria-hidden="true"><ClaudeGlyph size={22} /></div>
        <h2 className="cw-launch__title">Start a session</h2>

        <div className="cw-launch__where">
          <span>in</span>
          <span className="cw-folder-wrap">
            <button
              className={"cw-folder-chip" + (menuOpen ? " on" : "") + (cwd ? "" : " is-empty")}
              onClick={() => setMenuOpen((v) => !v)}
              title={cwd ?? "Choose a folder"}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <FolderGlyph size={13} />
              <span className="cw-folder-chip__name">{cwd ? basename(cwd) : "Choose folder…"}</span>
              <ChevronGlyph />
            </button>
            {menuOpen && (
              <FolderMenu live={live} current={cwd} onPick={setCwd} onClose={() => setMenuOpen(false)} />
            )}
          </span>
        </div>

        <div className="cw-launch__cards">
          <button className="cw-card cw-card--primary" disabled={!cwd} onClick={() => start(KINDS.claude)} autoFocus={!compact}>
            <span className="cw-card__ic"><ClaudeGlyph size={16} /></span>
            <span className="cw-card__text">
              <span className="cw-card__label">Claude Code</span>
              <span className="cw-card__sub mono" title={CLAUDE_COMMAND}>{CLAUDE_COMMAND}</span>
            </span>
            <kbd className="cw-card__kbd">⌘T</kbd>
          </button>
          <button className="cw-card" disabled={!cwd} onClick={() => start(KINDS.shell)}>
            <span className="cw-card__ic"><TerminalGlyph size={16} /></span>
            <span className="cw-card__text">
              <span className="cw-card__label">Terminal</span>
              <span className="cw-card__sub">{SHELL_NAME}</span>
            </span>
            <kbd className="cw-card__kbd">⇧⌘T</kbd>
          </button>
        </div>

        {error && <div className="cw-launch__err">{error}</div>}
      </div>
    </div>
  );
}
