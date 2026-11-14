# Terminals: no dashboard patch

The terminal panel and Code view needed no change in `app/ui` for the Rust core.

Terminal output never used a socket of its own. It travels on the event stream as `pty:data`
frames and input goes back by `POST`, and both exist unchanged:

| What the dashboard does | Where (`app/ui/src`) | Served by |
|---|---|---|
| reads `pty:data`, `pty:exit`, `pty:session` from `GET /stream` | `hooks/useLive.js` → `state/ptyBus.js` | `eos-runtime` stream, `eos-mod-terminals` topics |
| says which terminals a tab shows (`&ptys=`, `POST /stream/focus`) | `state/streamFocus.js` | `eos-runtime` stream focus (`pty:data` is scoped to it) |
| `POST /pty`, `GET /pty`, `DELETE /pty/:id` | `api/client.js`, `state/ptyPanelStore.js`, `state/codeWorkspaceStore.js` | `eos-mod-terminals` |
| `POST /pty/:id/input` with `{ stream, seq }` | `components/terminal/TerminalView.jsx` | written in `seq` order per stream |
| `POST /pty/:id/resize` | `components/terminal/TerminalView.jsx` | the user's dashboard only |
| `GET /pty/:id/buffer`, then drops live frames with `seq` ≤ the snapshot's | `components/terminal/replayGate.js` | the screen mirror: the same text as 0.1.x's |
| on a stream `resync`, fetches the buffer again | `state/ptyBus.js` (`onPtyResync`) | the stream ring |

One answer is new and already handled: `POST /pty` with `claude` answers `409 { "error": … }`
when Claude Code is not installed. `codeWorkspaceStore.start` shows a failed create's `error`
text in the pane, so the message appears where the pane would have been.
