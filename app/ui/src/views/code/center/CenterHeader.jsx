import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { breadcrumbFor } from "../../../lib/breadcrumb.js";
import { computeRects } from "../../../lib/paneLayout.js";
import { nameOf, AgentName } from "../../../lib/agentName.js";
import { RenameInput } from "../../../components/RenameInput.jsx";
import { api } from "../../../api/client.js";
import { HeaderAgentMenu } from "../popovers/HeaderAgentMenu.jsx";
import { PanePresets } from "./PanePresets.jsx";
import { SplitEmptyButton } from "./SplitEmptyButton.jsx";
import { FollowButton } from "./FollowButton.jsx";
import { TerminalToggleButton } from "./TerminalToggleButton.jsx";

export function CenterHeader({ live }) {
  const ui = useUi();
  // Header-local rename (breadcrumb inline edit) — deliberately NOT the shared
  // ui.renamingId, which the sidebar row watches; sharing it would mount two
  // inputs fighting for focus.
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setRenaming(false); }, [ui.selectedId]);

  // Publish the header's live height as --head-h on .center so a docked right
  // panel can rise the exact bar height to sit AT the top-bar level (its tab strip
  // occupies that row). Measured, not a constant: the bar is 60px in web but auto
  // in native (html.native), and shifts with fullscreen.
  const headRef = useRef(null);
  useLayoutEffect(() => {
    const el = headRef.current;
    const center = el?.closest(".center");
    if (!center) return;
    const apply = () => center.style.setProperty("--head-h", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Publish --dock-cover: the width an OPEN dock anchored to the bar's right end
  // steals from the top bar, so .head padding-right can push the .right button
  // cluster left of the risen viewer (see styles). Tracks the live viewer edge —
  // the ResizeObserver fires as the dock resizes; the sig re-observes when the set
  // of open docks / pane structure changes.
  const dockSig = ui.paneCount <= 1
    ? `s:${ui.topPanelType || ""}`
    : `m:${(ui.tree ? computeRects(ui.tree) : []).map((r) => `${r.id}:${r.rect.top}:${ui.topPanelTypeIn(r.id) || ""}`).join("|")}`;
  useLayoutEffect(() => {
    const center = headRef.current?.closest(".center");
    if (!center) return;
    const sel = ".pane-dock, .pane-panel-slot.at-top";
    const compute = () => {
      const cr = center.getBoundingClientRect().right;
      let cover = 0;
      for (const el of center.querySelectorAll(sel)) {
        const b = el.getBoundingClientRect();
        if (b.width < 2) continue;         // dock closed / zero-width
        if (cr - b.right > 10) continue;   // not anchored to the bar's right end
        cover = Math.max(cover, cr - b.left);
      }
      center.style.setProperty("--dock-cover", `${Math.round(cover)}px`);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(center);
    center.querySelectorAll(sel).forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [dockSig]);

  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const { project, chain } = breadcrumbFor(live.workers, ui.selectedId, ui.composer.cwd);

  const toggleMenu = () => {
    if (ui.openPopover === "head-menu") ui.closeAllPops();
    else ui.openPop("head-menu");
  };

  return (
    <div className="head" ref={headRef}>
      <button className="head-toggle sb-iconbtn" onClick={() => ui.setSideCollapsed(false)} title="Show sidebar">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <line x1="6" y1="3" x2="6" y2="13" />
        </svg>
      </button>
      <div className="crumb">
        <span className="scope">{project}</span>
        {chain.length === 0 && (
          <>
            <span className="sep">/</span>
            <span className="cur">new orchestrator</span>
          </>
        )}
        {chain.map((seg, i) => {
          const isLast = i === chain.length - 1;
          return (
            <Fragment key={seg.id}>
              <span className="sep">/</span>
              {!isLast && (
                <button className="crumb-link" onClick={() => ui.setSelectedId(seg.id)}>
                  <AgentName worker={seg.worker} />
                </button>
              )}
              {isLast && (renaming && selected ? (
                <RenameInput
                  currentName={nameOf(selected)}
                  onSave={(name) => { setRenaming(false); live.renameAgent(seg.id, name); }}
                  onCancel={() => setRenaming(false)}
                  workerId={seg.id}
                />
              ) : (
                <span className="cur"><AgentName worker={seg.worker} /></span>
              ))}
            </Fragment>
          );
        })}
        {selected && (
          <span className="v-wrap">
            <button className="v" data-popover-trigger="head-menu" onClick={toggleMenu} aria-label="Agent menu">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m4 6 4 4 4-4" />
              </svg>
            </button>
            <HeaderAgentMenu live={live} onRename={() => { setRenaming(true); if (ui.selectedId) api.renameIntent(ui.selectedId, true).catch(() => {}); }} />
          </span>
        )}
      </div>
      <div className="right">
        <TerminalToggleButton />
        <FollowButton />
        <SplitEmptyButton />
        <PanePresets />
      </div>
    </div>
  );
}
