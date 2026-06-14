import { Fragment, useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { breadcrumbFor } from "../../../lib/breadcrumb.js";
import { nameOf } from "../../../lib/agentName.js";
import { RenameInput } from "../../../components/RenameInput.jsx";
import { HeaderAgentMenu } from "../popovers/HeaderAgentMenu.jsx";
import { PanePresets } from "./PanePresets.jsx";

export function CenterHeader({ live }) {
  const ui = useUi();
  // Header-local rename (breadcrumb inline edit) — deliberately NOT the shared
  // ui.renamingId, which the sidebar row watches; sharing it would mount two
  // inputs fighting for focus.
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setRenaming(false); }, [ui.selectedId]);

  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const { project, chain } = breadcrumbFor(live.workers, ui.selectedId, ui.composer.cwd);

  const toggleMenu = () => {
    if (ui.openPopover === "head-menu") ui.closeAllPops();
    else ui.openPop("head-menu");
  };

  return (
    <div className="head">
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
                  {seg.label}
                </button>
              )}
              {isLast && (renaming && selected ? (
                <RenameInput
                  currentName={nameOf(selected)}
                  onSave={(name) => { setRenaming(false); live.renameAgent(seg.id, name); }}
                  onCancel={() => setRenaming(false)}
                />
              ) : (
                <span className="cur">{seg.label}</span>
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
            <HeaderAgentMenu live={live} onRename={() => setRenaming(true)} />
          </span>
        )}
      </div>
      <div className="right">
        <PanePresets />
      </div>
    </div>
  );
}
