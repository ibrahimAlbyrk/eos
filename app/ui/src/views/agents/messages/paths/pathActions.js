// What can be done with a path the chat names — shared by the click, the hover
// peek and the right-click menu. A ref is { path (absolute), type, line?,
// column?, endLine? } (lib/pathLinks.js readPathRef).

import { api } from "../../../../api/client.js";
import { hasLocalScreen } from "../../../../lib/host.js";
import { notify } from "../../../../lib/notify.js";
import { transfers } from "../../../../lib/transferClient.js";
import { noteTransfer } from "../../../../state/transfersStore.js";
import { openFolder } from "../../../files/openFolder.js";

const errText = (e) => (e instanceof Error ? e.message : String(e));
const reportFailure = (r, what) => {
  if (!r?.ok) notify.error(r?.body?.error ?? `Couldn't ${what}`);
};

// A file in the side panel (at its line), a folder in the Files tab.
export function openInPanel(ui, ref, { tab = false } = {}) {
  if (ref.type === "directory") { openFolder(ui, ref.path); return; }
  const reveal = ref.line ? { line: ref.line, column: ref.column, endLine: ref.endLine } : undefined;
  ui.openFile(ref.path, reveal, { tab });
}

export async function openInEditor(ref, editor) {
  try {
    reportFailure(await api.openPathIn(ref.path, editor.id, { line: ref.line, column: ref.column }), `open it in ${editor.name}`);
  } catch (e) { notify.error(errText(e)); }
}

export async function openWithDefaultApp(ref) {
  try { reportFailure(await api.openFile(ref.path), "open it"); } catch (e) { notify.error(errText(e)); }
}

export async function revealInFinder(ref) {
  try { reportFailure(await api.revealFile(ref.path), "show it in Finder"); } catch (e) { notify.error(errText(e)); }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notify.info("Copied");
  } catch (e) {
    notify.error(`Couldn't copy: ${errText(e)}`);
  }
}

// An @mention of the path in the focused composer.
export function attachAsContext(ui, ref) {
  ui.updateComposer({ pendingMention: { paths: [ref.path], ts: Date.now() } });
}

// Into the other Mac's matching project, else its ~/Downloads/Eos; the
// Transfer tab follows it.
export async function sendToMac(ui, ref, peer) {
  try {
    const t = await transfers.start({ from: "local", to: peer.ref, paths: [ref.path] });
    if (t) noteTransfer(t);
    ui.openPanel("transfer");
  } catch (e) {
    notify.error(`Couldn't send to ${peer.label}: ${errText(e)}`);
  }
}

// A click opens the side panel; with the click set to "Editor" it opens the
// editor instead, and ⌥ swaps the two. ⌘ pins a file in its own tab. The editor
// is only for a view that drives this Mac's screen.
export function openPath(ui, ref, e, { clickOpens, editor }) {
  const toEditor = editor && hasLocalScreen() && (clickOpens === "editor") !== e.altKey;
  if (toEditor) void openInEditor(ref, editor);
  else openInPanel(ui, ref, { tab: e.metaKey });
}
