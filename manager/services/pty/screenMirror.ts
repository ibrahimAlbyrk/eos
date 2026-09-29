import xtermHeadless from "@xterm/headless";
import xtermSerialize from "@xterm/addon-serialize";

// A headless terminal fed the same output the clients get, so a reattach
// (GET /pty/:id/buffer) replays the screen as it IS, not the tail of the byte
// stream. A TUI like Claude Code draws its screen once, then writes only the
// cells that change: replaying a truncated tail left its input box and status
// line blank and lost the mouse modes it set at startup (wheel dead).
//
// The serializer restores the buffers, cursor and most modes; SGR mouse
// encoding (1006) and cursor visibility (25) it skips, so those are tracked here.

const SCROLLBACK = 1000; // xterm.js's default — what the clients keep

export interface ScreenMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  // Resolves once everything written so far is parsed — exactly that, nothing later.
  snapshot(): Promise<string>;
  dispose(): void;
}

export function createScreenMirror(cols: number, rows: number): ScreenMirror {
  const term = new xtermHeadless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new xtermSerialize.SerializeAddon();
  term.loadAddon(serializer);

  let sgrMouse = false;
  let cursorHidden = false;
  const trackModes = (on: boolean) => (params: (number | number[])[]): boolean => {
    if (params.includes(1006)) sgrMouse = on;
    if (params.includes(25)) cursorHidden = !on;
    return false; // observe only — the terminal still applies the mode
  };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackModes(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackModes(false));
  term.parser.registerEscHandler({ final: "c" }, () => { sgrMouse = false; cursorHidden = false; return false; });

  return {
    write: (data) => term.write(data),
    resize: (c, r) => term.resize(c, r),
    snapshot: () => new Promise((resolve) => {
      term.write("", () => {
        resolve(serializer.serialize() + (sgrMouse ? "\x1b[?1006h" : "") + (cursorHidden ? "\x1b[?25l" : ""));
      });
    }),
    dispose: () => term.dispose(),
  };
}
