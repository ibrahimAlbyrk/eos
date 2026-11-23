import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "../../../lib/notify.js";
import { transport } from "../../../state/eos/transport.js";
import { isLink, LONG_TEXT, linkThing, pathThing, textThing, uploadThing } from "./things.js";
import { fileKind } from "../../../lib/fileKind.js";

// The native bridge touches `window` when it loads: it is loaded on first use,
// so the input draws anywhere (server rendering, tests).
const pasteboardPaths = () => import("../../../lib/nativeBridge.js").then((m) => m.readPasteboardPaths());

// Paste and drop for the Home input: Finder paths come from the native
// bridge, file bytes are uploaded through the core's paste route, a lone
// link or a long text becomes a chip; short text is typed as usual. `cardRef`
// is the element a drop lands on.
export function useThingIntake(cardRef) {
  const [things, setThings] = useState([]);
  const [dragging, setDragging] = useState(false);
  const next = useRef(0);
  const id = () => `th-${++next.current}`;

  const add = useCallback((thing) => setThings((prev) => [...prev, thing]), []);
  const remove = useCallback((thingId) => setThings((prev) => prev.filter((t) => t.id !== thingId)), []);
  const clear = useCallback(() => setThings([]), []);

  const addPaths = useCallback((entries) => {
    for (const entry of entries) add(pathThing(id(), entry));
  }, [add]);

  const addFiles = useCallback((files) => {
    for (const file of files) {
      const thingId = id();
      add(uploadThing(thingId, file.name, fileKind(file.name) === "image" ? "image" : "file"));
      transport.upload(file).catch(() => null).then((r) => {
        if (r?.ok && r.body?.path) {
          setThings((prev) => prev.map((t) => (t.id === thingId ? { ...t, value: r.body.path, status: "ready" } : t)));
        } else {
          setThings((prev) => prev.filter((t) => t.id !== thingId));
          notify.error("Couldn't add the file.", { title: "Eos" });
        }
      });
    }
  }, [add]);

  // A paste: Finder items first, then files, then a link or a long text.
  // Answers whether it took the paste (the input then types nothing).
  const onPaste = useCallback(async (e) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length || isLink(text) || text.length >= LONG_TEXT) e.preventDefault();
    else {
      const paths = await pasteboardPaths();
      if (paths?.length) addPaths(paths);
      return;
    }
    const paths = files.length ? await pasteboardPaths() : null;
    if (paths?.length) addPaths(paths);
    else if (files.length) addFiles(files);
    else if (isLink(text)) add(linkThing(id(), text));
    else add(textThing(id(), text));
  }, [add, addFiles, addPaths]);

  useEffect(() => {
    let unregister = null;
    let gone = false;
    void import("../../../lib/dropSurfaces.js").then(({ registerDropSurface }) => {
      if (gone) return;
      unregister = registerDropSurface({
        editor: () => cardRef.current,
        focused: () => Boolean(cardRef.current?.contains(document.activeElement)),
        drop: addPaths,
        dropFiles: addFiles,
        setDragActive: setDragging,
      });
    });
    return () => {
      gone = true;
      unregister?.();
    };
  }, [cardRef, addPaths, addFiles]);

  return { things, dragging, onPaste, addFiles, remove, clear };
}
