// What the update beacon and Settings › Updates say for an UpdateState
// (contracts/src/update.ts). Pure, so both read the same words.

import { formatBytes } from "./format.js";

export const RELEASES_URL = "https://github.com/ibrahimAlbyrk/eos/releases";

export function releaseNotesUrl(version) {
  return `${RELEASES_URL}/tag/v${version}`;
}

// Top-level agents in a turn: what "When they finish" waits for.
export function workingAgents(workers) {
  return (workers ?? []).filter((w) => !w.parent_id && w.state === "WORKING");
}

export function progressOf(status) {
  if (status.phase === "staging") return 1;
  return status.bytes ? Math.min(1, (status.done ?? 0) / status.bytes) : 0;
}

// The header beacon, or null when it stays hidden. A background check that
// failed stays quiet (no network is no news); a download or restart that failed
// shows.
export function beaconOf(state) {
  if (!state) return null;
  const { status, notice } = state;
  switch (status.phase) {
    case "downloading":
    case "staging":
      return { kind: "downloading", label: status.version, progress: progressOf(status) };
    case "available":
    case "ready":
      return { kind: "ready", label: "Update" };
    case "checking":
      return status.version ? { kind: "ready", label: "Update" } : noticeBeacon(notice);
    case "waiting":
      return { kind: "waiting", label: `After ${status.agents} agent${status.agents === 1 ? "" : "s"}` };
    case "applying":
      return { kind: "applying", label: "Restarting" };
    case "error":
      return status.version ? { kind: "error", label: "Update" } : noticeBeacon(notice);
    default:
      return noticeBeacon(notice);
  }
}

function noticeBeacon(notice) {
  if (!notice) return null;
  return notice.kind === "updated" ? { kind: "updated", label: `Updated to ${notice.version}` } : { kind: "error", label: "Update" };
}

// The status card at the top of Settings › Updates: what it says and which
// action it offers.
export function statusCardOf(state) {
  const { status, current, lastCheckedAt } = state;
  const v = status.version;
  switch (status.phase) {
    case "off":
      return { tone: "quiet", title: "Updates are off for this copy", detail: OFF_REASONS[status.off] ?? OFF_REASONS.platform, action: null };
    case "checking":
      return { tone: "busy", title: "Checking for updates…", detail: current, action: null };
    case "available":
      return { tone: "accent", title: `Eos ${v} is available`, detail: "Only what changed is downloaded", action: "download" };
    case "downloading":
      return { tone: "busy", title: `Downloading Eos ${v}`, detail: downloadProgressText(status), action: null, progress: progressOf(status) };
    case "staging":
      return { tone: "busy", title: `Preparing Eos ${v}`, detail: "Building the new version beside this one", action: null, progress: 1 };
    case "ready":
      return { tone: "accent", title: `Eos ${v} is ready`, detail: readyDetail(status), action: "restart" };
    case "waiting":
      return { tone: "accent", title: `Eos ${v} is ready`, detail: `Restarts when ${agentsText(status.agents)} finish`, action: "restart" };
    case "applying":
      return { tone: "busy", title: `Restarting into Eos ${v}…`, detail: null, action: null };
    case "error":
      return { tone: "error", title: v ? `Couldn't update to ${v}` : "Couldn't check for updates", detail: status.error, action: "check" };
    default:
      return { tone: "ok", title: "Eos is up to date", detail: lastCheckedAt ? `${current} · checked ${clockTime(lastCheckedAt)}` : current, action: "check" };
  }
}

const OFF_REASONS = {
  "dev-build": "This copy was built from source — it updates with eos build.",
  platform: "In-app updates aren't available on this system yet.",
  "read-only": "Eos can't replace itself in this folder. Move it to Applications to get updates.",
};

export function noticeText(notice) {
  if (!notice) return null;
  return notice.kind === "updated"
    ? { title: `Updated to Eos ${notice.version}`, detail: `From ${notice.from}` }
    : { title: `Eos ${notice.version} didn't start`, detail: `Eos went back to ${notice.from}. It won't download that version on its own again.` };
}

export function readyDetail(status) {
  return status.bytes != null ? `${formatBytes(status.bytes)} downloaded in the background — only what changed` : "Downloaded in the background";
}

export function downloadProgressText(status) {
  if (!status.bytes) return "Working out what changed…";
  return `${formatBytes(status.done ?? 0)} of ${formatBytes(status.bytes)} · only what changed`;
}

function agentsText(n) {
  return n === 1 ? "1 agent" : `${n ?? 0} agents`;
}

function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
