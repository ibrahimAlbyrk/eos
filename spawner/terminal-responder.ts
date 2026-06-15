// Minimal terminal emulation for the PTY master side. claude's TUI queries the
// terminal during boot (Device Attributes, XTVERSION, kitty-keyboard, status)
// and waits for replies; node-pty is not a terminal emulator, so nobody answers
// and claude only proceeds on its internal timeout — slower under load. We act
// as the terminal and reply, so the handshake completes deterministically and
// the composer mounts promptly.
//
// We answer ONLY capability/status queries that are idempotent and safe to
// answer at any time. Cursor-position report (CSI 6 n) is deliberately NOT
// answered: we are the master and don't know the real cursor position, and a
// wrong value could mislead a mid-session query.
//
// All replies are standard control sequences claude's input parser expects;
// they are written raw to the PTY master (not through the delivery pipeline —
// these are terminal protocol bytes, not user messages, like keystroke/interrupt).

// One alternation over the query forms, each anchored at CSI (\x1b[):
//   0?c        DA1  (Primary Device Attributes)
//   >[0-9;]*c  DA2  (Secondary Device Attributes)
//   >[0-9]*q   XTVERSION
//   ?u         kitty keyboard progressive-enhancement query
//   5n         DSR  (Device Status Report)
// ESC (0x1b) is intentional — these are CSI queries, which begin with it.
// eslint-disable-next-line no-control-regex
const QUERY_RE = /\x1b\[(?:0?c|>[0-9;]*c|>[0-9]*q|\?u|5n)/g;

// Longest query we recognize is short; keep a small tail so a query split across
// a chunk boundary still matches on the next feed.
const MAX_TAIL = 16;

function responseFor(q: string): string {
  if (q.endsWith("q")) return "\x1bP>|eos-pty\x1b\\"; // XTVERSION → DCS reply
  if (q.endsWith("u")) return "\x1b[?0u";              // kitty → no progressive flags
  if (q.endsWith("n")) return "\x1b[0n";               // DSR → terminal OK
  if (q[2] === ">") return "\x1b[>1;95;0c";            // DA2 → xterm-like ident
  return "\x1b[?1;2c";                                  // DA1 → VT100 + AVO
}

export interface TerminalResponder {
  /** Scan a PTY output chunk; return the control-sequence replies to write back. */
  feed(chunk: string): string[];
}

export function createTerminalResponder(): TerminalResponder {
  let buf = "";
  return {
    feed(chunk: string): string[] {
      buf += chunk;
      const responses: string[] = [];
      QUERY_RE.lastIndex = 0;
      let consumedEnd = 0;
      let m: RegExpExecArray | null;
      while ((m = QUERY_RE.exec(buf)) !== null) {
        responses.push(responseFor(m[0]));
        consumedEnd = m.index + m[0].length;
      }
      // Drop everything up to the last matched query (so it never re-matches);
      // keep at most a short trailing tail to bridge a boundary-split query.
      buf = buf.slice(Math.max(consumedEnd, buf.length - MAX_TAIL));
      return responses;
    },
  };
}
