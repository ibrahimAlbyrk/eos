// Whether the dashboard's /stream is connected right now (useLive sets it). While
// it is, change events drive every refresh; poll loops only stand in for it.
let live = false;

export function isStreamLive() {
  return live;
}

export function setStreamLive(value) {
  live = value === true;
}
