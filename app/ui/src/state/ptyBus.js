// ptyBus — per-session PTY frame delivery. Data/exit frames arrive on the shared
// SSE (routed by useLive) and must reach exactly ONE xterm instance without
// re-rendering React on every batch. A keyed listener registry, mirroring
// terminalStore's subscribe idiom but keyed by sessionId.
//
// Distinct from ptyPanelStore (tab/panel state, useSyncExternalStore-driven):
// this is a raw fan-out for high-frequency terminal bytes.

const dataSubs = new Map(); // sessionId -> Set<cb({sessionId,number,seq,data})>
const exitSubs = new Map(); // sessionId -> Set<cb({sessionId,number,exitCode})>

function add(map, sessionId, cb) {
  let set = map.get(sessionId);
  if (!set) { set = new Set(); map.set(sessionId, set); }
  set.add(cb);
  return () => {
    const s = map.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) map.delete(sessionId);
  };
}

export function onPtyData(sessionId, cb) {
  return add(dataSubs, sessionId, cb);
}

export function onPtyExit(sessionId, cb) {
  return add(exitSubs, sessionId, cb);
}

// Called from useLive's SSE demux for `pty:data` frames.
export function emitPtyData(frame) {
  const set = dataSubs.get(frame?.sessionId);
  if (!set) return;
  for (const cb of set) cb(frame);
}

// Called from useLive's SSE demux for `pty:exit` frames.
export function emitPtyExit(frame) {
  const set = exitSubs.get(frame?.sessionId);
  if (!set) return;
  for (const cb of set) cb(frame);
}
