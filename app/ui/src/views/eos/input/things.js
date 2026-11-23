// The things handed to the Home input before or beside its text (08 §4.4):
// files and folders by path, files by their bytes (uploaded first), links,
// and long pasted text. Each shows as a chip before the text and goes to the
// core as an attachment { kind, value }. Pure: the hook keeps the list.

import { attachmentKind } from "../../../lib/attachmentKind.js";

// Pasted text this long is a thing of its own, not typing.
export const LONG_TEXT = 500;
const LINK = /^https?:\/\/\S+$/;

const baseName = (path) => path.replace(/\/$/, "").split("/").pop() || path;

export const isLink = (text) => LINK.test(text.trim());

export function pathThing(id, { path, isDir = false }) {
  return { id, kind: attachmentKind(path, isDir), label: baseName(path), value: path, status: "ready" };
}

export function linkThing(id, url) {
  const trimmed = url.trim();
  return { id, kind: "link", label: trimmed.replace(/^https?:\/\//, ""), value: trimmed, status: "ready" };
}

export function textThing(id, text) {
  return { id, kind: "text", label: `Pasted text, ${text.length.toLocaleString("en")} characters`, value: text, status: "ready" };
}

// A file whose bytes are on their way to the core: its path comes later.
export function uploadThing(id, name, kind) {
  return { id, kind, label: name || kind, value: null, status: "uploading" };
}

// What the core reads: ready things only, in order.
export const attachmentsOf = (things) => things.filter((t) => t.status === "ready").map((t) => ({ kind: t.kind, value: t.value }));
