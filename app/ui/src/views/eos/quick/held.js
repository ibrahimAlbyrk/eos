// The item a door outside Eos holds for the quick panel (07 §4.3), as the
// Home input's things: the selection or a shared text as a chip saying where
// it came from, links, files and folders. Pure.

import { linkThing, pathThing } from "../input/things.js";

const SNIPPET = 48;

function textLabel(text, app) {
  const line = text.trim().split(/\s+/).join(" ");
  const cut = line.length > SNIPPET ? `${line.slice(0, SNIPPET - 1)}…` : line;
  return app ? `From ${app}: ${cut}` : cut;
}

export function heldThings(item) {
  return (item?.parts ?? [])
    .map((part, i) => {
      const id = `held-${i}`;
      switch (part.kind) {
        case "text":
          return { id, kind: "text", label: textLabel(part.text, item.app), value: part.text, status: "ready" };
        case "url":
          return linkThing(id, part.url);
        case "file":
          return pathThing(id, { path: part.path });
        case "folder":
          return pathThing(id, { path: part.path, isDir: true });
        default:
          return null;
      }
    })
    .filter(Boolean);
}

// The door a start from the panel names: the one that brought the item; the
// shortcut when the panel opened empty.
export const doorOf = (item) => item?.source ?? "shortcut";
