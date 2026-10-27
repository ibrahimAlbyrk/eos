import { useId } from "react";
import { useUi } from "../../../../state/ui.jsx";
import { useHoverCard } from "../../../../hooks/useHoverCard.js";
import { preferredEditor, useEditors } from "../../../../state/editorsStore.js";
import { codeSpanPath, isLocalHref, PATH_ELEMENT_SELECTOR, readPathRef, resolvePath } from "../../../../lib/pathLinks.js";
import { statPath } from "../../../../lib/pathStat.js";
import { usePathPrefs } from "./pathPrefs.js";
import { openInEditor, openInPanel, openPath, revealInFinder } from "./pathActions.js";
import { PathPeek } from "./PathPeek.jsx";
import { PathContextMenu, PATH_MENU } from "./PathContextMenu.jsx";

// Clicks, right-clicks and hovers on every path chip (lib/pathLinks.js) and
// changed-file chip under the element the handlers go on — prose chips are
// injected HTML, so they can't carry React handlers of their own. Click and
// right-click listen in the capture phase so a chip's action never also
// toggles a fold or opens a message's action bar. `layer` holds the hover peek
// and the right-click menu.
export function usePathLinks({ cwd }) {
  const ui = useUi();
  const prefs = usePathPrefs();
  const editor = preferredEditor(useEditors(), prefs.editor);
  const card = useHoverCard();
  const owner = useId();

  const pathElOf = (e) => e.target.closest?.(PATH_ELEMENT_SELECTOR);
  const crossing = (el, e) => el && !el.contains(e.relatedTarget);
  const open = (ref, e) => openPath(ui, ref, e, { clickOpens: prefs.clickOpens, editor });
  const openMenu = (ref, x, y) => {
    card.close();
    ui.openPop(PATH_MENU, { x, y, data: { owner, ref } });
  };

  const onClickCapture = (e) => {
    const el = pathElOf(e);
    if (el) {
      e.preventDefault();
      e.stopPropagation();
      card.close();
      open(readPathRef(el), e);
      return;
    }
    // A link to disk that wasn't drawn as a path (it didn't exist when the
    // message rendered) must never navigate the app window; it opens if it
    // exists now.
    const a = e.target.closest?.("a[href]");
    const href = a?.getAttribute("href");
    if (!isLocalHref(href)) return;
    e.preventDefault();
    const loc = codeSpanPath(href);
    const abs = loc && resolvePath(loc.path, cwd);
    if (!abs) return;
    const mods = { altKey: e.altKey, metaKey: e.metaKey };
    statPath(abs).then((s) => { if (s) open({ ...loc, path: abs, type: s.type }, mods); });
  };

  const onContextMenuCapture = (e) => {
    const el = pathElOf(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    // The keyboard's menu key fires with no pointer position.
    const box = el.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0;
    openMenu(readPathRef(el), keyboard ? box.left : e.clientX, keyboard ? box.bottom + 4 : e.clientY);
  };

  const onMouseOver = (e) => {
    if (!prefs.peek) return;
    const el = pathElOf(e);
    if (crossing(el, e)) card.enterAnchor(el, readPathRef(el));
  };
  const onMouseOut = (e) => {
    if (crossing(pathElOf(e), e)) card.leave();
  };

  const layer = (
    <>
      {card.anchor && (
        <PathPeek
          anchor={card.anchor}
          target={card.payload}
          cwd={cwd}
          editor={editor}
          onEnter={card.enterCard}
          onLeave={card.leave}
          onClose={card.close}
          onOpen={(ref, e) => { card.close(); openInPanel(ui, ref, { tab: e.metaKey }); }}
          onEditor={(ref) => { card.close(); void openInEditor(ref, editor); }}
          onReveal={(ref) => { card.close(); void revealInFinder(ref); }}
          onMore={(ref, box) => openMenu(ref, box.left, box.bottom + 4)}
        />
      )}
      <PathContextMenu owner={owner} cwd={cwd} />
    </>
  );
  return { handlers: { onClickCapture, onContextMenuCapture, onMouseOver, onMouseOut }, layer };
}
